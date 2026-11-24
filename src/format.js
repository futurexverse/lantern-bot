/* =====================================================================
   LANTERN bot — text/number formatting helpers
   ===================================================================== */

export function fmtUsd(n, dp) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(dp ?? 2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(dp ?? 2) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(dp ?? 1) + 'K';
  if (abs === 0) return '$0';
  if (abs < 0.01) return '$' + n.toPrecision(3);
  return '$' + n.toFixed(dp ?? 2);
}

export function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return '$' + n.toFixed(4);
  if (abs >= 0.0001) return '$' + n.toFixed(8).replace(/0+$/, '0');
  return '$' + n.toPrecision(4);
}

export function fmtTok(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  if (abs === 0) return '0';
  return n.toPrecision(4);
}

export function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '';
  return s + n.toFixed(2) + '%';
}

export function ageLabel(h) {
  if (h == null) return 'unknown';
  if (h < 1) return Math.round(h * 60) + 'm';
  if (h < 48) return Math.round(h) + 'h';
  return Math.round(h / 24) + 'd';
}

export function shortAddr(a, head = 6, tail = 5) {
  const s = String(a || '');
  return s.length > head + tail + 2 ? s.slice(0, head) + '…' + s.slice(-tail) : s;
}

/** "1.2m" / "350k" ago */
export function timeAgo(ms) {
  if (!ms) return '—';
  const d = Date.now() - ms;
  const min = Math.floor(d / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

/** Parse "0.5", "50%", "5000000", "1m", "2.5B" into a raw token amount. */
export function parseAmount(str, priceUsd) {
  const raw = String(str || '').trim();
  if (!raw) return null;
  const m = raw.match(/^([\d.]+)\s*([kmb])?$/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k') n *= 1e3;
  else if (suf === 'm') n *= 1e6;
  else if (suf === 'b') n *= 1e9;
  // bare number under 100 with a price → assume USD
  if (!suf && priceUsd && n < 100) return n / priceUsd;
  return n;
}

export function mdEscape(s) {
  return String(s == null ? '' : s).replace(/([_*`\[\]])/g, '\\$1');
}
