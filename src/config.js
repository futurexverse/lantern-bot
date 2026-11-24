/* =====================================================================
   LANTERN bot — configuration (env → typed config object)
   ---------------------------------------------------------------------
   Per-user wallet architecture: no BOT_PRIVATE_KEY, no ALLOWED_USER_IDS.
   Each user trades from their own Phantom wallet via the trade page
   hosted on Vercel (WEBAPP_URL).
   ===================================================================== */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const num = (v, d) => {
  const n = parseInt(String(v || '').trim(), 10);
  return Number.isFinite(n) ? n : d;
};

const list = v => String(v || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export const config = {
  // Telegram
  token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),

  // Where the trade page lives (Vercel-hosted trade.html).
  // /buy /sell commands send users here with prefilled trade params.
  webappUrl: (process.env.WEBAPP_URL || '').trim().replace(/\/$/, ''),

  // Public base URL of THIS bot process — used by the trade page to POST
  // back successful trades for /trades history. Optional: if empty,
  // trades still execute but won't be recorded in /trades.
  botApiUrl: (process.env.BOT_API_URL || '').trim().replace(/\/$/, ''),

  // Secret shared between the trade page and this bot's /api/record-trade
  // endpoint. Optional but recommended — prevents randoms from POSTing
  // fake trades into /trades history. Pass the same value to the trade
  // page as ?key=... in WEBAPP_URL.
  recordKey: (process.env.RECORD_KEY || '').trim(),

  // RPC (read-only — no server-side signing anymore)
  rpcMainnet: (process.env.RPC_MAINNET || 'https://api.mainnet-beta.solana.com').trim(),
  rpcDevnet: (process.env.RPC_DEVNET || 'https://api.devnet.solana.com').trim(),

  // Alerts
  alertChats: list(process.env.ALERT_CHAT_IDS),
  alertIntervalSec: num(process.env.ALERT_INTERVAL_SECONDS, 120),

  // Persistence
  storePath: path.resolve(
    __dirname,
    '..',
    process.env.STORE_PATH || './store.json'
  ),

  // Trading defaults
  slippageBps: num(process.env.SLIPPAGE_BPS, 50),

  // HTTP server port for /api/record-trade (Railway provides PORT automatically)
  port: num(process.env.PORT, 3000)
};

export function validateConfig() {
  const problems = [];
  if (!config.token) problems.push('TELEGRAM_BOT_TOKEN is missing (get one from @BotFather).');
  if (!config.webappUrl) problems.push('WEBAPP_URL is missing — /buy /sell buttons need a target (your Vercel trade page URL).');
  return problems;
}
