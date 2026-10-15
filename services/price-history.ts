import 'server-only';

import { cached } from '@/lib/cache';
import {
  COINBASE_PLAN,
  GECKO_PLAN,
  parseCoinbaseCandles,
  parseGeckoCandles,
  venueLabel,
  venueUrl,
  verifyHistory
} from '@/lib/history';
import type { Candle, HistoryRange, HistoryResponse, HistorySource } from '@/types';

/**
 * Keyless historical candles for the investigation chart.
 *
 *   Coinbase Exchange  — public market-data endpoint, CMC-listed assets
 *   GeckoTerminal      — public pool OHLCV, DexScreener-resolved assets
 *
 * Both are free, need no credentials, and are only ever reached from the
 * server. Results are cached so repeated views of the same asset cost one
 * upstream request per range per cache window. Every failure degrades to
 * status "unavailable" — history never blocks the core analysis.
 */

const TIMEOUT_MS = 6_000;
const USER_AGENT = 'MOVING/1.0 (+https://www.whymoving.fun)';
const TTL: Record<HistoryRange, number> = { '1D': 120, '7D': 300, '30D': 900 };

export async function getHistory(source: HistorySource, range: HistoryRange, refPrice: number | null): Promise<HistoryResponse> {
  const plan = source.provider === 'coinbase' ? COINBASE_PLAN[range] : GECKO_PLAN[range];
  const base = {
    range,
    venue: venueLabel(source),
    interval: plan.interval,
    sourceUrl: venueUrl(source),
    fetchedAt: new Date().toISOString()
  };

  let candles: Candle[] = [];
  try {
    const key =
      source.provider === 'coinbase'
        ? `history:cb:${source.product}:${range}`
        : `history:gt:${source.network}:${source.pool}:${range}`;
    candles = await cached(key, TTL[range], () =>
      source.provider === 'coinbase' ? fetchCoinbase(source.product, range) : fetchGecko(source.network, source.pool, range)
    );
  } catch (err) {
    console.warn('[history] upstream unavailable', {
      provider: source.provider,
      range,
      detail: err instanceof Error ? err.message : String(err)
    });
    return { ...base, status: 'unavailable', candles: [], priceGap: null };
  }

  const verdict = verifyHistory(candles, refPrice, plan.interval);
  return {
    ...base,
    status: verdict.status,
    priceGap: verdict.priceGap,
    // Unverified candles are never sent to the browser.
    candles: verdict.status === 'verified' ? candles : []
  };
}

async function fetchCoinbase(product: string, range: HistoryRange): Promise<Candle[]> {
  const plan = COINBASE_PLAN[range];
  const end = Math.floor(Date.now() / 1000);
  const start = end - plan.interval * plan.count;
  const url =
    `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles` +
    `?granularity=${plan.interval}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store'
  });
  // 404 = the venue does not list this ticker. Not an error worth retrying.
  if (response.status === 404 || response.status === 400) return [];
  if (!response.ok) throw new Error(`Coinbase HTTP ${response.status}`);
  return parseCoinbaseCandles(await response.json());
}

async function fetchGecko(network: string, pool: string, range: HistoryRange): Promise<Candle[]> {
  const plan = GECKO_PLAN[range];
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pool)}` +
    `/ohlcv/${plan.timeframe}?aggregate=${plan.aggregate}&limit=${plan.count}&currency=usd`;
  const response = await fetch(url, {
    headers: { accept: 'application/json;version=20230302', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store'
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
  return parseGeckoCandles(await response.json());
}
