# LANTERN Telegram Bot — Per-User Wallet Mode

Each user trades from **their own Phantom wallet**. The server holds no private keys.
The bot is a launcher: `/buy bonk 0.1` replies with a button that opens the Vercel-hosted
trade page, where the user connects Phantom and signs their own swap.

## Commands

All commands work in **groups** as well as DMs. The reply goes to whichever chat the
command was issued in — for private balance/portfolio, DM the bot directly.

| Command | What it does |
|---|---|
| `/start` `/help` | Command list |
| `/price <token>` | Live price, 24h change, market cap, liquidity |
| `/token <token>` | Full token info + on-chain safety screen (score /100) |
| `/trending` | Boosted/trending Solana tokens with real stats |
| `/newpools` | Freshly launched pools |
| `/linkwallet <address>` | Link YOUR Phantom wallet address (public key only) |
| `/setwallet <address>` | Alias of /linkwallet (back-compat) |
| `/balance` | SOL + holdings value of YOUR linked wallet |
| `/portfolio` | Asset breakdown with prices and net worth |
| `/trades` | Your trade history (recorded by the trade page after each swap) |
| `/watch <token>` · `/unwatch` · `/watchlist` | Watchlist |
| `/buy <token> <amount>` | Opens the trade page → you sign in Phantom |
| `/sell <token> <amount>` | Same, sell side |
| `/alerts on\|off` | Toggle trending & new-pool pushes in this chat |

`<token>` accepts any contract address, or a ticker like `bonk`.
Amounts: `/buy bonk 0.1` (SOL), `/buy bonk $5` (USD), `/buy bonk 50%`,
`/sell bonk 1m` (token count), `/sell bonk 100%`.

## How a trade runs (per-user wallet flow)

1. `/buy bonk 0.1` in Telegram → bot resolves token, replies with a quote preview
   and a button **"🔐 Open BUY in Phantom"**.
2. User taps the button → Telegram opens `https://your-vercel-app.vercel.app/trade.html?...`
   in the in-app browser (or system browser).
3. Trade page connects Phantom (user taps **Connect Phantom**) → page shows
   user's SOL balance + the trade details.
4. Page fetches a **fresh Jupiter quote** (the preview one expired).
5. User taps **Confirm BUY in Phantom** → Phantom pops up → user approves.
6. Page sends the signed transaction to Solana RPC → waits for confirmation.
7. Page shows "Trade confirmed ✅" with a Solscan link.
8. Page POSTs `{ signerAddress, signature, side, mint, inUi, outUi }` to the bot's
   `/api/record-trade` endpoint → `/trades` history updates.
9. User closes the page → back to Telegram.

**At no point does the bot server see or hold any private key.** The server only
records public on-chain data (signature + signer address) for display.

## Configuration (`.env`)

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **Yes** | From @BotFather |
| `WEBAPP_URL` | **Yes** | URL of `trade.html` on your Vercel deployment |
| `BOT_API_URL` | Recommended | Public URL of this bot process (Railway) — for `/trades` recording |
| `RECORD_KEY` | Recommended | Shared secret for `/api/record-trade` |
| `RPC_MAINNET` | Yes (default works) | Solana RPC — Helius recommended over public |
| `RPC_DEVNET` | Yes (default works) | Devnet endpoint |
| `ALERT_CHAT_IDS` | Optional | Chat IDs that get alerts automatically |
| `ALERT_INTERVAL_SECONDS` | Optional (default 120) | Alert tick interval |
| `SLIPPAGE_BPS` | Optional (default 50) | Slippage for quote previews |
| `STORE_PATH` | Optional | Persistence path (use `/data/store.json` on Railway) |
| `PORT` | Auto on Railway | HTTP port for `/api/record-trade` |

## Removed (no longer needed)

These were used in the old server-held-wallet mode. **They are gone:**

- `BOT_PRIVATE_KEY` — no server wallet, no key to leak
- `ALLOWED_USER_IDS` — every user trades their own money, no allow-list needed

## Quick start (local)

```bash
cd lantern-bot
npm install
cp .env.example .env      # then edit .env
npm start
```

`node` 18+ is required.

## Tests

```bash
npm test
```

Note: `smoketest.commands.js` still tests the parsing/formatting/lookup logic,
but the trade execution tests are deprecated in this mode (the bot doesn't
execute trades server-side anymore — signing happens in Phantom).

## Architecture

```
Telegram users ──polling──► index.js (router + /api/record-trade HTTP server)
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
          src/commands.js  src/alerts.js   src/store.js
                │
        ┌───────┴───────┐
        ▼               ▼
   src/market.js   src/chain.js  (READ-ONLY — no swap/sign)
        │               │
        ▼               ▼
   DexScreener     Solana RPC
   GeckoTerminal   (balances, mint info, safety screen)
   Jupiter Price
   Jupiter Quote (display only)


Trade page (Vercel, lantern-frontend/trade.html)
        │
        ├── connects user's Phantom (window.phantom.solana)
        ├── fetches Jupiter quote
        ├── gets unsigned swap tx from Jupiter
        ├── Phantom signs (client-side — key never leaves user's wallet)
        ├── sends signed tx to Solana RPC
        └── POSTs result to bot's /api/record-trade (optional)
```

## Data & privacy

- **Market data**: DexScreener + GeckoTerminal + Jupiter Price API — free, no keys.
- **Chain reads**: your configured Solana RPC.
- **Persistence** (`store.json`): per-user linked wallet addresses (PUBLIC keys only),
  per-user watchlists, trade history (signer address + signature — all public on-chain),
  alert preferences.
- **No private keys** ever touch the server.
- No message content or chat history is stored.
