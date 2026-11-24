/* =====================================================================
   smoketest.chain.js — per-user wallet mode
   ---------------------------------------------------------------------
   Tests the READ-ONLY chain layer. The signing/swap functions were
   removed in the per-user wallet architecture (each user signs their
   own swaps in Phantom; the server holds no keys). We test:
   - quoteRaw still works (used for /buy /sell preview)
   - safetyScreen runs against a real token
   - RPC reads (solBalance, getPositions) work against a known address
   ===================================================================== */
import * as chain from './src/chain.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
};

const SOL_MINT = chain.SOL_MINT;
ok('SOL_MINT constant exported', SOL_MINT === 'So11111111111111111111111111111111111111112');

/* ---- quoteRaw: used by /buy /sell preview (display only) ---- */
console.log('\n-- jupiter quote (display) --');
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
try {
  const q = await chain.quoteRaw({
    inputMint: SOL_MINT,
    outputMint: BONK,
    amountRaw: String(0.01 * 1e9),
    slippageBps: 50
  });
  ok('quoteRaw(BONK, 0.01 SOL)', q && q.inAmount && q.outAmount,
     `in=${q.inAmount} out=${q.outAmount}`);
  ok('quoteRaw has priceImpactPct', q.priceImpactPct != null, String(q.priceImpactPct));
} catch (e) {
  ok('quoteRaw(BONK)', false, e.message);
}

/* ---- solBalance / getPositions: read-only against a public address ---- */
console.log('\n-- RPC reads --');
// Wrapped SOL mint's largest account — guaranteed to be a valid on-chain account.
const WSOL_POOL = '2TdpBgs5KqXcFqZJzKDJyMa5tvtrRQvPAerF8GzKJB6F';
try {
  const bal = await chain.solBalance(WSOL_POOL);
  ok('solBalance returns a number', typeof bal === 'number' && bal >= 0, `${bal.toFixed(2)} SOL`);
} catch (e) {
  ok('solBalance', false, e.message);
}

try {
  const pos = await chain.getPositions(WSOL_POOL);
  ok('getPositions returns array', Array.isArray(pos), `${pos.length} positions`);
} catch (e) {
  ok('getPositions', false, e.message);
}

/* ---- safetyScreen on BONK ---- */
console.log('\n-- safetyScreen --');
try {
  const pair = { liq: 50000, ageH: 1000, buys24: 100, sells24: 50 };
  const sc = await chain.safetyScreen(BONK, pair);
  ok('safetyScreen runs', sc && typeof sc.score === 'number', `score=${sc.score}/100 verdict=${sc.verdict}`);
  ok('safetyScreen has 7 checks', Array.isArray(sc.checks) && sc.checks.length === 7, `${sc.checks.length} checks`);
} catch (e) {
  ok('safetyScreen', false, e.message);
}

/* ---- Removed functions are gone (negative test) ---- */
console.log('\n-- removed functions are gone --');
ok('loadKeypair removed', typeof chain.loadKeypair === 'undefined');
ok('parseSecret removed', typeof chain.parseSecret === 'undefined');
ok('walletAddress removed', typeof chain.walletAddress === 'undefined');
ok('swap removed', typeof chain.swap === 'undefined');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
process.exit(fails ? 1 : 0);
