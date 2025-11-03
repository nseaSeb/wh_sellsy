import Fastify from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import crypto from "crypto";

// --- Redis setup ---
const redis = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: 6379,
});

const webhookQueue = new Queue("sellsy-webhooks", { connection: redis });

// --- Fastify setup ---
const app = Fastify({ logger: true });

// Parser spécial pour garder le raw body
app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body, done) => {
    try {
      req.rawBody = body;
      const json = JSON.parse(body.toString());
      done(null, json);
    } catch (err) {
      done(err, undefined);
    }
  },
);

// Vérification de la signature Sellsy
function isValidSellsySignature(headers, rawBody) {
  const signKey = process.env.SELLSY_SIGN_KEY;
  const signature = headers["x-webhook-signature"];
  if (!signKey || !signature) return false;

  const toSign = signKey + rawBody.toString("utf8");
  const computed = crypto.createHash("sha1").update(toSign).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "utf8"),
      Buffer.from(computed, "utf8"),
    );
  } catch {
    return false;
  }
}

// --- Endpoint Webhook ---
app.post("/webhook/sellsy", async (req, reply) => {
  try {
    if (!isValidSellsySignature(req.headers, req.rawBody)) {
      app.log.warn("❌ Signature Sellsy invalide");
      return reply.code(401).send({ ok: false });
    }

    await webhookQueue.add("event", req.body, { removeOnComplete: true });
    reply.code(200).send({ ok: true });
  } catch (err) {
    app.log.error(err);
    reply.code(200).send({ ok: true }); // Toujours 200 pour éviter les replays
  }
});

// --- Démarrage ---
const start = async () => {
  try {
    await app.listen({ port: 3000, host: "0.0.0.0" });
    console.log("🚀 Webhook Sellsy prêt sur le port 3000");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
