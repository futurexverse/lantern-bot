/* =====================================================================
   LANTERN bot — market data (Node port of marketdata.js)
   DexScreener (search/info/boosts) + GeckoTerminal (new pools/OHLCV)
   + Jupiter Price API. All free, no keys, uses Node 18+ global fetch.
   ===================================================================== */

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const JUP = 'https://lite-api.jup.ag';
const CG = 'https://api.coingecko.com/api/v3';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const cache = new Map(); // url -> {t, data}
const inflight = new Map();

function jget(url, ttl = 25000) {
  const c = cache.get(url);
  if (c && Date.now() - c.t < ttl) return Promise.resolve(c.data);
  if (inflight.has(url)) return inflight.get(url);

  const p = fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    .then(async r => {
      if (!r.ok) {
        const err = new Error('HTTP ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json();
    })
    .then(d => { cache.set(url, { t: Date.now(), data: d }); inflight.delete(url); return d; })
    .catch(e => { inflight.delete(url); throw e; });

  inflight.set(url, p);
  return p;
}

/* ---------------- normalizers ---------------- */

function ageHours(createdMs) {
  if (!createdMs) return null;
  return Math.max(0, (Date.now() - createdMs) / 36e5);
}

export function normPair(p) {
  if (!p) return null;
  const info = p.info || {};
  const socials = (info.socials || []).map(s => ({ type: (s.type || '').toLowerCase(), url: s.url }));
  const sites = (info.websites || []).map(w => w.url).filter(Boolean);
  const tx = p.transactions || {};
  return {
    chainId: p.chainId || 'solana',
    dexId: p.dexId || '',
    mint: (p.baseToken && p.baseToken.address) || '',
    symbol: String((p.baseToken && p.baseToken.symbol) || '?').trim() || '?',
    name: String((p.baseToken && p.baseToken.name) || (p.baseToken && p.baseToken.symbol) || 'Token').trim() || 'Token',
    image: info.imageUrl || null,
    price: p.priceUsd ? parseFloat(p.priceUsd) : null,
    change: {
      m5: p.priceChange?.m5 ?? null,
      h1: p.priceChange?.h1 ?? null,
      h6: p.priceChange?.h6 ?? null,
      h24: p.priceChange?.h24 ?? null
    },
    vol24: p.volume?.h24 ?? null,
    liq: p.liquidity?.usd ?? null,
    mcap: p.marketCap ?? p.fdv ?? null,
    fdv: p.fdv ?? null,
    buys24: tx.h24 ? tx.h24.buys : null,
    sells24: tx.h24 ? tx.h24.sells : null,
    pairAddress: p.pairAddress || '',
    pairCreatedAt: p.pairCreatedAt || null,
    ageH: ageHours(p.pairCreatedAt),
    url: p.url || (p.pairAddress ? 'https://dexscreener.com/solana/' + p.pairAddress : ''),
    socials, websites: sites
  };
}

function pickBest(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const sol = pairs.filter(p => p.chainId === 'solana');
  const pool = sol.length ? sol : pairs;
  pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return pool[0];
}

/* ---------------- public API ---------------- */

/** Search tokens by name/ticker/address (DexScreener). */
export function search(q, limit = 12) {
  q = String(q || '').trim();
  if (!q) return Promise.resolve([]);
  return jget(DS + '/latest/dex/search?q=' + encodeURIComponent(q), 20000)
    .then(d => (d.pairs || [])
      .filter(p => p.chainId === 'solana')
      .map(normPair)
      .filter(Boolean)
      .sort((a, b) => (b.liq || 0) - (a.liq || 0))
      .slice(0, limit))
    .catch(() => []);
}

/** Full info for one token by mint, aggregated across every pool. */
export function tokenInfo(mint) {
  mint = String(mint || '').trim();
  if (!mint) return Promise.resolve(null);
  return jget(DS + '/tokens/v1/solana/' + mint, 30000)
    .then(arr => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const sol = arr.filter(p => p.chainId === 'solana');
      const pool = sol.length ? sol : arr;
      const best = normPair(pickBest(pool));
      if (!best) return null;

      let vol = 0, buys = 0, sells = 0, liq = 0, hasFlow = false;
      let changeSrc = null;
      pool.forEach(p => {
        vol += p.volume?.h24 || 0;
        liq += p.liquidity?.usd || 0;
        if (p.transactions?.h24) {
          hasFlow = true;
          buys += p.transactions.h24.buys || 0;
          sells += p.transactions.h24.sells || 0;
        }
        if (!changeSrc && p.priceChange?.h24 != null) changeSrc = p.priceChange;
      });
      if (vol > 0) best.vol24 = vol;
      if (liq > (best.liq || 0)) best.liq = liq;
      if (hasFlow) { best.buys24 = buys; best.sells24 = sells; }
      if (best.change.h24 == null && changeSrc) {
        best.change = { m5: changeSrc.m5, h1: changeSrc.h1, h6: changeSrc.h6, h24: changeSrc.h24 };
      }
      return best;
    })
    .catch(e => { if (e.status === 404) return null; return null; });
}

/** Batch info for up to 30 mints. Returns {mint: pair}. */
export function infoBatch(mints) {
  mints = Array.from(new Set((mints || []).filter(Boolean))).slice(0, 30);
  if (!mints.length) return Promise.resolve({});
  return jget(DS + '/tokens/v1/solana/' + mints.join(','), 30000).then(arr => {
    const out = {};
    (arr || []).forEach(p => {
      const n = normPair(p);
      if (!n) return;
      const cur = out[n.mint];
      if (!cur || (n.liq || 0) > (cur.liq || 0)) out[n.mint] = n;
    });
    return out;
  }).catch(() => ({}));
}

/** DexScreener boosted (promoted) tokens — a real trending signal. */
export function boosted(limit = 12) {
  return jget(DS + '/token-boosts/latest/v1', 30000).then(arr =>
    (arr || [])
      .filter(t => (t.chainId || 'solana') === 'solana' && t.tokenAddress)
      .slice(0, limit)
      .map(t => ({
        mint: t.tokenAddress,
        symbol: String(t.symbol || '').trim(),
        name: String(t.projectName || t.description || '').trim(),
        image: t.icon || null,
        url: t.url || ('https://dexscreener.com/solana/' + t.tokenAddress),
        boost: t.amount || 1
      }))
  ).catch(() => []);
}

/** Trending tokens hydrated with real market stats. */
export function trending(limit = 8) {
  return boosted(limit + 6).then(list => {
    const seen = {};
    list = list.filter(t => t.mint && !seen[t.mint] && (seen[t.mint] = 1));
    if (list.length < 4) {
      return search('solana', limit + 6).then(found => found.map(f => ({
        mint: f.mint, symbol: f.symbol, name: f.name, image: f.image, url: f.url, boost: 0, info: f
      })));
    }
    return infoBatch(list.map(l => l.mint)).then(map =>
      list.filter(l => map[l.mint]).slice(0, limit)
        .map(l => Object.assign({}, l, { info: map[l.mint] }))
    );
  }).catch(() => []);
}

/** Fresh pools on Solana (GeckoTerminal) — real new-launch feed. */
export function newPools(limit = 10) {
  return jget(GT + '/networks/solana/new_pools?page=1', 30000).then(d => {
    const out = [];
    (d.data || []).forEach(p => {
      const a = p.attributes || {};
      const rel = p.relationships || {};
      const baseId = (rel.base_token && rel.base_token.data && rel.base_token.data.id) || '';
      const mint = baseId.startsWith('solana_') ? baseId.slice(7) : '';
      const poolId = p.id || '';
      const poolAddr = poolId.includes('_') ? poolId.split('_').slice(1).join('_') : poolId;
      const bt = a.base_token || {};
      out.push({
        mint,
        poolId: poolAddr,
        name: String(bt.name || a.name || '').trim(),
        symbol: String(bt.symbol || '').trim(),
        image: bt.image_url || null,
        liq: a.reserve_in_usd ? parseFloat(a.reserve_in_usd) : null,
        vol24: a.volume_usd?.h24 ? parseFloat(a.volume_usd.h24) : null,
        createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
        ageH: a.pool_created_at ? ageHours(Date.parse(a.pool_created_at)) : null,
        dex: a.dex_id || ''
      });
    });
    return out.slice(0, limit);
  }).catch(() => []);
}

/** OHLCV candles for a pool: [{t,o,h,l,c,v}] sorted ascending. */
export function ohlcv(pool, tf = 'hour', limit = 60, aggregate = 1) {
  if (!pool) return Promise.resolve([]);
  const n = Math.min(1000, limit);
  const agg = Math.max(1, aggregate);
  const url = GT + '/networks/solana/pools/' + encodeURIComponent(pool) + '/ohlcv/' +
    tf + '?aggregate=' + agg + '&limit=' + n + '&currency=usd';
  return jget(url, 45000).then(d => {
    const rows = d.data?.attributes?.ohlcv_list || [];
    return rows.map(r => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }))
      .sort((a, b) => a.t - b.t);
  }).catch(() => []);
}

