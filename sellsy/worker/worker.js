// consumer.js
import { Worker } from "bullmq";
import IORedis from "ioredis";
import Fastify from "fastify";

// --- Redis setup ---
const redis = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null,
});

// --- Fastify pour la gestion API ---
const app = Fastify({ logger: true });

// --- Client API Sellsy ---
class SellsyApiClient {
  constructor(clientId, clientSecret, logger, maxRetries = 3) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.token = null;
    this.tokenExpiry = null;
    this.refreshPromise = null;
  }

  async refreshToken() {
    try {
      this.logger.info("Refreshing Sellsy API token...");

      const response = await fetch(
        "https://login.sellsy.com/oauth2/access-tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            grant_type: "client_credentials",
            client_id: this.clientId,
            client_secret: this.clientSecret,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      this.token = data.access_token;
      this.tokenExpiry = Date.now() + data.expires_in * 1000;

      this.logger.info("Sellsy token refreshed successfully");
      return this.token;
    } catch (error) {
      this.logger.error("Error refreshing Sellsy token:", error);
      throw error;
    }
  }

  async getToken(forceRefresh = false) {
    const isExpired =
      !this.tokenExpiry || Date.now() >= this.tokenExpiry - 60000;

    if (!this.token || isExpired || forceRefresh) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshToken().finally(() => {
          this.refreshPromise = null;
        });
      }
      return await this.refreshPromise;
    }

    return this.token;
  }

  async makeApiCall(url, options = {}) {
    let attempt = 0;
    let forceRefresh = false;

    while (attempt < this.maxRetries) {
      try {
        const token = await this.getToken(forceRefresh);

        const apiOptions = {
          ...options,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...options.headers,
          },
        };

        // Ajouter le body si présent
        if (options.body) {
          apiOptions.body = options.body;
        }

        this.logger.debug(`Making API call to: ${url}`);
        if (options.body) {
          this.logger.debug(`Request body: ${options.body}`);
        }

        const response = await fetch(url, apiOptions);

        if (response.status === 401) {
          this.logger.warn("Received 401, forcing token refresh...");
          forceRefresh = true;
          attempt++;
          continue;
        }

        if (!response.ok) {
          // Récupérer les détails de l'erreur
          let errorBody = "";
          try {
            errorBody = await response.text();
            this.logger.error(`API Error ${response.status}: ${errorBody}`);
          } catch (e) {
            errorBody = "Could not read error body";
          }

          throw new Error(
            `Sellsy API error: ${response.status} ${response.statusText} - ${errorBody}`,
          );
        }

        return await response.json();
      } catch (error) {
        attempt++;

        if (attempt >= this.maxRetries) {
          this.logger.error(
            `Sellsy API call failed after ${this.maxRetries} attempts:`,
            error,
          );
          throw error;
        }

        this.logger.warn(
          `Sellsy API call attempt ${attempt} failed, retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
}

// Créer l'instance du client API pour le worker
const sellsyApi = new SellsyApiClient(
  process.env.SELLSY_CLIENT_ID,
  process.env.SELLSY_CLIENT_SECRET,
  app.log,
  3,
);

// Fonction utilitaire pour nettoyer les données avant envoi API
function cleanDataForApi(data, propertiesToRemove = []) {
  if (!data || typeof data !== "object") return data;

  const defaultPropertiesToRemove = [
    "id",
    "created",
    "fiscal_year_id",
    "number",
    "public_link",
    "pdf_link",
    "owner",
    "date",
    "amounts",
    "related",
  ];

  const allPropertiesToRemove = [
    ...defaultPropertiesToRemove,
    ...propertiesToRemove,
  ];

  return Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        !allPropertiesToRemove.includes(key),
    ),
  );
}

// --- Traitement spécifique pour les devis acceptés ---
class InvoiceCreator {
  constructor(sellsyApi, logger) {
    this.sellsyApi = sellsyApi;
    this.logger = logger;
  }

  async processEvent(event) {
    const { eventType, relatedtype, relatedobject } = event;

    this.logger.info(
      `Processing webhook: ${relatedtype}.${eventType} for object ${relatedobject?.id}`,
    );

    if (relatedtype === "estimate" && eventType === "docslog") {
      await this.handleEstimateModification(relatedobject);
    } else {
      this.logger.info(`ℹ️  Event ${relatedtype}.${eventType} ignored`);
    }
  }

  async handleEstimateModification(estimate) {
    const estimateId = estimate.id;

    try {
      if (this.isEstimateAccepted(estimate)) {
        this.logger.info(
          `📄 Estimate ${estimateId} accepted, creating invoice...`,
        );

        // Récupérer les détails complets du devis (avec les items)
        const fullEstimate = await this.getEstimateDetails(estimateId);

        // Créer la facture
        const invoice = await this.createInvoiceFromEstimate(
          fullEstimate,
          estimate,
        );

        this.logger.info(
          `✅ Invoice ${invoice.id} created successfully from estimate ${estimateId}`,
        );

        await this.linkInvoiceToEstimate(estimateId, invoice.id);
      } else {
        this.logger.info(
          `📄 Estimate ${estimateId} status: ${estimate.status} - no action needed`,
        );
      }
    } catch (error) {
      this.logger.error(`❌ Failed to process estimate ${estimateId}:`, error);
      throw error;
    }
  }

  async getEstimateDetails(estimateId) {
    this.logger.info(`Fetching full details for estimate ${estimateId}...`);

    const estimate = await this.sellsyApi.makeApiCall(
      `https://api.sellsy.com/v2/estimates/${estimateId}`,
    );

    return estimate;
  }

  isEstimateAccepted(estimate) {
    const acceptedStatuses = ["accepted", "won", "signed"];
    return acceptedStatuses.includes(estimate.status);
  }

  async createInvoiceFromEstimate(fullEstimate, webhookEstimate) {
    this.logger.info(`Creating invoice from estimate ${fullEstimate.id}...`);

    // Récupérer l'ID du client depuis le webhook
    const clientId = webhookEstimate.related?.find(
      (r) => r.type === "company",
    )?.id;

    if (!clientId) {
      throw new Error("No client found in estimate");
    }

    // Base de la facture
    const invoiceData = {
      related: { id: clientId, type: "company" },
      currency: webhookEstimate.currency || "EUR",
      subject: webhookEstimate.subject || "Facture",
      rows: this.transformEstimateItemsToInvoiceRows(fullEstimate.rows || []), // "rows" au lieu de "items"
    };

    // Nettoyer et ajouter les champs optionnels du webhook
    const cleanedWebhookData = cleanDataForApi(webhookEstimate);

    // Fusionner les données nettoyées
    const finalInvoiceData = {
      ...cleanedWebhookData,
      ...invoiceData, // Override avec nos données spécifiques
    };

    this.logger.info(
      "Invoice payload:",
      JSON.stringify(finalInvoiceData, null, 2),
    );

    const invoice = await this.sellsyApi.makeApiCall(
      "https://api.sellsy.com/v2/invoices",
      {
        method: "POST",
        body: JSON.stringify(finalInvoiceData),
      },
    );

    return invoice;
  }
  transformEstimateItemsToInvoiceRows(estimateRows) {
    if (!Array.isArray(estimateRows) || estimateRows.length === 0) {
      this.logger.warn("No rows found in estimate");
      return [];
    }

    return estimateRows.map((row) => {
      const invoiceRow = {
        description: row.description || "",
        quantity: row.quantity || 1,
        unitAmount: row.unitAmount || 0,
      };

      if (row.product?.id) {
        invoiceRow.product = { id: row.product.id };
      }

      if (row.tax?.id) {
        invoiceRow.tax = { id: row.tax.id };
      }

      return invoiceRow;
    });
  }

  async linkInvoiceToEstimate(estimateId, invoiceId) {
    try {
      this.logger.info(
        `🔗 Linking invoice ${invoiceId} to estimate ${estimateId}`,
      );

      await this.sellsyApi.makeApiCall(
        `https://api.sellsy.com/v2/estimates/${estimateId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            customFields: {
              generated_invoice: invoiceId,
            },
          }),
        },
      );
    } catch (error) {
      this.logger.warn(`Could not link invoice to estimate: ${error.message}`);
    }
  }
}

// --- Worker BullMQ ---
async function startWorker() {
  // Initialiser l'API Sellsy pour le worker
  await sellsyApi.getToken();
  console.log("✅ Sellsy API initialized for worker");

  const worker = new Worker(
    "sellsy-webhooks",
    async (job) => {
      console.log(`🎯 Processing job ${job.id}: ${job.name}`);

      try {
        const invoiceCreator = new InvoiceCreator(sellsyApi, app.log);

        await invoiceCreator.processEvent(job.data);

        return {
          success: true,
          jobId: job.id,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        console.error(`Error in job ${job.id}:`, error);
        throw error;
      }
    },
    {
      connection: redis,
      concurrency: 3,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  );

  worker.on("completed", (job) => {
    app.log.info(`✅ Job ${job.id} completed successfully`);
  });

  worker.on("failed", (job, err) => {
    app.log.error(
      {
        jobId: job?.id,
        error: err.message,
        stack: err.stack,
        jobData: job?.data,
      },
      `❌ Job ${job?.id} failed`,
    );
  });

  worker.on("error", (err) => {
    app.log.error("🔥 Worker error:", err);
  });

  app.log.info(
    "👷 Sellsy Invoice Creator started - Waiting for accepted estimates...",
  );
}

// --- Health check ---
app.get("/health", async (request, reply) => {
  try {
    const token = await sellsyApi.getToken();

    return {
      status: "healthy",
      service: "sellsy-invoice-creator",
      sellsy_api: "connected",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    app.log.error("Health check failed:", error);
    return reply.status(503).send({
      status: "unhealthy",
      error: error.message,
    });
  }
});

// --- Démarrage ---
const start = async () => {
  try {
    await app.listen({ port: 3001, host: "0.0.0.0" });
    console.log("🚀 Sellsy Invoice Creator prêt sur le port 3001");

    await startWorker();
    console.log("📋 En attente des devis acceptés...");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

process.on("SIGINT", async () => {
  app.log.info("Shutting down gracefully...");
  await app.close();
  process.exit(0);
});

start();
