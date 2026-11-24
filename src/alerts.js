/* =====================================================================
   LANTERN bot — alert feed (trending tokens & new pool launches)
   Message building + dedupe live here so it can be tested without a
   Telegram connection; index.js only supplies a transport function.
   ===================================================================== */
import * as market from './market.js';
import * as store from './store.js';
import { config } from './config.js';
import { fmtPrice, fmtPct, fmtUsd, ageLabel, shortAddr } from './format.js';

/** Escape user/market-sourced text for Telegram's HTML parse mode. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Chats that currently want alerts: seeded list ∪ any chat that ran /alerts on. */
export function alertChats() {
  const seeded = config.alertChats.slice();
  const toggled = Object.keys(store.getState().alerts);
  return Array.from(new Set(seeded.concat(toggled))).filter(id => store.alertEnabled(id));
}

function tokenLine(sym, usd, info, mint) {
  const parts = [`<b>$${esc(sym)}</b> ${fmtPrice(usd)}`];
  if (info?.change?.h24 != null) parts.push(fmtPct(info.change.h24));
  if (info?.liq != null) parts.push('liq ' + fmtUsd(info.liq));
  return parts.join(' · ') + `\n<code>${esc(mint)}</code>`;
}

/**
 * Build this tick's alert messages.
 * Each mint is pushed at most once per DEDUPE_MS (6h) so the same token
 * doesn't spam every cycle.
 * @returns {Promise<string[]>} HTML message bodies (may be empty)
 */
export async function collectAlerts({ dedupeMs = 6 * 3600 * 1000, limit = 4 } = {}) {
  const out = [];

  // --- trending (DexScreener boosts, hydrated) ---
  try {
    const hot = await market.trending(6);
    const fresh = hot.filter(t => t.mint && !store.seenRecently('trend:' + t.mint, dedupeMs));
    if (fresh.length) {
      const jp = await market.prices(fresh.map(t => t.mint)).catch(() => ({}));
      const lines = ['<b>🔥 Trending now</b>', ''];
      fresh.slice(0, limit).forEach(t => {
        const info = t.info || {};
        lines.push(tokenLine(
          t.symbol || info.symbol || shortAddr(t.mint),
          jp[t.mint]?.usd ?? info.price,
          info,
          t.mint
        ));
        lines.push('');
      });
      out.push(lines.join('\n').trim());
    }
  } catch (e) {
    console.error('[alerts] trending failed:', e.message);
  }

  // --- brand-new pools (GeckoTerminal) ---
  try {
    const pools = await market.newPools(6);
    const fresh = pools.filter(p => p.mint && !store.seenRecently('pool:' + p.mint, dedupeMs));
    if (fresh.length) {
      const lines = ['<b>🌱 New pool launched</b>', ''];
      fresh.slice(0, Math.max(2, limit - 1)).forEach(p => {
        lines.push(`<b>$${esc(p.symbol || shortAddr(p.mint))}</b> · ${ageLabel(p.ageH)} old · liq ${fmtUsd(p.liq)}`);
        lines.push(`<code>${esc(p.mint)}</code>`);
        lines.push('');
      });
      out.push(lines.join('\n').trim());
    }
  } catch (e) {
    console.error('[alerts] new pools failed:', e.message);
  }

  return out;
}

/**
 * Run one alert cycle: build messages and fan them out to every opted-in
 * chat. Returns the number of messages sent.
 * @param {(chatId: string, text: string) => Promise<void>} send
 */
export async function runAlerts(send) {
  const chats = alertChats();
  if (!chats.length) return 0;

  const msgs = await collectAlerts();
  if (!msgs.length) return 0;

  let sent = 0;
  for (const chat of chats) {
    for (const text of msgs) {
      try {
        await send(chat, text);
        sent++;
      } catch (e) {
        console.error('[alerts] send to', chat, 'failed:', e.message);
      }
    }
  }
  return sent;
}