/** Jupiter Price API v3 — {mint: {usd, liquidity}} */
export function prices(mints) {
  mints = Array.from(new Set((mints || []).filter(Boolean))).slice(0, 90);
  if (!mints.length) return Promise.resolve({});
  return jget(JUP + '/price/v3?ids=' + mints.join(','), 20000).then(d => {
    const out = {};
    Object.keys(d || {}).forEach(k => {
      const v = d[k];
      const p = v && (v.usdPrice != null ? v.usdPrice : (v.price != null ? v.price : null));
      out[k] = { usd: p, liquidity: v && v.liquidity != null ? v.liquidity : null };
    });
    return out;
  }).catch(() => ({}));
}

/** Native SOL circulating supply + market cap (CoinGecko). */
export function solSupply() {
  return jget(CG + '/coins/solana?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false', 60000)
    .then(j => {
      const md = j && j.market_data;
      if (!md) return null;
      return {
        circulating: md.circulating_supply ?? null,
        total: md.total_supply ?? null,
        mcap: md.market_cap?.usd ?? null,
        price: md.current_price ?? null
      };
    })
    .catch(() => null);
}

export function explorerToken(mint) {
  return 'https://solscan.io/token/' + mint;
}
export function explorerTx(sig) {
  return 'https://solscan.io/tx/' + sig;
}

export function clearCache() { cache.clear(); }
