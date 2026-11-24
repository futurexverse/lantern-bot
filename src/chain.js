/* =====================================================================
   LANTERN bot — chain layer (Solana, Node) — READ-ONLY
   ---------------------------------------------------------------------
   Per-user wallet architecture (Option A):
   - The server holds NO private keys.
   - Each user connects their own Phantom wallet on the trade page
     (hosted on Vercel) and signs swaps client-side.
   - This module only does READ-ONLY chain calls: balances, mint info,
     holder concentration, safety screen, Jupiter quotes (for display).
   - The actual swap signing happens in trade.js (browser, Phantom).
   ===================================================================== */
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config.js';

const LAMPORTS = 1e9;
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const READ_FALLBACKS = [
  'https://solana-rpc.publicnode.com',
  'https://solana-mainnet.api.onfinality.io/public'
];

let _readUrl = null;

/* ---------------- RPC (with fallbacks) ---------------- */

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

/**
 * Run a read across endpoints: cached → primary → fallbacks.
 * disableRetryOnRateLimit so a 429 falls through to the next endpoint
 * instead of backing off internally for many seconds per URL.
 */
export async function readCall(fn) {
  const urls = [_readUrl, config.rpcMainnet].concat(READ_FALLBACKS)
    .filter((u, i, a) => u && a.indexOf(u) === i);
  let lastErr = null;
  for (const url of urls) {
    try {
      const conn = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
      const res = await withTimeout(fn(conn), 10000);
      _readUrl = url;
      return res;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      if (!/429|40[0135]|too many|rate limit|forbidden|not allowed|does not support|method not found|timeout|fetch|network|ECONN/i.test(msg)) throw e;
    }
  }
  throw lastErr || new Error('All RPC endpoints failed.');
}

/* ---------------- balances ---------------- */

export async function solBalance(addr) {
  const lamports = await readCall(conn => conn.getBalance(new PublicKey(addr)));
  return lamports / LAMPORTS;
}

/** SPL token accounts with balance > 0: [{mint, amount, decimals}]. */
export async function getPositions(addr) {
  const owner = new PublicKey(addr);
  const res = await readCall(conn =>
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM })
  );
  const out = [];
  res.value.forEach(v => {
    const info = v.account.data.parsed.info;
    const amt = info.tokenAmount || {};
    const ui = amt.uiAmount || 0;
    if (ui > 0) out.push({ mint: info.mint, amount: ui, decimals: amt.decimals });
  });
  return out;
}

export async function getTokenBalance(addr, mint) {
  const list = await getPositions(addr);
  const hit = list.find(p => p.mint === mint);
  return hit ? hit.amount : 0;
}

/* ---------------- mint / holder reads ---------------- */

/** Parsed mint account: decimals, authorities, supply. */
export async function getMintInfo(mint) {
  const res = await readCall(conn => conn.getParsedAccountInfo(new PublicKey(mint)));
  const v = res && res.value;
  if (!v || !v.data || !v.data.parsed) return null;
  const i = v.data.parsed.info;
  return {
    decimals: i.decimals,
    mintAuthority: i.mintAuthority || null,
    freezeAuthority: i.freezeAuthority || null,
    supply: i.supply,
    owner: v.owner
  };
}

/** Top 10 token accounts + their share of supply. */
export async function getTopHolders(mint) {
  const res = await readCall(conn => conn.getTokenLargestAccounts(new PublicKey(mint)));
  const rows = (res.value || []).slice(0, 10).map(v => ({
    address: v.address.toBase58 ? v.address.toBase58() : String(v.address),
    amount: v.uiAmount || 0
  }));
  let supply = null;
  try {
    const mi = await getMintInfo(mint);
    if (mi && mi.supply) supply = Number(mi.supply) / Math.pow(10, mi.decimals ?? 9);
  } catch (e) { /* unknown */ }
  const top10 = rows.reduce((s, r) => s + r.amount, 0);
  return { holders: rows, top10Pct: supply ? (top10 / supply) * 100 : null };
}

/**
 * On-chain safety screen: mint/freeze authorities + holder concentration
 * + DexScreener liquidity/age/flow. Same logic as the web app's chain.js.
 */
