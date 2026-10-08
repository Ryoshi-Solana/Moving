import 'server-only';

import { fetchGlobalMetrics, fetchQuotesById } from '@/services/coinmarketcap';
import { normalize } from '@/services/normalize';
import type { AssetSnapshot, GlobalSnapshot } from '@/types';

const BTC_ID = 1;

/**
 * BTC's own quote is the primary, always-fetchable "is the market moving"
 * signal — it is just another quote, so it costs nothing extra to trust.
 * Global totals are an optional enrichment layered on top: if the
 * global-metrics endpoint is unavailable on the current plan (401/403) or
 * fails for any other reason, BTC-based context still works on its own (see
 * definitions.ts, which gates CONTEXT questions on BTC only, never on
 * global). Fetched in parallel and independently swallowed so one failing
 * never blocks the other — this is the "do not make the feature set depend
 * on an endpoint that may not exist on the plan" rule from the spec.
 */
export async function getMarketContext(): Promise<{ btc: AssetSnapshot | null; global: GlobalSnapshot | null }> {
  const [btcResult, globalResult] = await Promise.allSettled([fetchBtcSnapshot(), fetchGlobalSnapshot()]);

  return {
    btc: btcResult.status === 'fulfilled' ? btcResult.value : null,
    global: globalResult.status === 'fulfilled' ? globalResult.value : null
  };
}

async function fetchBtcSnapshot(): Promise<AssetSnapshot | null> {
  try {
    const quote = await fetchQuotesById(BTC_ID);
    return normalize(quote, null);
  } catch {
    return null;
  }
}

async function fetchGlobalSnapshot(): Promise<GlobalSnapshot | null> {
  try {
    const metrics = await fetchGlobalMetrics();
    const usd = metrics.quote?.USD;
    if (!usd) return null;
    return {
      totalMarketCap: finite(usd.total_market_cap),
      totalVolume24h: finite(usd.total_volume_24h),
      btcDominance: finite(metrics.btc_dominance),
      marketCapChange24h: finite(usd.total_market_cap_yesterday_percentage_change ?? null)
    };
  } catch {
    return null;
  }
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
