/* Alert-feed smoke test: message building, opt-in, dedupe, fan-out. */
import { config } from './src/config.js';
import * as store from './src/store.js';
import * as alerts from './src/alerts.js';

let fails = 0, warns = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
};
const warn = (n, e) => { warns++; console.log(`WARN  ${n}${e ? '  → ' + e : ''}`); };

const CHAT = '-1001234567';

/* ---- opt-in ---- */
config.alertChats = [];
ok('no chats by default', alerts.alertChats().length === 0, JSON.stringify(alerts.alertChats()));

store.setAlerts(CHAT, true);
ok('/alerts on registers chat', alerts.alertChats().includes(CHAT), JSON.stringify(alerts.alertChats()));

store.setAlerts(CHAT, false);
ok('/alerts off unregisters chat', !alerts.alertChats().includes(CHAT));

config.alertChats = ['222'];
ok('seeded ALERT_CHAT_IDS counts as opted in', alerts.alertChats().includes('222'),
  JSON.stringify(alerts.alertChats()));

store.setAlerts(CHAT, false); // explicit off beats the seed for CHAT
config.alertChats = [CHAT];
ok('explicit off beats seed', !alerts.alertChats().includes(CHAT),
  JSON.stringify(alerts.alertChats()));

store.setAlerts(CHAT, true);
ok('explicit on restores chat', alerts.alertChats().includes(CHAT));
config.alertChats = [];
ok('explicit on survives removing the seed', alerts.alertChats().includes(CHAT),
  JSON.stringify(alerts.alertChats()));

/* ---- message building ---- */
store.clearSeen();
const msgs = await alerts.collectAlerts();
ok('collectAlerts returns an array', Array.isArray(msgs));
if (msgs.length) {
  const all = msgs.join('\n');
  ok('has trending or new-pool header', /Trending now|New pool launched/.test(all),
    msgs.map(m => m.split('\n')[0]).join(' | '));
  ok('messages carry mint addresses', /<code>[1-9A-HJ-NP-Za-km-z]{32,44}<\/code>/.test(all));
  ok('messages are HTML-safe', (() => {
    const stripped = all
      .replace(/<\/?(b|code|i|a)(\s[^>]*)?>/gi, '')
      .replace(/&[a-z]+;/gi, '');
    return !/[<>]/.test(stripped);
  })(), all.replace(/\n/g, ' ').slice(0, 70));
  ok('messages avoid stray undefined', !/undefined|null|NaN/.test(all),
    (all.match(/undefined|null|NaN/g) || []).join(',') || 'clean');

  /* ---- fan-out (fresh dedupe state, as a real first tick would have) ---- */
  store.clearSeen();
  const sent = [];
  const n = await alerts.runAlerts(async (chat, text) => { sent.push({ chat, text }); });
  ok('runAlerts delivers to opted-in chat', sent.length > 0 && sent.every(s => s.chat === CHAT),
    `${n} sent to ${JSON.stringify([...new Set(sent.map(s => s.chat))])}`);

  /* ---- dedupe: the next tick must not repeat the same mints ---- */
  const again = await alerts.collectAlerts();
  ok('repeat tick is deduped', again.length === 0,
    `first=${msgs.length} msgs, repeat=${again.length} msgs`);
} else {
  warn('alert feeds empty right now (dedupe/fan-out skipped)', 'DexScreener/GeckoTerminal returned nothing');
}

/* ---- fan-out with nobody opted in ---- */
{
  config.alertChats = [];
  store.setAlerts(CHAT, false);
  let called = 0;
  const n = await alerts.runAlerts(async () => { called++; });
  ok('no recipients → nothing sent', n === 0 && called === 0, `sent=${n}`);
}

/* ---- transport failure must not throw ---- */
{
  config.alertChats = [CHAT];
  store.setAlerts(CHAT, true);
  store.clearSeen();
  let threw = false;
  try {
    await alerts.runAlerts(async () => { throw new Error('telegram down'); });
  } catch (e) { threw = true; }
  ok('transport errors are swallowed', !threw, threw ? 'runAlerts threw' : 'handled');
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}${warns ? ' (' + warns + ' warning(s))' : ''}`);
process.exit(fails ? 1 : 0);
