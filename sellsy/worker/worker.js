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

// Plugin de connexion API Sellsy
async function apiConnection(fastify, options) {
  const { clientId, clientSecret, maxRetries = 3 } = options;

  let token = null;
  let tokenExpiry = null;
  let refreshPromise = null;

  async function refreshToken() {
    try {
      fastify.log.info("Refreshing Sellsy API token...");

      const response = await fetch(
        "https://login.sellsy.com/oauth2/access-tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      token = data.access_token;
      tokenExpiry = Date.now() + data.expires_in * 1000;

      fastify.log.info("Sellsy token refreshed successfully");
      return token;
    } catch (error) {
      fastify.log.error("Error refreshing Sellsy token:", error);
      throw error;
    }
  }

  async function getToken(forceRefresh = false) {
    const isExpired = !tokenExpiry || Date.now() >= tokenExpiry - 60000;

    if (!token || isExpired || forceRefresh) {
      if (!refreshPromise) {
        refreshPromise = refreshToken().finally(() => {
          refreshPromise = null;
        });
      }
      return await refreshPromise;
    }

    return token;
  }

  async function makeApiCall(url, options = {}) {
    let attempt = 0;
    let forceRefresh = false;

    while (attempt < maxRetries) {
      try {
        const token = await getToken(forceRefresh);

        const apiOptions = {
          ...options,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...options.headers,
          },
        };

        const response = await fetch(url, apiOptions);

        if (response.status === 401) {
          fastify.log.warn("Received 401, forcing token refresh...");
          forceRefresh = true;
          attempt++;
          continue;
        }

        if (!response.ok) {
          throw new Error(
            `Sellsy API error: ${response.status} ${response.statusText}`,
          );
        }

        return await response.json();
      } catch (error) {
        attempt++;

        if (attempt >= maxRetries) {
          fastify.log.error(
            `Sellsy API call failed after ${maxRetries} attempts:`,
            error,
          );
          throw error;
        }

        fastify.log.warn(
          `Sellsy API call attempt ${attempt} failed, retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  fastify.decorate("sellsyApi", {
    getToken,
    makeApiCall,
    forceRefresh: () => getToken(true),
  });

  // Initialisation
  fastify.addHook("onReady", async () => {
    try {
      await getToken();
      fastify.log.info(
        "Sellsy API connection initialized for invoice creation",
      );
    } catch (error) {
      fastify.log.error("Failed to initialize Sellsy API connection:", error);
    }
  });
}

// --- Traitement spécifique pour les devis acceptés ---
class InvoiceCreator {
  constructor(fastify) {
    this.fastify = fastify;
  }

  async processEvent(event) {
    const { eventType, relatedtype, relatedobject } = event;

    this.fastify.log.info(
      `Processing webhook: ${relatedtype}.${eventType} for object ${relatedobject?.id}`,
    );

    if (relatedtype === "estimate" && eventType === "docslog") {
      await this.handleEstimateModification(relatedobject);
    } else {
      this.fastify.log.info(`ℹ️  Event ${relatedtype}.${eventType} ignored`);
    }
  }

  async handleEstimateModification(estimate) {
    const estimateId = estimate.id;

    try {
      if (this.isEstimateAccepted(estimate)) {
        this.fastify.log.info(
          `📄 Estimate ${estimateId} accepted, creating invoice...`,
        );

        // Récupérer les détails complets du devis (avec les items)
        const fullEstimate = await this.getEstimateDetails(estimateId);

        // Créer la facture
        const invoice = await this.createInvoiceFromEstimate(
          fullEstimate,
          estimate,
        );

        this.fastify.log.info(
          `✅ Invoice ${invoice.id} created successfully from estimate ${estimateId}`,
        );

        await this.linkInvoiceToEstimate(estimateId, invoice.id);
      } else {
        this.fastify.log.info(
          `📄 Estimate ${estimateId} status: ${estimate.status} - no action needed`,
        );
      }
    } catch (error) {
      this.fastify.log.error(
        `❌ Failed to process estimate ${estimateId}:`,
        error,
      );
      throw error;
    }
  }

  async getEstimateDetails(estimateId) {
    this.fastify.log.info(
      `Fetching full details for estimate ${estimateId}...`,
    );

    // Debug temporaire
    this.fastify.log.info(`sellsyApi available: ${!!this.fastify.sellsyApi}`);
    this.fastify.log.info(
      `sellsyApi keys: ${Object.keys(this.fastify.sellsyApi || {})}`,
    );

    const estimate = await this.fastify.sellsyApi.makeApiCall(
      `https://api.sellsy.com/v2/estimates/${estimateId}`,
    );

    return estimate;
  }

  isEstimateAccepted(estimate) {
    const acceptedStatuses = ["accepted", "won", "signed"];
    return acceptedStatuses.includes(estimate.status);
  }

  async createInvoiceFromEstimate(fullEstimate, webhookEstimate) {
    this.fastify.log.info(
      `Creating invoice from estimate ${fullEstimate.id}...`,
    );

    // Récupérer l'ID du client depuis le webhook
    const clientId = webhookEstimate.related?.find(
      (r) => r.type === "company",
    )?.id;

    if (!clientId) {
      throw new Error("No client found in estimate");
    }

    const invoiceData = {
      third: { id: clientId },
      currency: webhookEstimate.currency || "EUR",
      subject: webhookEstimate.subject || "Facture",
      dated: new Date().toISOString().split("T")[0],
      items: this.transformEstimateItemsToInvoiceItems(
        fullEstimate.items || [],
      ),
    };

    // Ajouter conditionnellement les champs optionnels
    if (webhookEstimate.note) {
      invoiceData.note = webhookEstimate.note;
    }

    this.fastify.log.info(
      "Invoice payload:",
      JSON.stringify(invoiceData, null, 2),
    );

    const invoice = await this.fastify.sellsyApi.makeApiCall(
      "https://api.sellsy.com/v2/invoices",
      {
        method: "POST",
        body: JSON.stringify(invoiceData),
      },
    );

    return invoice;
  }

  transformEstimateItemsToInvoiceItems(estimateItems) {
    if (!Array.isArray(estimateItems) || estimateItems.length === 0) {
      this.fastify.log.warn("No items found in estimate");
      return [];
    }

    return estimateItems.map((item) => {
      const invoiceItem = {
        description: item.description || "",
        quantity: item.quantity || 1,
        unitAmount: item.unitAmount || 0,
      };

      if (item.product?.id) {
        invoiceItem.product = { id: item.product.id };
      }

      if (item.tax1?.id) {
        invoiceItem.tax1 = { id: item.tax1.id };
      }

      if (item.tax2?.id) {
        invoiceItem.tax2 = { id: item.tax2.id };
      }

      return invoiceItem;
    });
  }

  async linkInvoiceToEstimate(estimateId, invoiceId) {
    try {
      this.fastify.log.info(
        `🔗 Linking invoice ${invoiceId} to estimate ${estimateId}`,
      );

      await this.fastify.sellsyApi.makeApiCall(
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
      this.fastify.log.warn(
        `Could not link invoice to estimate: ${error.message}`,
      );
    }
  }
}

// --- Worker BullMQ ---

// --- Worker BullMQ ---

async function startWorker() {
  // 1. Enregistrer le plugin AVANT de créer InvoiceCreator
  await app.register(apiConnection, {
    clientId: process.env.SELLSY_CLIENT_ID,
    clientSecret: process.env.SELLSY_CLIENT_SECRET,
    maxRetries: 3,
  });

  // 2. Attendre que Fastify soit prêt (tous les hooks onReady exécutés)
  await app.ready();

  // 3. MAINTENANT créer InvoiceCreator (sellsyApi existe)
  const invoiceCreator = new InvoiceCreator(app);

  const worker = new Worker(
    "sellsy-webhooks",
    async (job) => {
      console.log(`🎯 Processing job ${job.id}: ${job.name}`);
      console.log("Job data:", JSON.stringify(job.data, null, 2));

      try {
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
    const token = await app.sellsyApi.getToken();

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
    // 1. D'ABORD : enregistrer le plugin et créer le worker
    await startWorker();

    // 2. ENSUITE : démarrer le serveur HTTP
    await app.listen({ port: 3001, host: "0.0.0.0" });

    console.log("🚀 Sellsy Invoice Creator prêt sur le port 3001");
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
