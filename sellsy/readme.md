# 🚀 Sellsy Webhook Listener

**Microservice Node.js** ultra-rapide construit avec **Fastify**, **BullMQ** et **Redis**, destiné à **écouter les webhooks Sellsy** et **créer automatiquement une facture** lorsqu’un **devis passe en “accepté”**.

Le projet illustre une architecture **performante**, **résiliente** et **scalable**, conçue pour traiter des événements Sellsy en quelques millisecondes sans jamais perdre de données.

---

## 🧭 Objectif

Sellsy impose un temps de réponse très court pour ses webhooks :  
ce service vise à **répondre en moins de 10 ms** tout en garantissant un **traitement fiable et asynchrone**.

L’idée :
1. Le webhook Sellsy arrive (ex. `estimate.updated`).
2. Le serveur **vérifie la signature HMAC**.
3. Si valide, l’événement est poussé dans Redis (BullMQ queue).
4. Fastify renvoie **200 OK** instantanément à Sellsy.
5. Un **worker** lit la file et traite les événements en tâche de fond :
   - Si le devis est passé en `accepted` → il appelle **l’API Sellsy V2** pour **générer la facture correspondante**.
   - Sinon → le job est consommé puis supprimé (noop).

Résultat :  
✅ Réception fiable et rapide  
✅ Traitement asynchrone sécurisé  
✅ Aucun risque de bannissement Sellsy  

---

## ⚙️ Stack technique

| Composant | Rôle |
|------------|------|
| **Fastify** | Serveur HTTP léger et rapide |
| **BullMQ** | Gestionnaire de file (jobs) |
| **Redis** | Backend de persistance pour BullMQ |
| **Sellsy API V2** | Création de factures via jeton personnel |
| **Docker Compose** | Orchestration locale et reproductible |

---

## 🧩 Architecture

+----------------------+
| Sellsy Webhooks |
+----------+-----------+
|
v
+--------------------------+
| signed_server.js |
| - Vérifie signature HMAC |
| - Push dans Redis Queue |
| - Répond 200 OK |
+-----------+--------------+
|
v
+--------------------------+
| BullMQ Queue (Redis) |
+-----------+--------------+
|
v
+--------------------------+
| worker.js |
| - Lit la file |
| - Vérifie statut devis |
| - Crée facture via API |
| - Log / Retry / Ack |
+--------------------------+

---

## ⚙️ Configuration

Créer un fichier `.env` :

```bash
# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Sellsy API
SELLSY_BASE_URL=https://api.sellsy.com/v2
SELLSY_PERSONAL_TOKEN=your_personal_access_token_here

# Webhook signature (Sellsy)
SELLSY_WEBHOOK_SECRET=your_webhook_secret_here
```
🧰 Installation locale

1️⃣ Prérequis
Docker
Un compte Sellsy avec un accès personnel API V2 FAQ(https://help.sellsy.com/fr/articles/5876615-types-d-acces-api)


2️⃣ Cloner le projet
```bash
git clone https://github.com/nseaSeb/wh_sellsy.git
cd wh_sellsy/sellsy
````

3️⃣ Lancer la stack
```bash
docker compose up --build
```


Cela démarre :
un serveur Fastify sur le port 3000
un conteneur Redis
un worker BullMQ connecté à la file

🔒 Sécurité
Le serveur signed vérifie la signature HMAC des webhooks Sellsy avant tout traitement.
Aucun événement non signé n’entre dans Redis.
Le token Sellsy est stocké dans .env et jamais loggé.
Même en cas d’erreur, le listener répond 200 OK pour éviter d’être blacklisté.


⚡ Fonctionnement du Worker
Récupère le job depuis la queue.
Vérifie si l’événement correspond à un devis accepted.
Si oui :
Récupère les détails du devis (GET /v2/estimates/{id})
Crée la facture (POST /v2/invoices) via l’API Sellsy
Log le résultat (succès ou erreur)
Sinon : consomme le job et passe au suivant.

Gestion intégrée :
Retry automatique sur erreurs transitoires
Logs clairs des statuts de jobs (probablement perfectible via une sortie fichier ou autre ?)


🧠 Points clés d’architecture
Décorrélation totale entre réception et traitement.
Performance : Fastify + Redis garantissent un <10 ms de réponse.
Sécurité : signature HMAC obligatoire, token personnel isolé.



📜 Licence
MIT — librement réutilisable et améliorable.
