# 🚀 Sellsy Webhook Listener

Un microservice Node.js ultra-rapide basé sur **Fastify** qui écoute les **webhooks Sellsy** et les pousse dans une **file Redis** (via BullMQ) pour traitement asynchrone.

L’objectif est de montrer, via un POC, une approche permettant de **répondre en moins de 10 ms** à Sellsy afin de rester dans la file prioritaire, tout en garantissant la **fiabilité et la persistance** des événements.

Les événements sont poussés dans Redis afin de permettre leur traitement asynchrone et sans perte, indépendamment de leur réception, ce qui permet une réponse ultra-rapide. Même en cas d’erreur, une réponse `200 OK` est renvoyée pour éviter d’être banni par Sellsy.

> ⚠️ Ce code n’est pas destiné à être utilisé tel quel en production, mais il illustre une approche robuste.
> Il est fortement recommandé de valider la signature du webhook Sellsy — possible **dans le worker**, afin de ne pas ralentir la réception du webhook mais moins sécure (nécessite d'envoyer la signature ou le header dans REDIS). Une version signed_server.js (non testé pour le moment) verifie la signature avant envoi vers Redis, plus sécure quelques ms pour la vérification ce qui est insignifiant.


---

## 🧩 Architecture


- **Fastify Listener** : reçoit les webhooks, répond 200 OK immédiatement.
- **Redis Queue (BullMQ)** : stockage temporaire rapide et persistant.
- **Workers** (à venir) : traitent les événements, les enregistrent ou déclenchent des actions.

---

## ⚙️ Installation locale (Docker Compose)

### 1. Prérequis
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Node.js ≥ 18 (si tu veux lancer le serveur sans Docker)

### 2. Cloner le projet

```bash
git clone https://github.com/<ton-org>/<ton-repo>.git
cd <ton-repo>
```

### 3. Lancer la stack

```bash
docker compose up --build
```

## 🧪 Tester le webhook et observer Redis

### 1. Envoyer un webhook de test

Dans un terminal, exécute :

```bash
curl -X POST http://localhost:3000/webhook/sellsy \
  -H "Content-Type: application/json" \
  -d '{"event":"invoice.paid","data":{"id":123,"customer":"Acme Corp"}}'
```

Dans un autre terminal il est possible d'observer Redis

```bash
docker exec -it redis-sellsy redis-cli MONITOR
```
