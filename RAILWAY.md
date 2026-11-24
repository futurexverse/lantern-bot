# LANTERN Bot — Railway Deployment (Per-User Wallet Mode)

This guide covers deploying the **per-user wallet** bot to Railway.
Each user trades from their own Phantom wallet — the server holds no private keys.

---

## Architecture summary

```
/buy bonk 0.1  ──►  bot replies with button
                     "🔐 Open BUY in Phantom"
                          │
                          ▼
                   Vercel: /trade.html  ◄── user's browser
                          │
                   user connects Phantom (client-side only)
                          │
                   Phantom signs the swap (key never leaves wallet)
                          │
                   signed tx → Solana RPC
                          │
                   POST result → Railway: /api/record-trade
                          │
                   /trades history updates
```

**Server holds zero private keys.** Each user's SOL stays in their own Phantom.

---

## What you need

| Thing | Where | Cost |
|---|---|---|
| Telegram bot token | `@BotFather` → `/token` for existing bot, or `/newbot` | Free |
| Vercel account (frontend) | <https://vercel.com> | Free |
| Railway account (bot) | <https://railway.app> | $5/mo after free trial |
| Helius RPC key (recommended) | <https://helius.dev> | Free tier |

---

## Step 1 — Deploy the frontend (trade page) to Vercel

This is the `lantern-frontend/` folder (separate from this bot). It now includes:

- `trade.html` — the trade page UI
- `trade.js` — Phantom connect + Jupiter swap logic
- `trade.css` — trade page styling
- Plus the existing landing page, dashboard, etc.

```bash
cd lantern-frontend
git init && git add . && git commit -m "Lantern frontend + trade page"
git push origin main
```

On Vercel: import the repo → Framework Preset: **Other** → Deploy.
Note your URL: `https://your-app.vercel.app` (you'll paste it into the bot).

The trade page is reachable at: `https://your-app.vercel.app/trade.html`

---

## Step 2 — Deploy the bot to Railway

### 2a. Push `lantern-bot/` to GitHub (separate repo)

```bash
cd lantern-bot
git init && git add . && git commit -m "Lantern bot - per-user wallet mode"
git push origin main
```

`.gitignore` already excludes `.env`, `node_modules`, `store.json`.

### 2b. Create the Railway service

1. <https://railway.app/new> → **Deploy from GitHub repo** → pick the bot repo.
2. Railway auto-detects Node.js. `railway.json` tells it `npm start`.
3. **Settings → Networking → Generate Domain** — this gives your bot a public URL
   like `https://lantern-bot-production.up.railway.app`. You need this for
   `BOT_API_URL` so the trade page can POST trade results back.
4. Don't deploy yet — set environment variables first.

### 2c. Set environment variables

Go to service → **Variables** tab → add each:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `9065366698:AAHi...` (your bot token) |
| `WEBAPP_URL` | `https://your-app.vercel.app/trade.html` (from step 1) |
| `BOT_API_URL` | `https://lantern-bot-production.up.railway.app` (from step 2b) |
| `RECORD_KEY` | Generate with: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `RPC_MAINNET` | `https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY` (recommended) |
| `STORE_PATH` | `/data/store.json` (see step 2d) |

### 2d. Mount a persistent volume

Railway's filesystem is ephemeral — without a volume, `store.json` (linked wallets,
watchlists, trade history) wipes on every redeploy.

1. Service → **Settings → Volumes → Add Volume**.
2. Mount path: `/data`
3. Confirm `STORE_PATH=/data/store.json` in variables.

### 2e. Update Vercel env with the bot URL + record key

The trade page needs to know where to POST trade results. Two ways:

**Option A — URL params (simplest):** append `?bot=...&key=...` to your `WEBAPP_URL`:

```
WEBAPP_URL=https://your-app.vercel.app/trade.html?bot=https://lantern-bot-production.up.railway.app&key=YOUR_RECORD_KEY
```

The bot already passes `bot=` and `key=` through when constructing the trade URL
(see `src/commands.js proposeTrade()`), so this is automatic — just set the
values in the bot's env, and the bot will inject them into the trade page URL
when users tap the **Open in Phantom** button.

