import Fastify from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";

// --- Configuration Redis ---
const redis = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: 6379,
  // tu peux ajouter password ou TLS selon ton infra
});

const webhookQueue = new Queue("sellsy-webhooks", { connection: redis });

// --- Fastify setup ---
const app = Fastify({
  logger: true, // utile pour surveiller la perf et les erreurs
  bodyLimit: 1048576, // 1 Mo, ajustable selon taille events Sellsy
});

// --- Endpoint Webhook ---
app.post("/webhook/sellsy", async (req, reply) => {
  try {
    const event = req.body;

    // ⚠️ Optionnel : validation de la signature Sellsy ici avant d’accepter
    // if (!isValidSellsySignature(req.headers, req.body)) return reply.code(401).send({ ok: false })

    // 🔥 Push dans Redis le plus vite possible
    await webhookQueue.add("event", event, { removeOnComplete: true });

    // ✅ Répond immédiatement pour rester dans la file prioritaire Sellsy
    reply.code(200).send({ ok: true });
  } catch (err) {
    app.log.error(err);
    // Toujours répondre 200 à Sellsy pour éviter les replays
    reply.code(200).send({ ok: true });
  }
});

// --- Démarrage ---
const start = async () => {
  try {
    await app.listen({ port: 3000, host: "0.0.0.0" });
    console.log("🚀 Webhook listener Sellsy en écoute sur le port 3000");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
