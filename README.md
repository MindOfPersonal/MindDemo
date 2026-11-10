
---

```markdown
# MindDemo 🚀

**MindDemo** is een tijdelijk demo-hosting platform ontwikkeld voor **MindDevelopment**. Het stelt beheerders in staat om demo-omgevingen (Docker-containers) te beheren, agents te registreren voor deployments, en publieke demo-pagina's te serveren via een reverse proxy.

> **Status**: Actief in ontwikkeling · Hoofdbranch: `master`

---

## ✨ Features

-   **Admin Dashboard**: Beheer demo's, servers, agents, sessies en logs via een EJS-gebaseerde UI.
-   **Docker Orchestratie**: Start, stop en monitor demo-containers automatisch via `dockerode`.
-   **Agent Systeem**: Externe agents (via WebSocket/HTTP) kunnen demo's deployen en beheren op afzonderlijke servers.
-   **Reverse Proxy**: Dynamische routering naar actieve demo-containers op basis van subdomeinen/paden (`http-proxy`).
-   **Beveiliging**: Helmet, CORS, Rate Limiting, CSRF-bescherming, Bcrypt wachtwoorden, sessie-beheer.
-   **Database**: MySQL/MariaDB met gestructureerde schema's (`database/schema.js`) en models.
-   **Real-time Logs**: WebSocket-ondersteuning (`ws`) voor live logging naar admins/agents.
-   **Discord Integratie**: Optionele notificaties/logging via Discord Webhooks/Bot.
-   **Cleanup Worker**: Automatisch opruimen van verlopen demo-sessies en containers.

---

## 🛠 Tech Stack

| Categorie | Technologieën |
| :--- | :--- |
| **Runtime** | Node.js (ES Modules) |
| **Framework** | Express.js |
| **Database** | MySQL / MariaDB (`mysql2`) |
| **Containerization** | Docker (`dockerode`) |
| **Templating** | EJS |
| **Auth & Security** | `bcrypt`, `express-session`, `helmet`, `csurf`, `express-rate-limit` |
| **Proxy & WS** | `http-proxy`, `ws` |
| **Utils** | `dotenv`, `uuid`, `multer`, `unzipper`, `compression` |
| **Dev Tools** | `nodemon`, Custom Linter (`scripts/lint.js`), Node.js Native Test Runner |

---

## 📁 Project Structuur

```text
MindDemo/
├── .env.example           # Voorbeeld configuratie
├── .gitignore
├── package.json
├── database/
│   └── schema.js          # Database initialisatie script
├── public/                # Statische assets (CSS, JS, Images)
├── scripts/
│   └── lint.js            # Custom lint script
├── src/
│   ├── app.js             # Entry point (Express setup, middleware, routes)
│   ├── config/            # Configuratie & DB connectie
│   ├── controllers/       # Request handlers (Admin, Agent, Demo, Server, Session)
│   ├── middleware/        # Auth, RateLimit, CSRF, AgentAuth
│   ├── models/            # Data models (Admin, Agent, Demo, Server, Log, Session, Metric)
│   ├── routes/            # Route definities (Admin, Agent API, Public Demo, Proxy)
│   ├── services/          # Business logic (Docker, AgentHub, Discord, Cleanup, Runtime, Zip)
│   ├── utils/             # Helpers, Logger, ZipHandler
│   └── views/             # EJS Templates (Admin, Demo, Landing, Errors)
└── test/                  # Unit/Integration tests (Node.js --test)
```

---

## ⚙️ Installatie & Configuratie

### 1. Vereisten
-   **Node.js** >= 18.x
-   **Docker Engine** actief en bereikbaar (voor container beheer)
-   **MySQL/MariaDB** database server

### 2. Klonen & Installeren
```bash
git clone https://github.com/MindOfPersonal/MindDemo.git
cd MindDemo
npm install
```

### 3. Omgevingsvariabelen
Kopieer het voorbeeldbestand en vul je gegevens in:
```bash
cp .env.example .env
```

**Belangrijke variabelen (voorbeeld):**
```ini
# App
NODE_ENV=development
PORT=3000
SESSION_SECRET=jouw_zeer_lange_geheime_sleutel_hier