**Option B — Vercel env vars:** add `VITE_BOT_API_URL` and `VITE_RECORD_KEY` on
Vercel and modify `trade.js` to read them. More work, no benefit over Option A.

→ Option A is the default. You don't need to do anything extra.

### 2f. Deploy

Click **Deploy**. Watch the **Logs** tab. On a healthy boot:

```
[http] /api/record-trade listening on :3000
── LANTERN Telegram bot ─────────────────────
  Mode:       per-user wallets (Phantom + trade page)
  Trade page: https://your-app.vercel.app/trade.html
  HTTP API:   https://lantern-bot-production.up.railway.app
  Allow-list: open (each user trades their own wallet)
  Alerts:     every 120s → 0 seeded chat(s)
  Store:      /data/store.json
─────────────────────────────────────────────
```

---

## Step 3 — Test end-to-end

1. **DM @LanternRBbot in Telegram** → `/start` → see the help.
2. `/linkwallet <your-phantom-address>` → paste your Phantom PUBLIC address.
3. `/balance` → see your SOL balance (read from chain).
4. `/price bonk` → see live price.
5. `/buy bonk 0.01` → bot replies with a quote preview + button.
6. Tap **🔐 Open BUY in Phantom** → trade page opens in browser.
7. Tap **Connect Phantom** → approve in Phantom.
8. Verify SOL balance shows on the page.
9. Tap **Confirm BUY in Phantom** → Phantom pops up → approve.
10. Page shows "Trade confirmed ✅" + Solscan link.
11. Back in Telegram → `/trades` → should show the trade you just did.
12. `/balance` → SOL balance decreased, BONK balance appears.

If every step works, you're live in per-user wallet mode. **No server wallet to drain,
no allow-list to maintain, no key rotation anxiety.**

---

## Step 4 — Tell users

When sharing the bot, tell users:

1. They need **Phantom wallet** installed (mobile app or browser extension):
   <https://phantom.app/download>
2. They DM **@LanternRBbot** → `/start` to see commands.
3. They run `/linkwallet <their-phantom-address>` once (so `/balance` works).
4. They use `/buy` `/sell` → tap the button → sign in Phantom → done.

Each user trades their own SOL. The bot never sees anyone's private key.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Boot fails with `WEBAPP_URL is missing` | Env var not set | Add `WEBAPP_URL=https://your-app.vercel.app/trade.html` on Railway |
| `/buy` button opens trade page but Phantom doesn't connect | User has no Phantom installed | Page shows "Phantom not detected" with a download link |
| Swap fails in Phantom with "insufficient funds" | User's wallet doesn't have enough SOL | User needs to fund their Phantom, not the bot |
| `/trades` shows empty after a swap | `BOT_API_URL` not set, or `RECORD_KEY` mismatch | Verify both on Railway; verify the trade page URL includes `?bot=...&key=...` |
| `/balance` says "No wallet linked" | User hasn't run `/linkwallet` | They paste their Phantom public address |
| `[polling] 401 Unauthorized` | Bad/expired `TELEGRAM_BOT_TOKEN` | Re-grab from @BotFather `/token` |
| `[polling] 409 Conflict` | Another process polling same token | Stop the old bot instance |
| Trade page 404 on Vercel | `trade.html` not pushed to GitHub | Push the latest `lantern-frontend/` |

---

## Comparison with old mode

| | Old (server wallet) | New (per-user wallets) |
|---|---|---|
| Server holds keys | Yes (`BOT_PRIVATE_KEY`) | **No** |
| User funds at risk if server hacked | All SOL in server wallet | Zero |
| Allow-list needed | Yes (or everyone drains server) | **No** (each user trades own funds) |
| Public bot safe | No | **Yes** |
| User UX | Just `/buy` in Telegram | `/buy` → tap button → sign in Phantom |
| Setup complexity | Lower (1 wallet to fund) | Higher (each user needs Phantom) |
| Trade recording | Automatic (server signs) | Via HTTP callback from trade page |

The new mode is strictly safer for a public bot. The tradeoff is users need Phantom
installed, which is the standard for any non-custodial Solana dApp anyway.
