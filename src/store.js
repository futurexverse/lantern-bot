/* =====================================================================
   LANTERN bot — persistent store (JSON file, atomic writes)
   Holds: linked wallets, per-user watchlist, trade history, and the
   dedupe set for alert pushes.
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const EMPTY = {
  // userId -> {address, addedAt}  (PUBLIC KEY ONLY — never a secret)
  // In the per-user-wallet architecture, this is the address the user
  // linked via /linkwallet so /balance /portfolio work without opening
  // the trade page. Each user signs their own trades in Phantom.
  wallets: {},
  watchlist: {},  // userId -> [mint, ...]
  // Trades are recorded by the trade page (trade.js) POSTing to
  // /api/record-trade after a successful swap. Each trade is tagged with
  // the signer's wallet address (self-proving on-chain) — /trades looks
  // up the caller's linked wallet and shows trades matching it.
  trades: [],     // [{ts, signerAddress, side, mint, sym, inUi, outUi, signature, explorer}]
  seen: {},       // key -> ts (alert dedupe)
  alerts: {}      // chatId -> {enabled, since}
};

let state = null;
let writeTimer = null;

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(config.storePath)) {
      const raw = fs.readFileSync(config.storePath, 'utf8');
      state = Object.assign({}, EMPTY, JSON.parse(raw || '{}'));
    } else {
      state = structuredClone(EMPTY);
    }
  } catch (e) {
    console.error('[store] failed to read store.json, starting fresh:', e.message);
    state = structuredClone(EMPTY);
  }
  return state;
}

/** Debounced write so rapid updates don't thrash the disk. */
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const s = load();
      const dir = path.dirname(config.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = config.storePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
      fs.renameSync(tmp, config.storePath);
    } catch (e) {
      console.error('[store] write failed:', e.message);
    }
  }, 250);
}

export function getState() { return load(); }

/* ---------------- wallets ---------------- */

export function setWallet(userId, address) {
  load().wallets[String(userId)] = { address, addedAt: Date.now() };
  persist();
}
export function getWallet(userId) {
  const w = load().wallets[String(userId)];
  return w ? w.address : null;
}
export function clearWallet(userId) {
  delete load().wallets[String(userId)];
  persist();
}

/* ---------------- watchlist ---------------- */

export function getWatchlist(userId) {
  return load().watchlist[String(userId)] || [];
}
export function addWatch(userId, mint) {
  const s = load();
  const list = s.watchlist[String(userId)] = s.watchlist[String(userId)] || [];
  if (!list.includes(mint)) list.push(mint);
  persist();
  return list;
}
export function removeWatch(userId, mint) {
  const s = load();
  const list = s.watchlist[String(userId)] = s.watchlist[String(userId)] || [];
  const i = list.indexOf(mint);
  if (i > -1) list.splice(i, 1);
  persist();
  return list;
}

/* ---------------- trades ---------------- */

export function recordTrade(t) {
  const s = load();
  s.trades.push(Object.assign({ ts: Date.now() }, t));
  if (s.trades.length > 300) s.trades = s.trades.slice(-300);
  persist();
}
/**
 * Return trades whose signerAddress matches the user's linked wallet.
 * In the per-user architecture, trade history is keyed by the on-chain
 * signer (which is public and self-proving), not by Telegram user ID.
 */
export function tradesForWallet(walletAddress) {
  if (!walletAddress) return [];
  const a = String(walletAddress);
  return load().trades
    .filter(t => String(t.signerAddress) === a)
    .slice(-60)
    .reverse();
}

/* ---------------- alert dedupe + chat prefs ---------------- */

export function seenRecently(key, windowMs = 6 * 3600 * 1000) {
  const s = load();
  const at = s.seen[key];
  if (at && Date.now() - at < windowMs) return true;
  s.seen[key] = Date.now();
  // keep the dedupe map bounded
  const keys = Object.keys(s.seen);
  if (keys.length > 2000) {
    const cutoff = Date.now() - windowMs;
    keys.forEach(k => { if (s.seen[k] < cutoff) delete s.seen[k]; });
  }
  persist();
  return false;
}

/** Forget every dedupe marker so the next tick re-announces everything. */
export function clearSeen() {
  load().seen = {};
  persist();
}

export function alertEnabled(chatId) {
  const a = load().alerts[String(chatId)];
  if (a) return !!a.enabled;
  // default: enabled if the chat was pre-seeded in ALERT_CHAT_IDS
  return config.alertChats.includes(String(chatId));
}
export function setAlerts(chatId, enabled) {
  load().alerts[String(chatId)] = { enabled: !!enabled, since: Date.now() };
  persist();
}
