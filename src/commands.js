/* =====================================================================
   LANTERN bot — command handlers
   ---------------------------------------------------------------------
   Per-user wallet architecture (Option A):
   - /buy /sell NO LONGER execute a swap server-side.
     They reply with a button that opens the Vercel-hosted trade page
     (trade.html), where the user connects Phantom and signs their own
     swap. The server holds zero private keys.
   - /balance /portfolio read the user's LINKED wallet (public address
     only, stored via /linkwallet).
   - All wallet/watchlist/trade commands now work in groups too —
     they reply to the chat. Reply visibility is the user's choice.
   ===================================================================== */
import { config } from './config.js';
import * as market from './market.js';
import * as chain from './chain.js';
import * as store from './store.js';
import {
  fmtUsd, fmtPrice, fmtTok, fmtPct, ageLabel, shortAddr,
  timeAgo, parseAmount
} from './format.js';

/* ---------------- pending quotes (kept for /buy /sell preview) ---------------- */
// We still compute a quote so the user sees price/impact/liquidity BEFORE
// tapping the button. But the quote is not stored server-side — trade.html
// re-fetches a fresh one when the user actually confirms in Phantom.

/* ---------------- chat-routing policy ---------------- */
// All commands work in groups now (per user request). Privacy is the user's
// choice — if they /balance in a group, the reply is visible to the group.
// (Note: market data + /alerts were always group-friendly.)
const GROUP_OK = new Set([
  '/start', '/help',
  '/price', '/token', '/trending', '/newpools',
  '/balance', '/portfolio', '/trades',
  '/watch', '/unwatch', '/watchlist',
  '/setwallet', '/linkwallet',
  '/buy', '/sell',
  '/alerts'
]);

export function routeAllowed(command, chatType) {
  if (!chatType || chatType === 'private') return true;
  return GROUP_OK.has(String(command).split('@')[0].toLowerCase());
}