export async function safetyScreen(mint, pair) {
  const checks = [];

  let mi = null, holders = null;
  try { mi = await getMintInfo(mint); } catch (e) { mi = null; }
  try { holders = await getTopHolders(mint); } catch (e) { holders = null; }

  if (mi) {
    checks.push({
      ok: !mi.mintAuthority, weight: 22,
      label: mi.mintAuthority ? 'Mint authority active — supply can be inflated' : 'Mint authority revoked — fixed supply'
    });
    checks.push({
      ok: !mi.freezeAuthority, weight: 16,
      label: mi.freezeAuthority ? 'Freeze authority active — holders can be frozen' : 'Freeze authority revoked'
    });
  } else {
    checks.push({ ok: null, weight: 22, label: 'Mint authority — RPC unavailable' });
    checks.push({ ok: null, weight: 16, label: 'Freeze authority — RPC unavailable' });
  }

  if (holders && holders.top10Pct != null) {
    const pct = holders.top10Pct;
    checks.push({
      ok: pct <= 20, weight: 20,
      label: 'Top 10 hold ' + pct.toFixed(1) + '% of supply' + (pct <= 20 ? ' — healthy' : ' — concentrated')
    });
  } else {
    checks.push({ ok: null, weight: 20, label: 'Holder concentration — RPC unavailable' });
  }

  if (pair && pair.liq != null) {
    checks.push({
      ok: pair.liq >= 10000, weight: 20,
      label: 'Liquidity ' + (pair.liq >= 10000 ? 'healthy' : 'thin — exits may fail')
    });
  } else {
    checks.push({ ok: null, weight: 20, label: 'Liquidity — no pool data' });
  }

  if (pair && pair.ageH != null) {
    checks.push({ ok: pair.ageH >= 24, weight: 12, label: 'Pool age ' + (pair.ageH >= 24 ? 'over 24h' : 'very new') });
  } else {
    checks.push({ ok: null, weight: 12, label: 'Pool age — unknown' });
  }

  if (pair && pair.buys24 != null && pair.sells24 != null) {
    const ratio = pair.sells24 ? pair.buys24 / pair.sells24 : pair.buys24;
    checks.push({ ok: ratio >= 1, weight: 10, label: 'Buy:sell ' + ratio.toFixed(1) + '× (24h)' });
  } else {
    checks.push({ ok: null, weight: 10, label: 'Trade flow — no DEX data' });
  }

  const socialsOk = !!(pair && ((pair.socials?.length) || (pair.websites?.length)));
  checks.push({ ok: socialsOk, weight: 10, label: socialsOk ? 'Project socials linked' : 'No linked socials — anonymity risk' });

  let score = 0, max = 0;
  checks.forEach(c => {
    max += c.weight;
    if (c.ok === true) score += c.weight;
    else if (c.ok === null) score += c.weight * 0.4;
  });
  const pct = max ? Math.round((score / max) * 100) : 0;
  const verdict = pct >= 80 ? 'Looks solid'
    : pct >= 60 ? 'Trade with care'
    : pct >= 40 ? 'High risk'
    : 'Critical risk';
  return { score: pct, verdict, checks };
}

/* ---------------- Jupiter: quote (display only — no server signing) ---------------- */

const JUP = 'https://lite-api.jup.ag';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Fetch a Jupiter quote for display purposes. The actual swap is signed
 * client-side in trade.js (browser + Phantom), not here.
 */
export async function quoteRaw({ inputMint, outputMint, amountRaw, slippageBps }) {
  amountRaw = String(amountRaw);
  if (!amountRaw || amountRaw === '0') throw new Error('Enter an amount first.');
  const url = JUP + '/swap/v1/quote' +
    '?inputMint=' + inputMint +
    '&outputMint=' + outputMint +
    '&amount=' + amountRaw +
    '&slippageBps=' + (slippageBps == null ? config.slippageBps : slippageBps) +
    '&restrictIntermediateSwaps=true';
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const q = await r.json();
  if (!r.ok || q.error || q.errorCode) {
    const raw = typeof q.error === 'string' ? q.error
      : (q.error && q.error.message) || q.errorMessage || '';
    const msg = q.errorCode === 'TOKEN_NOT_TRADABLE'
      ? 'This token has no tradable pool routed by Jupiter yet.'
      : raw || ('Quote failed (HTTP ' + r.status + ').');
    throw new Error(msg);
  }
  return q;
}
