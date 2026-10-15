import type { AssetSnapshot, Candle, HistoryRange, HistorySource, HistoryStatus } from '@/types';

/**
 * Pure helpers for verified price history. No network code lives here so the
 * identity and freshness rules can be tested directly.
 *
 * MOVING only draws a historical chart when the venue's latest close agrees
 * with the quote the analysis used. A ticker such as "ONE" can mean different
 * assets on different venues; a chart for the wrong asset would be worse than
 * no chart at all.
 */

export const HISTORY_RANGES: HistoryRange[] = ['1D', '7D', '30D'];

/** Maximum relative gap between the venue's last close and MOVING's quote. */
export const MAX_PRICE_GAP = 0.06;

export interface RangePlan {
  /** Candle width in seconds. */
  interval: number;
  /** Number of candles requested. */
  count: number;
}

export const COINBASE_PLAN: Record<HistoryRange, RangePlan> = {
  '1D': { interval: 900, count: 96 },
  '7D': { interval: 3600, count: 168 },
  '30D': { interval: 21_600, count: 120 }
};

export const GECKO_PLAN: Record<HistoryRange, RangePlan & { timeframe: 'minute' | 'hour' | 'day'; aggregate: number }> = {
  '1D': { interval: 900, count: 96, timeframe: 'minute', aggregate: 15 },
  '7D': { interval: 3600, count: 168, timeframe: 'hour', aggregate: 1 },
  '30D': { interval: 14_400, count: 180, timeframe: 'hour', aggregate: 4 }
};

/** DexScreener chain id → GeckoTerminal network id. Unknown chains get no history. */
const GECKO_NETWORKS: Record<string, string> = {
  solana: 'solana',
  ethereum: 'eth',
  bsc: 'bsc',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon_pos',
  avalanche: 'avax',
  sui: 'sui-network',
  ton: 'ton',
  tron: 'tron'
};

/** Pegged and wrapped assets: a history chart adds nothing and pegs mislead. */
const NO_HISTORY_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'PYUSD', 'USD1', 'WBTC', 'WETH', 'STETH']);

const PRODUCT = /^[A-Z0-9]{2,10}-USD$/;
const NETWORK = /^[a-z0-9_-]{2,32}$/;
const POOL = /^[A-Za-z0-9]{20,80}$/;

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === 'string' && (HISTORY_RANGES as string[]).includes(value);
}

/** Decides where history may be requested for an asset, or null if nowhere. */
export function historySourceFor(asset: AssetSnapshot): HistorySource | null {
  if (asset.price === null || asset.price <= 0) return null;

  if (asset.dataSource === 'DexScreener') {
    const detail = asset.dex;
    if (!detail?.pairAddress) return null;
    const network = GECKO_NETWORKS[detail.chainId.toLowerCase()];
    if (!network || !POOL.test(detail.pairAddress)) return null;
    return { provider: 'geckoterminal', network, pool: detail.pairAddress };
  }

  const symbol = asset.symbol.toUpperCase();
  if (NO_HISTORY_SYMBOLS.has(symbol)) return null;
  const product = `${symbol}-USD`;
  return PRODUCT.test(product) ? { provider: 'coinbase', product } : null;
}

/** Validates an untrusted source description from a query string. */
export function parseHistorySource(params: URLSearchParams): HistorySource | null {
  const provider = params.get('provider');
  if (provider === 'coinbase') {
    const product = params.get('product') ?? '';
    return PRODUCT.test(product) ? { provider, product } : null;
  }
  if (provider === 'geckoterminal') {
    const network = params.get('network') ?? '';
    const pool = params.get('pool') ?? '';
    return NETWORK.test(network) && POOL.test(pool) ? { provider, network, pool } : null;
  }
  return null;
}

export function historyQuery(source: HistorySource, range: HistoryRange, refPrice: number): string {
  const params = new URLSearchParams({ provider: source.provider, range, ref: String(refPrice) });
  if (source.provider === 'coinbase') params.set('product', source.product);
  else {
    params.set('network', source.network);
    params.set('pool', source.pool);
  }
  return params.toString();
}

/**
 * Coinbase Exchange rows are [time, low, high, open, close, volume(base)],
 * newest first. Volume is converted to approximate USD with the close.
 */
export function parseCoinbaseCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  const out: Candle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, l, h, o, c, v] = row.map(Number);
    if (![t, l, h, o, c].every(Number.isFinite) || c <= 0) continue;
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v * c : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** GeckoTerminal rows are [time, open, high, low, close, volume(USD)], newest first. */
export function parseGeckoCandles(raw: unknown): Candle[] {
  const list = (raw as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if (![t, o, h, l, c].every(Number.isFinite) || c <= 0) continue;
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface VerificationResult {
  status: HistoryStatus;
  priceGap: number | null;
}

/**
 * Identity + freshness gate.
 *   unavailable — too few candles to draw anything honest
 *   stale       — the newest candle is far older than the interval implies
 *   mismatch    — the venue's price disagrees with MOVING's quote
 *   verified    — safe to draw
 */
export function verifyHistory(
  candles: Candle[],
  refPrice: number | null,
  interval: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): VerificationResult {
  if (candles.length < 8) return { status: 'unavailable', priceGap: null };
  if (refPrice === null || !Number.isFinite(refPrice) || refPrice <= 0) return { status: 'unavailable', priceGap: null };

  const last = candles[candles.length - 1];
  const priceGap = Math.abs(last.c - refPrice) / refPrice;

  const maxAge = Math.max(interval * 3, 3 * 3600);
  if (nowSeconds - last.t > maxAge) return { status: 'stale', priceGap };
  if (priceGap > MAX_PRICE_GAP) return { status: 'mismatch', priceGap };
  return { status: 'verified', priceGap };
}

export interface CandleSummary {
  first: number;
  last: number;
  high: number;
  low: number;
  changePct: number;
  totalVolume: number | null;
}

export function summarizeCandles(candles: Candle[]): CandleSummary | null {
  if (candles.length === 0) return null;
  const first = candles[0].o;
  const last = candles[candles.length - 1].c;
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let hasVolume = false;
  for (const candle of candles) {
    high = Math.max(high, candle.h);
    low = Math.min(low, candle.l);
    if (candle.v !== null) {
      volume += candle.v;
      hasVolume = true;
    }
  }
  return {
    first,
    last,
    high,
    low,
    changePct: first > 0 ? ((last - first) / first) * 100 : 0,
    totalVolume: hasVolume ? volume : null
  };
}

export function venueLabel(source: HistorySource): string {
  return source.provider === 'coinbase' ? `Coinbase ${source.product}` : `GeckoTerminal pool on ${source.network}`;
}

export function venueUrl(source: HistorySource): string {
  return source.provider === 'coinbase'
    ? `https://www.coinbase.com/advanced-trade/spot/${encodeURIComponent(source.product)}`
    : `https://www.geckoterminal.com/${encodeURIComponent(source.network)}/pools/${encodeURIComponent(source.pool)}`;
}
