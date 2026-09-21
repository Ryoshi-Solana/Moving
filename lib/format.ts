/** Formatting helpers. Pure functions — safe on both server and client. */

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '$0.00';
  if (abs >= 1000) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return '$' + value.toFixed(2);
  if (abs >= 0.01) return '$' + value.toFixed(4);

  // Sub-cent assets (PEPE, BONK, SHIB…) need significant digits, not fixed
  // ones. Four significant digits, with trailing zeros trimmed so PEPE reads
  // $0.0000124 rather than $0.00001240.
  const leadingZeros = Math.floor(-Math.log10(abs));
  const decimals = Math.min(14, leadingZeros + 4);
  return '$' + trimTrailingZeros(value.toFixed(decimals));
}

function trimTrailingZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export function formatCompactUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${sign}$${trim(abs / size)}${suffix}`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${trim(abs / size)}${suffix}`;
  }
  return abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

export function formatPercent(value: number | null | undefined, opts: { signed?: boolean; digits?: number } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const digits = opts.digits ?? (Math.abs(value) >= 10 ? 1 : 2);
  const sign = opts.signed !== false && value > 0 ? '+' : '';
  // 620.0% reads worse than 620%; 184.6% keeps the precision that matters.
  const body = value.toFixed(digits).replace(/\.0$/, '');
  return `${sign}${body}%`;
}

export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(value >= 1 ? 2 : 3);
}

/** Absolute price delta implied by a percentage change. */
export function impliedPriceDelta(price: number | null, percentChange: number | null): number | null {
  if (price === null || percentChange === null) return null;
  const previous = price / (1 + percentChange / 100);
  if (!Number.isFinite(previous)) return null;
  return price - previous;
}

export function signedPrice(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  return sign + formatPrice(Math.abs(delta));
}

export function truncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
