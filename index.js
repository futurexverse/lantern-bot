/* =====================================================================
   LANTERN Telegram bot — entry point (per-user wallet architecture)
   ---------------------------------------------------------------------
   - Telegram polling for commands (unchanged)
   - NEW: minimal HTTP server for /api/record-trade endpoint
     (the trade page POSTs here after a successful Phantom swap so
     /trades history stays in sync — server holds no keys)
   - Background alert loop (unchanged)
   ===================================================================== */
import http from 'node:http';
import TelegramBot from 'node-telegram-bot-api';
import { config, validateConfig } from './src/config.js';
import * as cmd from './src/commands.js';
import * as store from './src/store.js';
import { runAlerts } from './src/alerts.js';

/* ---------------- boot checks ---------------- */

const problems = validateConfig();
if (problems.length) {
  console.error('\n[config] Fix these before starting:\n  - ' + problems.join('\n  - ') + '\n');
  if (!config.token) process.exit(1);
}

/* ---------------- bot setup ---------------- */

const bot = new TelegramBot(config.token, { polling: true });

function makeCtx(msg) {
  const from = msg.from || { id: msg.chat.id };
  const chat = msg.chat;
  const text = (msg.text || '').trim();
  const parts = text.split(/\s+/);
  return {
    from, chat, text,
    command: (parts[0] || '').split('@')[0].toLowerCase(),
    args: parts.slice(1),
    reply(content, opts = {}) {
      const o = { parse_mode: opts.parse_mode, disable_web_page_preview: opts.disable_web_page_preview };
      if (opts.keyboard) o.reply_markup = opts.keyboard;
      return bot.sendMessage(chat.id, content, o).catch(e => {
        console.error('[send failed]', e.message, '\n', String(content).slice(0, 200));
      });
    }
  };
}

/* ---------------- command table ---------------- */
// All commands now work in groups too (see commands.js routeAllowed).
const routes = {
  '/start': cmd.help,
  '/help': cmd.help,
  '/price': cmd.price,
  '/token': cmd.token,
  '/trending': cmd.trendingCmd,
  '/newpools': cmd.newPoolsCmd,
  '/balance': cmd.balance,
  '/portfolio': cmd.portfolio,
  '/trades': cmd.tradesCmd,
  '/watchlist': cmd.watchlistCmd,
  '/watch': cmd.watch,
  '/unwatch': cmd.unwatch,
  '/setwallet': cmd.setWallet,    // alias of /linkwallet (back-compat)
  '/linkwallet': cmd.linkWallet,
  '/buy': cmd.buy,
  '/sell': cmd.sell,
  '/alerts': cmd.alerts
};

bot.on('message', async msg => {
  if (!msg.text || !msg.text.startsWith('/')) return;
  const ctx = makeCtx(msg);
  const handler = routes[ctx.command];
  if (!handler) return;

  // All commands are now allowed in groups too — see commands.js GROUP_OK.
  // The reply goes to whatever chat the command was issued in. If users
  // want privacy for /balance /portfolio /trades, they should DM the bot.
  try {
    await handler(ctx);
  } catch (e) {
    console.error('[handler]', ctx.command, e);
    ctx.reply('⚠️ Something went wrong running ' + ctx.command + '. Try again in a moment.');
  }
});

/* ---------------- inline confirm / cancel ---------------- */
// No longer used for trading (per-user wallets — swaps happen in Phantom).
// Kept for future use (e.g. /alerts confirm flow).
bot.on('callback_query', async q => {
  // Just acknowledge to clear the loading state
  bot.answerCallbackQuery(q.id).catch(() => {});
});

bot.on('polling_error', e => console.error('[polling]', e.message));
bot.on('error', e => console.error('[bot]', e.message));

/* ---------------- HTTP server: /api/record-trade ---------------- */
// The trade page (trade.js) POSTs here after a successful Phantom swap so
// /trades history stays in sync. The endpoint accepts the on-chain
// signature + signer address (self-proving — anyone can verify on Solscan).
// Optional shared secret (RECORD_KEY) gates who can post.

const server = http.createServer(async (req, res) => {
  // CORS: trade page is on a different origin (Vercel) than the bot (Railway)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && req.url === '/api/record-trade') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
    }

    // Optional shared-secret check
    if (config.recordKey) {
      if (payload.key !== config.recordKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'bad key' }));
      }
    }

    // Validate required fields
    const { signerAddress, side, mint, sym, inUi, outUi, signature } = payload;
    if (!signerAddress || !signature || !side || !mint) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'missing fields' }));
    }

    store.recordTrade({
      signerAddress: String(signerAddress),
      side: side === 'sell' ? 'sell' : 'buy',
      mint: String(mint),
      sym: String(sym || ''),
      inUi: Number(inUi) || 0,
      outUi: Number(outUi) || 0,
      signature: String(signature),
      explorer: 'https://solscan.io/tx/' + String(signature)
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(config.port, () => {
  console.log('[http] /api/record-trade listening on :' + config.port);
});

/* ---------------- alert loop ---------------- */

let alertBusy = false;
async function alertTick() {
  if (alertBusy) return;
  alertBusy = true;
  try {
    const sent = await runAlerts((chat, text) =>
      bot.sendMessage(chat, text, { parse_mode: 'HTML', disable_web_page_preview: true })
    );
    if (sent) console.log(`[alerts] delivered ${sent} message(s)`);
  } catch (e) {
    console.error('[alerts]', e.message);
  } finally {
    alertBusy = false;
  }
}

/* ---------------- start ---------------- */

console.log('── LANTERN Telegram bot ─────────────────────');
console.log('  Mode:       per-user wallets (Phantom + trade page)');
console.log('  Trade page: ' + (config.webappUrl || '(not set)'));
console.log('  HTTP API:   ' + (config.botApiUrl || '(not set — /trades recording disabled)'));
console.log('  Allow-list: open (each user trades their own wallet)');
console.log('  Alerts:     every ' + config.alertIntervalSec + 's → ' + (config.alertChats.length || 0) + ' seeded chat(s)');
console.log('  Store:      ' + config.storePath);
console.log('─────────────────────────────────────────────');

setInterval(alertTick, Math.max(30, config.alertIntervalSec) * 1000);
setTimeout(alertTick, 20 * 1000);

process.on('SIGINT', () => {
  console.log('\nStopping bot…');
  bot.stopPolling().then(() => process.exit(0)).catch(() => process.exit(0));
});