/* ---------------- shared helpers ---------------- */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function resolveToken(q) {
  q = String(q || '').trim();
  if (!q) return null;

  if (BASE58.test(q)) {
    const info = await market.tokenInfo(q);
    return { mint: q, info };
  }

  const clean = q.replace(/^\$/, '');
  const found = await market.search(clean, 12);
  if (!found.length) return null;

  const byMint = new Map();
  for (const t of found) {
    let cur = byMint.get(t.mint);
    if (!cur) {
      cur = { mint: t.mint, info: t, liq: t.liq || 0, vol: t.vol24 || 0, pools: 1 };
      byMint.set(t.mint, cur);
    } else {
      cur.liq += t.liq || 0;
      cur.vol = Math.max(cur.vol, t.vol24 || 0);
      cur.pools += 1;
      if ((t.liq || 0) > (cur.info.liq || 0)) cur.info = t;
    }
  }
  const cands = Array.from(byMint.values());

  const jp = await market.prices(cands.map(c => c.mint)).catch(() => ({}));
  for (const c of cands) {
    const p = jp[c.mint];
    c.jupUsd = p && p.usd != null ? p.usd : null;
    c.jupLiq = p && p.liquidity != null ? p.liquidity : 0;
    c.tradable = c.jupUsd != null;
  }

  const rank = arr => arr.slice().sort((a, b) =>
    (b.tradable - a.tradable) ||
    (b.jupLiq - a.jupLiq) ||
    (b.vol - a.vol) ||
    (b.liq - a.liq) ||
    (b.pools - a.pools)
  );

  const exact = cands.filter(c =>
    String(c.info.symbol || '').toLowerCase() === clean.toLowerCase());
  const pool = exact.length ? exact : cands;
  const best = rank(pool)[0];
  if (!best) return null;

  const info = (await market.tokenInfo(best.mint)) || best.info;
  return { mint: best.mint, info, tradable: best.tradable };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tokenHeader(info, mint) {
  const sym = esc(info?.symbol || shortAddr(mint));
  const name = esc(info?.name || '');
  const lines = [`<b>$${sym}</b>${name && name !== sym ? ' · ' + name : ''}`];
  lines.push(`<code>${esc(mint)}</code>`);
  if (info?.url) lines.push(`<a href="${esc(info.url)}">DexScreener ↗</a>`);
  return lines.join('\n');
}

/* ============================= COMMANDS ============================= */

export const help = ctx => ctx.reply(
`<b>LANTERN — Solana trading bot</b>
<i>Per-user wallets: each user trades from their own Phantom.</i>

<b>Market</b>
/price &lt;token&gt; — live price + 24h change
/token &lt;mint|symbol&gt; — full token info + safety read
/trending — boosted tokens with real stats
/newpools — freshly launched pools

<b>Your wallet</b>
/linkwallet &lt;address&gt; — link your Phantom address (PUBLIC key only)
/balance — SOL + holdings value of your linked wallet
/portfolio — asset breakdown
/trades — your trade history (executed via the trade page)

<b>Watchlist</b>
/watch &lt;mint|symbol&gt; — add a token
/unwatch &lt;mint|symbol&gt; — remove it
/watchlist — your list with live prices

<b>Trading</b>
/buy &lt;token&gt; &lt;amount&gt; — opens the trade page, you sign in Phantom
/sell &lt;token&gt; &lt;amount&gt; — same, sell side
Amounts: <code>/buy bonk 0.1</code> (SOL) · <code>/buy bonk $5</code> · <code>/buy bonk 50%</code>
        <code>/sell bonk 1m</code> (tokens) · <code>/sell bonk 100%</code>

<b>Alerts</b>
/alerts on|off — toggle trending &amp; new-pool pushes

All commands work in groups too — but the reply is visible to the chat.
For private balance/portfolio, DM the bot directly.`,
  { parse_mode: 'HTML', disable_web_page_preview: true }
);

/* ---------------- market ---------------- */

export async function price(ctx) {
  const q = ctx.args.join(' ').trim();
  if (!q) return ctx.reply('Usage: <code>/price bonk</code> or paste a mint address.', { parse_mode: 'HTML' });
  const hit = await resolveToken(q);
  if (!hit) return ctx.reply('Token not found. Try a ticker or paste the contract address.');

  const { mint, info } = hit;
  const jp = await market.prices([mint]);
  const usd = jp[mint]?.usd ?? info?.price ?? null;

  const lines = [tokenHeader(info, mint)];
  lines.push('');
  lines.push(`Price: <b>${fmtPrice(usd)}</b>`);
  if (info?.change?.h24 != null) lines.push(`24h: <b>${fmtPct(info.change.h24)}</b>`);
  if (info?.change?.h1 != null) lines.push(`1h: ${fmtPct(info.change.h1)}`);
  if (info?.mcap != null) lines.push(`Market cap: ${fmtUsd(info.mcap)}`);
  if (info?.vol24 != null) lines.push(`24h volume: ${fmtUsd(info.vol24)}`);
  if (info?.liq != null) lines.push(`Liquidity: ${fmtUsd(info.liq)}`);
  if (info?.ageH != null) lines.push(`Pool age: ${ageLabel(info.ageH)}`);
  lines.push('');
  lines.push(`<code>/token ${esc(mint)}</code> · <code>/buy ${esc(info?.symbol || mint)} 0.1</code>`);

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function token(ctx) {
  const q = ctx.args.join(' ').trim();
  if (!q) return ctx.reply('Usage: <code>/token &lt;mint&gt;</code>', { parse_mode: 'HTML' });
  const hit = await resolveToken(q);
  if (!hit) return ctx.reply('Token not found — paste the full contract address or check the ticker.');

  const { mint, info } = hit;
  const jp = await market.prices([mint]);
  const usd = jp[mint]?.usd ?? info?.price ?? null;

  const lines = [tokenHeader(info, mint)];
  lines.push('');
  lines.push(`Price: <b>${fmtPrice(usd)}</b>`);
  if (info?.change) {
    const chg = [];
    if (info.change.m5 != null) chg.push('5m ' + fmtPct(info.change.m5));
    if (info.change.h1 != null) chg.push('1h ' + fmtPct(info.change.h1));
    if (info.change.h24 != null) chg.push('24h ' + fmtPct(info.change.h24));
    if (chg.length) lines.push(chg.join(' · '));
  }
  lines.push(`Market cap: ${fmtUsd(info?.mcap)} · FDV: ${fmtUsd(info?.fdv)}`);
  lines.push(`Liquidity: ${fmtUsd(info?.liq)} · 24h vol: ${fmtUsd(info?.vol24)}`);
  if (info?.pairCreatedAt) lines.push(`Pool age: ${ageLabel(info.ageH)} · ${esc(info.dexId || 'DEX')}`);

  lines.push('');
  lines.push('<b>Safety</b>');
  const sc = await chain.safetyScreen(mint, info).catch(() => null);
  if (sc) {
    lines.push(`Score <b>${sc.score}/100</b> — ${esc(sc.verdict)}`);
    sc.checks.forEach(c => {
      const ico = c.ok === true ? '✅' : c.ok === false ? '❌' : '▫️';
      lines.push(`${ico} ${esc(c.label)}`);
    });
  } else {
    lines.push('Safety read unavailable right now.');
  }

  if (usd) lines.push(`\n<code>/buy ${esc(info?.symbol || mint)} 0.1</code>`);
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function trendingCmd(ctx) {
  const list = await market.trending(8);
  if (!list.length) return ctx.reply('No trending data right now — try again shortly.');

  const mints = list.map(l => l.mint);
  const jp = await market.prices(mints).catch(() => ({}));

  const lines = ['<b>🔥 Trending on Solana</b>', ''];
  list.forEach((t, i) => {
    const info = t.info || {};
    const usd = jp[t.mint]?.usd ?? info.price ?? null;
    const sym = esc(t.symbol || info.symbol || shortAddr(t.mint));
    const chg = info.change?.h24 != null ? ' ' + fmtPct(info.change.h24) : '';
    const liq = info.liq != null ? ' · liq ' + fmtUsd(info.liq) : '';
    lines.push(`${i + 1}. <b>$${sym}</b> — ${fmtPrice(usd)}${chg}${liq}`);
    lines.push(`   <code>${esc(t.mint)}</code>`);
  });
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function newPoolsCmd(ctx) {
  const list = await market.newPools(8);
  if (!list.length) return ctx.reply('No new-pool feed available right now.');

  const lines = ['<b>🌱 New Solana pools</b>', ''];
  list.forEach((p, i) => {
    const sym = esc(p.symbol || shortAddr(p.mint || p.poolId));
    lines.push(`${i + 1}. <b>$${sym}</b> — liq ${fmtUsd(p.liq)} · vol ${fmtUsd(p.vol24)}`);
    lines.push(`   ${ageLabel(p.ageH)} old${p.dex ? ' · ' + esc(p.dex) : ''}`);
    if (p.mint) lines.push(`   <code>${esc(p.mint)}</code>`);
  });
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

/* ---------------- wallet / portfolio ---------------- */

/**
 * /linkwallet <address> — link the user's OWN Phantom wallet address.
 * This is a PUBLIC key (32-44 char base58). Never accept a secret key here.
 */
export function linkWallet(ctx) {
  const addr = (ctx.args[0] || '').trim();
  if (!BASE58.test(addr)) {
    return ctx.reply(
      'Usage: <code>/linkwallet &lt;your-phantom-address&gt;</code>\n\n' +
      'Paste the PUBLIC address of your Phantom wallet (starts with a number or letter, 32-44 chars).\n\n' +
      'Get it from Phantom → click the address at the top → Copy.\n\n' +
      '<i>Never paste your secret recovery phrase or private key — this bot doesn\'t need it.</i>',
      { parse_mode: 'HTML' }
    );
  }
  store.setWallet(ctx.from.id, addr);
  return ctx.reply(
    `✅ Linked wallet: <code>${esc(addr)}</code>\n\n` +
    `Try <code>/balance</code> or <code>/portfolio</code>.\n` +
    `To trade: <code>/buy bonk 0.1</code> → tap the button → sign in Phantom.`,
    { parse_mode: 'HTML' }
  );
}

// Backward-compat alias: /setwallet behaves the same as /linkwallet
export const setWallet = linkWallet;

/**
 * /balance [bot] is gone (no more server wallet).
 * /balance reads the user's linked wallet. If none linked, prompt.
 */
async function pickWallet(ctx) {
  const linked = store.getWallet(ctx.from.id);
  if (linked) return linked;
  ctx.reply(
    'No wallet linked yet.\n\n' +
    'Link yours: <code>/linkwallet &lt;your-phantom-address&gt;</code>\n' +
    '<i>(Public address only — never your private key.)</i>',
    { parse_mode: 'HTML' }
  );
  return null;
}

export async function balance(ctx) {
  const addr = await pickWallet(ctx);
  if (!addr) return;

  const [sol, sp] = await Promise.all([
    chain.solBalance(addr).catch(() => null),
    chain.getPositions(addr).catch(() => [])
  ]);

  const mints = sp.map(s => s.mint);
  const jp = mints.length ? await market.prices(mints).catch(() => ({})) : {};
  const solPx = (await market.prices([chain.SOL_MINT]).catch(() => ({})))?.[chain.SOL_MINT]?.usd ?? null;

  let total = sol != null && solPx ? sol * solPx : 0;
  let tokenVal = 0;
  sp.forEach(s => {
    const p = jp[s.mint]?.usd;
    if (p) tokenVal += s.amount * p;
  });
  total += tokenVal;

  const lines = [
    '<b>💰 Wallet balance</b>',
    `<code>${esc(addr)}</code>`,
    '',
    `SOL: <b>${fmtTok(sol)}</b>${solPx ? ' (~' + fmtUsd(sol * solPx) + ')' : ''}`,
    `Tokens: ${sp.length} holding${sp.length === 1 ? '' : 's'} (${fmtUsd(tokenVal)})`,
    '',
    `Total value: <b>${fmtUsd(total)}</b>`
  ];
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function portfolio(ctx) {
  const addr = await pickWallet(ctx);
  if (!addr) return;

  const [sol, sp] = await Promise.all([
    chain.solBalance(addr).catch(() => null),
    chain.getPositions(addr).catch(() => [])
  ]);

  const mints = sp.map(s => s.mint);
  const [jp, infos, solPxMap] = await Promise.all([
    mints.length ? market.prices(mints).catch(() => ({})) : Promise.resolve({}),
    mints.length ? market.infoBatch(mints).catch(() => ({})) : Promise.resolve({}),
    market.prices([chain.SOL_MINT]).catch(() => ({}))
  ]);
  const solPx = solPxMap?.[chain.SOL_MINT]?.usd ?? null;

  const rows = [];
  if (sol != null && sol > 0) {
    rows.push({ sym: 'SOL', amount: sol, price: solPx, val: solPx ? sol * solPx : null, up: null });
  }
  sp.forEach(s => {
    const info = infos[s.mint] || {};
    const price = jp[s.mint]?.usd ?? info.price ?? null;
    rows.push({
      sym: String(info.symbol || '').trim() || shortAddr(s.mint),
      amount: s.amount, price,
      val: price != null ? s.amount * price : null,
      up: info.change?.h24 ?? null
    });
  });

  if (!rows.length) {
    return ctx.reply('No assets in this wallet yet.');
  }

  rows.sort((a, b) => (b.val || 0) - (a.val || 0));
  const total = rows.reduce((s, r) => s + (r.val || 0), 0);

  const lines = ['<b>📊 Portfolio</b>', `<code>${esc(addr)}</code>`, ''];
  rows.slice(0, 15).forEach(r => {
    const chg = r.up != null ? ' · ' + fmtPct(r.up) : '';
    const price = r.price != null ? ' @ ' + fmtPrice(r.price) : '';
    lines.push(`<b>$${esc(r.sym)}</b> ${fmtTok(r.amount)}${price} — ${fmtUsd(r.val)}${chg}`);
  });
  lines.push('');
  lines.push(`Net worth: <b>${fmtUsd(total)}</b> (${rows.length} asset${rows.length === 1 ? '' : 's'})`);

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

/* ---------------- watchlist ---------------- */

export async function watch(ctx) {
  const hit = await resolveToken(ctx.args.join(' '));
  if (!hit) return ctx.reply('Token not found — give a ticker or contract address.');
  const list = store.addWatch(ctx.from.id, hit.mint);
  return ctx.reply(
    `⭐ Added <b>$${esc(hit.info?.symbol || shortAddr(hit.mint))}</b> to your watchlist (${list.length}).\n<code>/watchlist</code>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
}

export async function unwatch(ctx) {
  const hit = await resolveToken(ctx.args.join(' '));
  if (!hit) return ctx.reply('Token not found.');
  const list = store.removeWatch(ctx.from.id, hit.mint);
  return ctx.reply(`Removed. ${list.length} left in your watchlist.`, { parse_mode: 'HTML' });
}

export async function watchlistCmd(ctx) {
  const mints = store.getWatchlist(ctx.from.id);
  if (!mints.length) {
    return ctx.reply('Your watchlist is empty.\n\nAdd one: <code>/watch bonk</code>', { parse_mode: 'HTML' });
  }
  const [infos, jp] = await Promise.all([
    market.infoBatch(mints).catch(() => ({})),
    market.prices(mints).catch(() => ({}))
  ]);
  const lines = ['<b>⭐ Watchlist</b>', ''];
  mints.forEach(m => {
    const info = infos[m] || {};
    const usd = jp[m]?.usd ?? info.price ?? null;
    const sym = esc(info.symbol || shortAddr(m));
    const chg = info.change?.h24 != null ? ' ' + fmtPct(info.change.h24) : '';
    lines.push(`<b>$${sym}</b> — ${fmtPrice(usd)}${chg}`);
  });
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

/* ---------------- trade history ---------------- */

export function tradesCmd(ctx) {
  // In the per-user architecture, trades are keyed by signerAddress
  // (recorded by trade.js after a successful Phantom swap).
  const wallet = store.getWallet(ctx.from.id);
  if (!wallet) {
    return ctx.reply(
      'No wallet linked yet — <code>/linkwallet &lt;address&gt;</code> first.\n\n' +
      'Trades executed via the trade page are recorded against your wallet address.',
      { parse_mode: 'HTML' }
    );
  }
  const list = store.tradesForWallet(wallet);
  if (!list.length) {
    return ctx.reply(
      'No trades yet.\n\nTry <code>/buy bonk 0.1</code> → tap the button → sign in Phantom.',
      { parse_mode: 'HTML' }
    );
  }
  const lines = ['<b>🧾 Trade history</b>', `<code>${esc(shortAddr(wallet, 6, 6))}</code>`, ''];
  list.slice(0, 20).forEach(t => {
    const ico = t.side === 'buy' ? '🟢' : '🔴';
    const when = timeAgo(t.ts);
    lines.push(
      `${ico} <b>${t.side.toUpperCase()}</b> ${esc(t.sym || shortAddr(t.mint))} — ` +
      `${fmtTok(t.inUi)} → ${fmtTok(t.outUi)} · ${when}` +
      (t.signature ? `\n   <a href="${esc(t.explorer)}">tx</a> <code>${esc(shortAddr(t.signature, 8, 6))}</code>` : '')
    );
  });
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

/* ---------------- BUY / SELL — open trade page ---------------- */

/**
 * Per-user wallet architecture: /buy /sell no longer execute a swap.
 * They resolve the token, compute a preview quote (so the user sees
 * price + impact before tapping), then reply with an inline button
 * that opens trade.html on the Vercel site. The actual swap is signed
 * by the user's own Phantom in the browser — the server holds no keys.
 */
export async function proposeTrade(ctx, side) {
  const args = ctx.args.slice();
  if (args.length < 2) {
    return ctx.reply(
      `Usage: <code>/${side} &lt;token&gt; &lt;amount&gt;</code>\n` +
      `e.g. <code>/${side} bonk 0.1</code> ${side === 'buy' ? '(0.1 SOL)' : '(1m tokens)'}\n` +
      `Amount can be SOL, % of holdings, or a token count (k/m/b suffixes work).\n\n` +
      `You'll get a button — tap it to open the trade page and sign in Phantom.`,
      { parse_mode: 'HTML' }
    );
  }

  if (!config.webappUrl) {
    return ctx.reply('⚠️ Trade page not configured. Set <code>WEBAPP_URL</code> on the server.', { parse_mode: 'HTML' });
  }

  const amountStr = args.pop();
  const tokenRef = args.join(' ');
  const hit = await resolveToken(tokenRef);
  if (!hit) return ctx.reply('Token not found — give a ticker or contract address.');
  const { mint, info } = hit;
  if (mint === chain.SOL_MINT) return ctx.reply('SOL is the other side of the trade — pick a token.');

  const sym = info?.symbol || shortAddr(mint);

  // Build the trade page URL. trade.html reads these params and re-fetches
  // a fresh quote (Jupiter quotes expire in 90s, so we don't pass the
  // preview quote through). bot= and key= let the page POST the result
  // back to /api/record-trade for /trades history.
  const u = new URL(config.webappUrl);
  u.searchParams.set('side', side);
  u.searchParams.set('mint', mint);
  u.searchParams.set('sym', sym);
  u.searchParams.set('amount', amountStr);
  if (config.botApiUrl) u.searchParams.set('bot', config.botApiUrl);
  if (config.recordKey) u.searchParams.set('key', config.recordKey);
  // Pass a Helius RPC URL through if configured, so the trade page uses
  // the same endpoint as the bot (better rate limits than public).
  if (config.rpcMainnet && !config.rpcMainnet.includes('api.mainnet-beta.solana.com')) {
    u.searchParams.set('rpc', config.rpcMainnet);
  }
  const tradeUrl = u.toString();

  // Preview quote (best-effort — doesn't block the button)
  let preview = '';
  try {
    const priceMap = await market.prices([mint, chain.SOL_MINT]).catch(() => ({}));
    const tokenUsd = priceMap[mint]?.usd ?? info?.price ?? null;
    const solUsd = priceMap[chain.SOL_MINT]?.usd ?? null;
    if (tokenUsd && solUsd) preview = ` (~${fmtPrice(tokenUsd)} · ${fmtUsd(tokenUsd)})`;
  } catch (e) { /* skip preview */ }

  const lines = [
    `<b>${side === 'buy' ? '🟢 BUY' : '🔴 SELL'} $${esc(sym)}</b>${preview}`,
    tokenHeader(info, mint),
    '',
    `Amount: <b>${esc(amountStr)}</b>`,
    '',
    `<i>Tap the button below to open the trade page.</i>`,
    `<i>You'll connect Phantom and sign the swap yourself — your key never leaves your wallet.</i>`
  ];

  const keyboard = {
    inline_keyboard: [[
      { text: `🔐 Open ${side.toUpperCase()} in Phantom`, url: tradeUrl }
    ]]
  };

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', keyboard, disable_web_page_preview: true });
}

export const buy = ctx => proposeTrade(ctx, 'buy');
export const sell = ctx => proposeTrade(ctx, 'sell');

/* ---------------- alerts ---------------- */

export function alerts(ctx) {
  const arg = (ctx.args[0] || '').toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    return ctx.reply('Usage: <code>/alerts on</code> or <code>/alerts off</code>', { parse_mode: 'HTML' });
  }
  store.setAlerts(ctx.chat.id, arg === 'on');
  return ctx.reply(arg === 'on'
    ? '🔔 Alerts on — you\'ll get trending &amp; new-pool pushes.'
    : '🔕 Alerts off.', { parse_mode: 'HTML' });
}
