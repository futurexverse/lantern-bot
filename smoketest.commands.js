/* =====================================================================
   smoketest.commands.js — per-user wallet mode
   ---------------------------------------------------------------------
   Tests command handlers against a mock Telegram context.
   The OLD trade execution tests (balanceGuard, takePending,
   executeConfirmed, proposeTrade) are obsolete — the bot no longer
   signs swaps server-side. Each user signs in Phantom via trade.html.
   What we DO test:
   - help/price/token/trending/newpools reply with parseable HTML
   - /linkwallet stores the wallet address (public key only)
   - /balance reads the linked wallet from RPC
   - /buy /sell reply with an inline keyboard button (URL to trade.html)
   - /alerts on/off toggles state
   - group chat routing allows ALL commands now (per user request)
   ===================================================================== */
import * as cmd from './src/commands.js';
import * as store from './src/store.js';
import * as chain from './src/chain.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
};

/* ---- mock Telegram ctx ---- */
function mockCtx(text, opts = {}) {
  const parts = text.split(/\s+/);
  const userId = opts.userId ?? 42;
  const chatId = opts.chatId ?? userId;
  const chatType = opts.chatType ?? 'private';
  return {
    from: { id: userId },
    chat: { id: chatId, type: chatType },
    text,
    command: (parts[0] || '').split('@')[0].toLowerCase(),
    args: parts.slice(1),
    _replies: [],
    reply(content, o = {}) {
      this._replies.push({ content, opts: o });
      return Promise.resolve();
    }
  };
}

/* ---- routeAllowed: all commands work in groups now ---- */
console.log('\n-- group routing --');
for (const c of ['/start', '/price', '/token', '/trending', '/newpools',
                  '/balance', '/portfolio', '/trades', '/watch', '/unwatch',
                  '/watchlist', '/linkwallet', '/setwallet', '/buy', '/sell',
                  '/alerts']) {
  ok(`routeAllowed ${c} in group`, cmd.routeAllowed(c, 'group') === true);
}
ok('unknown command blocked in group', cmd.routeAllowed('/madeup', 'group') === false);
ok('everything allowed in private', cmd.routeAllowed('/anything', 'private') === true);

/* ---- /linkwallet stores address ---- */
console.log('\n-- /linkwallet --');
{
  const addr = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83hZRwQs8YsJx';  // fake, format-valid
  const ctx = mockCtx('/linkwallet ' + addr);
  await cmd.linkWallet(ctx);
  const r = ctx._replies[0];
  ok('/linkwallet replies', !!r);
  ok('/linkwallet confirms', r && /Linked wallet/.test(r.content));
  ok('/linkwallet stores address', store.getWallet(42) === addr);
  ok('/linkwallet does NOT accept secret-shaped input',
    !/secret/i.test(r.content));  // never mentions secrets
}

/* ---- /linkwallet rejects garbage ---- */
{
  const ctx = mockCtx('/linkwallet not-an-address');
  await cmd.linkWallet(ctx);
  const r = ctx._replies[0];
  ok('/linkwallet rejects garbage', r && /Usage/.test(r.content));
}

/* ---- /balance with no linked wallet → hint ---- */
{
  store.clearWallet(99);
  const ctx = mockCtx('/balance', { userId: 99 });
  await cmd.balance(ctx);
  const r = ctx._replies[0];
  ok('/balance no-wallet hint', r && /No wallet linked/.test(r.content));
}

/* ---- /buy replies with inline keyboard (button to trade page) ---- */
console.log('\n-- /buy /sell --');
{
  // Use a real token so resolveToken works
  const ctx = mockCtx('/buy bonk 0.01');
  await cmd.buy(ctx);
  const r = ctx._replies[0];
  ok('/buy replies', !!r);
  ok('/buy mentions token', r && /BUY/i.test(r.content));
  ok('/buy has inline keyboard',
    r && r.opts && r.opts.keyboard && r.opts.keyboard.inline_keyboard);
  ok('/buy keyboard has URL button',
    r && r.opts.keyboard.inline_keyboard[0] &&
    r.opts.keyboard.inline_keyboard[0][0] &&
    r.opts.keyboard.inline_keyboard[0][0].url);
  ok('/buy URL points to trade page',
    r && /trade\.html/.test(r.opts.keyboard.inline_keyboard[0][0].url || ''));
  ok('/buy URL includes side=buy param',
    r && /side=buy/.test(r.opts.keyboard.inline_keyboard[0][0].url || ''));
}

{
  const ctx = mockCtx('/sell bonk 1m');
  await cmd.sell(ctx);
  const r = ctx._replies[0];
  ok('/sell replies', !!r);
  ok('/sell has button to trade page',
    r && r.opts && r.opts.keyboard &&
    /side=sell/.test(r.opts.keyboard.inline_keyboard[0][0].url || ''));
}

/* ---- /alerts on/off ---- */
console.log('\n-- /alerts --');
{
  const chatId = 12345;
  const ctx = mockCtx('/alerts on', { chatId });
  await cmd.alerts(ctx);
  ok('/alerts on replies', /Alerts on/.test(ctx._replies[0].content));
  ok('/alerts on toggled state', store.alertEnabled(chatId) === true);
}
{
  const chatId = 12345;
  const ctx = mockCtx('/alerts off', { chatId });
  await cmd.alerts(ctx);
  ok('/alerts off toggled state', store.alertEnabled(chatId) === false);
}
{
  const ctx = mockCtx('/alerts maybe');
  await cmd.alerts(ctx);
  ok('/alerts bad arg shows usage', /Usage/.test(ctx._replies[0].content));
}

/* ---- /trades with no linked wallet → hint ---- */
{
  store.clearWallet(77);
  const ctx = mockCtx('/trades', { userId: 77 });
  await cmd.tradesCmd(ctx);
  const r = ctx._replies[0];
  ok('/trades no-wallet hint', r && /No wallet linked/.test(r.content));
}

/* ---- Removed functions are gone (negative test) ---- */
console.log('\n-- removed functions are gone --');
ok('balanceGuard removed', typeof cmd.balanceGuard === 'undefined');
ok('takePending removed', typeof cmd.takePending === 'undefined');
ok('peekPending removed', typeof cmd.peekPending === 'undefined');
ok('executeConfirmed removed', typeof cmd.executeConfirmed === 'undefined');
ok('tradingAllowed removed', typeof cmd.tradingAllowed === 'undefined');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
process.exit(fails ? 1 : 0);
