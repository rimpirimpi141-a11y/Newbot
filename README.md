# TaskWork Bot — Official Telegram Bot Backend

A production-ready functional clone of **TaskWork Bot** running purely on Node.js, **grammY**, SQLite, and the official Telegram Bot API via **Long Polling**.

There is **NO WEB APP, NO FRONTEND, NO SIMULATOR**. All user and administrative interactions occur directly through the official Telegram application.

---

## 🚀 Render Deployment Guide (Web Service)

This repository is pre-configured to be deployed directly to **Render** as a **Web Service**:

1. **Push to GitHub**:
   Push this repository to your GitHub account.

2. **Create a New Web Service on Render**:
   - Log in to [Render Dashboard](https://dashboard.render.com/).
   - Click **New +** -> **Web Service**.
   - Connect your GitHub repository.

3. **Configure Settings**:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start` (runs `node index.js`)
   - **Instance Type**: Free or Starter

4. **Add Environment Variables**:
   Under the **Environment** tab, add the following:
   - `BOT_TOKEN` : Your Telegram bot token from [@BotFather](https://t.me/BotFather)
   - `ADMIN_TELEGRAM_ID` : Your numeric Telegram ID (from [@userinfobot](https://t.me/userinfobot))
   - `SUPPORT_USERNAME` : Your support username (e.g. `TaskWorkSupport`)
   - `DB_PATH` : `data/taskwork.db`
   - `PORT` : `3000` (Render will automatically route traffic and check `http://.../` for 200 OK)

5. **Persistent Disk (Optional but Recommended on Render)**:
   - Add a Persistent Disk mounted at `/app/data` to preserve your SQLite database across service restarts.

---

## ⚙️ Environment Variables (`.env`)

```env
# Telegram Bot Token from @BotFather (Required)
BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"

# Permanent Super Admin Telegram Numeric ID (Required)
ADMIN_TELEGRAM_ID="1234567890"

# Support Telegram Username (without @)
SUPPORT_USERNAME="TaskWorkSupport"

# SQLite Database File Path
DB_PATH="data/taskwork.db"

# HTTP Server Port
PORT="3000"
```

---

## 🛠️ Local Development & Testing

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suite (32 integration tests)
npm test

# 3. Start the bot with long polling and health server
npm start
```

---

## 📦 Project Structure

```
taskwork-bot/
├── .env.example              # Environment variables template
├── .gitignore                # Git exclusions (node_modules, .env, *.db)
├── Dockerfile                # Production Docker container
├── render.yaml               # Render Blueprint specification
├── README.md                 # Documentation & Render deployment guide
├── package.json              # "start": "node index.js"
├── index.js                  # Main entry point (HTTP health check + Long Polling)
├── server.js                 # Unified entry delegate
├── data/
│   ├── .gitkeep              # Preserves data directory in git
│   └── taskwork.db           # Persistent SQLite database
├── src/
│   ├── bot.js                # Core grammY bot setup, long polling & state router
│   ├── config.js             # Environment configuration & directory validation
│   ├── database.js           # SQLite engine, schema, prepared queries & file persistence
│   ├── keyboards.js          # Telegram reply & inline keyboards
│   ├── handlers/
│   │   ├── start.js          # /start, deep links (ref_<id>), force channel membership
│   │   ├── user.js           # Wallet, My Stats, Leaderboard, Invite & Earn, Support
│   │   ├── tasks.js          # Review, Gmail, and custom task browsers & claim flows
│   │   ├── submissions.js    # Photo proof upload handler & admin preview notifications
│   │   ├── withdrawals.js    # UPI cashout flow, amount/VPA validation & balance reservation
│   │   └── admin.js          # Admin Control Center, Task/Proof/Withdrawal/User/Roster tools
│   └── utils/
│       ├── helpers.js        # Integer paise formatting (₹), HTML escaping, dates
│       └── admin.js          # Super Admin vs Normal Admin RBAC checks & audit logs
└── tests/
    └── bot.test.js           # Automated integration test suite
```

---

## 💡 Architecture & Resilience Highlights

- **Dummy HTTP Server**: Native HTTP server binding to `process.env.PORT || 3000` responding with `200 OK` on `/`, `/health`, and `/api/status` for Render Web Service health monitoring.
- **Long-Polling with Auto-Reconnect**: Resilient polling with exponential backoff on network dropouts.
- **Integer Paise Financial Calculations**: Eliminates floating-point rounding issues (e.g. ₹15.00 = 1500 paise, ₹0.20 = 20 paise).
- **Graceful Shutdown**: Intercepts `SIGINT` and `SIGTERM` signals to persist pending SQLite buffer to disk before exiting.