# Database (MySQL/MariaDB)
DB_HOST=localhost
DB_PORT=3306
DB_USER=minddemo_user
DB_PASSWORD=wachtwoord
DB_NAME=minddemo_db

# Docker
DOCKER_HOST=unix:///var/run/docker.sock  # Of tcp://host:2375 voor remote

# Discord (Optioneel)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...

# Proxy / Public URL
PUBLIC_DOMAIN=demo.minddevelopment.nl
```

### 4. Database Initialisatie
Voer het setup-commando uit om tabellen aan te maken en een standaard admin gebruiker te registreren:
```bash
npm run setup
```
*Let op: Dit script draait `src/app.js --setup`. Controleer `src/app.js` of `database/schema.js` voor de exacte migraties.*

### 5. Starten
**Development (met auto-reload):**
```bash
npm run dev
```

**Productie:**
```bash
npm start
```

De applicatie draait standaard op `http://localhost:3000`.

---

## 🧪 Testen & Linten

```bash
# Voer tests uit (Node.js native test runner)
npm test

# Controleer code stijl (Custom script)
npm run lint
```

---

## 🐳 Docker Deployment (Host Machine)

Hoewel MindDemo *docker containers beheert*, draait de applicatie zelf meestal op de host of in een eigen container met toegang tot de Docker socket.

**Docker Compose voorbeeld (`docker-compose.yml`):**
```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock # Noodzakelijk voor dockerode
      - ./data/uploads:/app/public/uploads       # Persistentie uploads
    env_file:
      - .env
    restart: unless-stopped
    depends_on:
      - db

  db:
    image: mariadb:10.11
    environment:
      MYSQL_ROOT_PASSWORD: rootpass
      MYSQL_DATABASE: minddemo_db
      MYSQL_USER: minddemo_user
      MYSQL_PASSWORD: wachtwoord
    volumes:
      - db_data:/var/lib/mysql
    restart: unless-stopped

volumes:
  db_data:
```

---

## 🔐 Belangrijke Beveiligingsaspecten

1.  **Docker Socket**: De app vereist toegang tot `docker.sock`. Dit geeft **root-rechten** op de host. Zorg dat je dit begrijpt en beveilig (bijv. met rootless docker of een proxy zoals `tecnativa/docker-socket-proxy`).
2.  **Session Secret**: Gebruik een sterke, willekeurige string (min. 32 chars) in productie.
3.  **Reverse Proxy**: Zet MindDemo achter een reverse proxy (Nginx/Traefik/Caddy) voor SSL-terminatie (HTTPS) en extra beveiliging.
4.  **Rate Limiting**: Standaard ingeschakeld via `express-rate-limit`.
5.  **Helmet & CSRF**: Actief voor browser-routes.

---

## 🤝 Bijdragen

1.  Fork de repository.
2.  Maak een feature branch (`git checkout -b feature/nieuwe-functie`).
3.  Commit je wijzigingen (`git commit -m 'feat: nieuwe functionaliteit'`).
4.  Push naar de branch (`git push origin feature/nieuwe-functie`).
5.  Open een **Pull Request**.

**Code Stijl**: Voer `npm run lint` uit voor je commit.

---

## 📄 Licentie

Dit project is gelicenseerd onder de **MIT License** - zie het `LICENSE` bestand voor details (moet nog toegevoegd worden).

---

## 👤 Auteur & Organisatie

**MindDevelopment** / **MindOfPersonal**
-   GitHub: [@MindOfPersonal](https://github.com/MindOfPersonal)
-   Repository: [MindDemo](https://github.com/MindOfPersonal/MindDemo)

---

*Voor vragen of issues, open een [GitHub Issue](https://github.com/MindOfPersonal/MindDemo/issues).*
```

---
