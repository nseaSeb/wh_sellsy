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
      this.logger.info("🔄 Rafraîchissement du token Sellsy...");

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

      this.logger.info("✅ Token Sellsy rafraîchi avec succès");
      return this.token;
    } catch (error) {
      this.logger.error("❌ Erreur lors du rafraîchissement du token:", error);
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

        if (options.body) {
          apiOptions.body = options.body;
        }

        this.logger.debug(`🌐 API Call: ${url}`);

        const response = await fetch(url, apiOptions);

        // 🔍 LOG de la réponse
        const statusEmoji = response.ok ? "✅" : "❌";
        this.logger.info(
          `${statusEmoji} Response: ${response.status} ${response.statusText}`,
        );

        if (response.status === 401) {
          this.logger.warn("🔑 Reçu 401, rafraîchissement forcé du token...");
          forceRefresh = true;
          attempt++;
          continue;
        }

        if (!response.ok) {
          let errorBody = "";
          try {
            errorBody = await response.text();
            this.logger.error(`📝 Détails de l'erreur: ${errorBody}`);
          } catch (e) {
            errorBody = "Impossible de lire le corps de l'erreur";
          }

          throw new Error(
            `Sellsy API error: ${response.status} ${response.statusText} - ${errorBody}`,
          );
        }

        const data = await response.json();
        this.logger.debug("📨 Données de réponse reçues");
        return data;
      } catch (error) {
        attempt++;

        if (attempt >= this.maxRetries) {
          this.logger.error(`💥 Échec après ${this.maxRetries} tentatives`);
          throw error;
        }

        this.logger.warn(
          `🔄 Tentative ${attempt} échouée, nouvelle tentative...`,
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
    "delivery_address_id",
    "invoicing_address_id",
    "amounts",
    "related", // On retire related car on le reconstruit
    "rows", // On retire rows car on les transforme
    "status", // On retire le statut du devis
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
      `🔍 Traitement webhook: ${relatedtype}.${eventType} pour l'objet ${relatedobject?.id}`,
    );

    if (relatedtype === "estimate" && eventType === "docslog") {
      await this.handleEstimateModification(relatedobject);
    } else {
      this.logger.info(`ℹ️  Événement ${relatedtype}.${eventType} ignoré`);
    }
  }

  async handleEstimateModification(estimate) {
    const estimateId = estimate.id;

    try {
      if (this.isEstimateAccepted(estimate)) {
        this.logger.info(
          `📄 Devis ${estimateId} accepté, création de la facture...`,
        );

        // Récupérer les détails complets du devis
        const fullEstimate = await this.getEstimateDetails(estimateId);

        // Créer la facture
        const invoice = await this.createInvoiceFromEstimate(
          fullEstimate,
          estimate,
        );

        this.logger.info(
          `✅ Facture ${invoice.id} créée avec succès depuis le devis ${estimateId}`,
        );

      } else {
        this.logger.info(
          `📄 Devis ${estimateId} statut: ${estimate.status} - aucune action nécessaire`,
        );
      }
    } catch (error) {
      this.logger.error(
        `❌ Échec du traitement du devis ${estimateId}:`,
        error,
      );
      throw error;
    }
  }

  async getEstimateDetails(estimateId) {
    this.logger.info(`📥 Récupération des détails du devis ${estimateId}...`);

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
    this.logger.info(`🎯 Création facture depuis devis ${fullEstimate.id}...`);

    // Récupérer l'ID du client depuis le webhook
    const clientId = webhookEstimate.related?.find(
      (r) => r.type === "company",
    )?.id;

    if (!clientId) {
      throw new Error("❌ Client introuvable dans le devis");
    }

    // Construction de la facture selon la doc Sellsy v2
    const invoiceData = {
      subject: webhookEstimate.subject || `Facture - ${webhookEstimate.number}`,
      currency: webhookEstimate.currency || "EUR",
      parent: { type: "estimate", id: fullEstimate.id },
      related: [
        {
          id: clientId,
          type: "company",
        },
      ],
      rows: this.transformEstimateItemsToInvoiceRows(fullEstimate.rows || []),
    };

    // Nettoyage des données
    const cleanedWebhookData = cleanDataForApi(webhookEstimate);

    // Fusion
    const finalInvoiceData = {
      ...cleanedWebhookData,
      ...invoiceData,
    };

    // 🔍 LOG de la payload
    this.logger.info("📦 Payload envoyé à l'API Sellsy:");
    console.log("=== PAYLOAD COMPLET ===");
    console.log(JSON.stringify(finalInvoiceData, null, 2));
    console.log("=======================");

    try {
      this.logger.info("🚀 Envoi vers API Sellsy...");

      const invoice = await this.sellsyApi.makeApiCall(
        "https://api.sellsy.com/v2/invoices",
        {
          method: "POST",
          body: JSON.stringify(finalInvoiceData),
        },
      );

      this.logger.info(`✅ Facture créée avec succès! ID: ${invoice.id}`);
      return invoice;
    } catch (error) {
      this.logger.error("❌ Erreur lors de la création de la facture");
      throw error;
    }
  }

  transformEstimateItemsToInvoiceRows(estimateRows) {
    if (!Array.isArray(estimateRows) || estimateRows.length === 0) {
      this.logger.warn("⚠️ Aucune ligne trouvée dans le devis");
      return [];
    }

    this.logger.info(`📋 Transformation de ${estimateRows.length} lignes...`);

    return estimateRows.map((row, index) => {
      const invoiceRow = {
        type: "single", // Champ requis selon la doc
        description: row.description || `Ligne ${index + 1}`,
        quantity: row.quantity?.toString() || "1",
        unit_amount: (row.unitAmount || row.unit_amount || "0").toString(),
      };

      // Gérer la taxe
      if (row.tax?.id) {
        invoiceRow.tax_id = row.tax.id;
      } else if (row.tax1?.id) {
        invoiceRow.tax_id = row.tax1.id;
      }

      // Gérer le produit
      if (row.product?.id) {
        invoiceRow.reference =
          row.product.reference || `prod_${row.product.id}`;
      }

      this.logger.debug(`➡️ Ligne ${index + 1}: ${invoiceRow.description}`);
      return invoiceRow;
    });
  }


// --- Worker BullMQ ---
async function startWorker() {
  // Initialiser l'API Sellsy pour le worker
  await sellsyApi.getToken();
  console.log("✅ API Sellsy initialisée pour le worker");

  const worker = new Worker(
    "sellsy-webhooks",
    async (job) => {
      console.log(`🎯 Traitement job ${job.id}: ${job.name}`);

      try {
        const invoiceCreator = new InvoiceCreator(sellsyApi, app.log);

        await invoiceCreator.processEvent(job.data);

        return {
          success: true,
          jobId: job.id,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        console.error(`❌ Erreur dans le job ${job.id}:`, error);
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
    app.log.info(`✅ Job ${job.id} terminé avec succès`);
  });

  worker.on("failed", (job, err) => {
    app.log.error(
      {
        jobId: job?.id,
        error: err.message,
        stack: err.stack,
        jobData: job?.data,
      },
      `❌ Job ${job?.id} échoué`,
    );
  });

  worker.on("error", (err) => {
    app.log.error("🔥 Erreur worker:", err);
  });

  app.log.info(
    "👷 Sellsy Invoice Creator démarré - En attente des devis acceptés...",
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
  app.log.info("Arrêt gracieux...");
  await app.close();
  process.exit(0);
});

start();
