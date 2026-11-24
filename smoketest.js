/* Smoke test for bot modules that don't need a Telegram token. */
import * as fmt from './src/format.js';
import * as market from './src/market.js';
import * as store from './src/store.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
};

/* ---- format ---- */
ok('fmtUsd', fmt.fmtUsd(1234567) === '$1.23M', fmt.fmtUsd(1234567));
ok('fmtUsd small', fmt.fmtUsd(50) === '$50.00', fmt.fmtUsd(50));
ok('fmtUsd null', fmt.fmtUsd(null) === '—');
ok('fmtPrice tiny', fmt.fmtPrice(0.000002311).startsWith('$0.00000'), fmt.fmtPrice(0.000002311));
ok('fmtTok millions', fmt.fmtTok(1100000) === '1.10M', fmt.fmtTok(1100000));
ok('fmtPct sign', fmt.fmtPct(4.5) === '+4.50%', fmt.fmtPct(4.5));
ok('fmtPct neg', fmt.fmtPct(-2) === '-2.00%', fmt.fmtPct(-2));
ok('shortAddr', fmt.shortAddr('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263') === 'DezXAZ…PB263', fmt.shortAddr('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'));
ok('ageLabel h', fmt.ageLabel(30) === '30h', fmt.ageLabel(30));
ok('ageLabel d', fmt.ageLabel(72) === '3d', fmt.ageLabel(72));

/* ---- parseAmount ---- */
ok('parse plain', fmt.parseAmount('0.5', null) === 0.5, String(fmt.parseAmount('0.5', null)));
ok('parse 1m', fmt.parseAmount('1m', null) === 1e6, String(fmt.parseAmount('1m', null)));
ok('parse 2.5B', fmt.parseAmount('2.5B', null) === 2.5e9, String(fmt.parseAmount('2.5B', null)));
ok('parse bad', fmt.parseAmount('abc', null) === null);
ok('parse 0', fmt.parseAmount('0', null) === null);

/* ---- store ---- */
store.setWallet(111, 'TestWalletAddress111');
ok('store wallet roundtrip', store.getWallet(111) === 'TestWalletAddress111');
store.addWatch(111, 'MINT_A');
store.addWatch(111, 'MINT_A');
ok('store watch dedupe', store.getWatchlist(111).length === 1, String(store.getWatchlist(111)));
store.removeWatch(111, 'MINT_A');
ok('store watch remove', store.getWatchlist(111).length === 0);
// Per-user wallet mode: trades are keyed by signerAddress (public on-chain),
// recorded via /api/record-trade from the trade page.
store.recordTrade({ signerAddress: 'TestWalletAddress111', side: 'buy', mint: 'M', sym: 'S', inUi: 1, outUi: 2, signature: 'sig1' });
ok('store trades by signerAddress', store.tradesForWallet('TestWalletAddress111').length === 1, String(store.tradesForWallet('TestWalletAddress111').length));
ok('store other wallet empty', store.tradesForWallet('OtherWallet').length === 0);

/* ---- network ---- */
console.log('\n-- network checks --');
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const info = await market.tokenInfo(BONK);
ok('tokenInfo(BONK)', !!info && info.symbol != null, info ? `${info.symbol} price=${info.price} liq=${info.liq}` : 'null');

const sr = await market.search('bonk', 3);
ok('search(bonk)', Array.isArray(sr) && sr.length > 0, `${sr.length} hits, first=${sr[0]?.symbol}`);

const px = await market.prices([BONK, market.SOL_MINT]);
ok('prices', px[BONK] && px[market.SOL_MINT], JSON.stringify(px).slice(0, 120));

const tr = await market.trending(4);
ok('trending', Array.isArray(tr) && tr.length > 0, `${tr.length} items`);

const np = await market.newPools(4);
ok('newPools', Array.isArray(np) && np.length > 0, `${np.length} pools, sym0=${np[0]?.symbol}`);

const sol = await market.solSupply();
ok('solSupply', sol && sol.circulating, sol ? `${(sol.circulating / 1e6).toFixed(1)}M` : 'null');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
process.exit(fails ? 1 : 0);
