import 'server-only';

import { fetchTopByMarketCap } from '@/services/coinmarketcap';
import { normalize } from '@/services/normalize';
import { selectTopGainers, selectTrendingCoins } from '@/lib/market-feeds';
import type { AssetSnapshot } from '@/types';

export interface MarketFeeds {
  trending: AssetSnapshot[] | null;
  gainers: AssetSnapshot[] | null;
}

/**
 * MOVING's own market-activity feeds ("Trending Coins" and "Top Gainers
 * 24h"), computed locally from the same top-100-by-market-cap pool the
 * "Done exploring?" discovery feature already fetches (services/discovery.ts,
 * via the shared fetchTopByMarketCap() cache) — so these tickers add no extra
 * CMC request beyond whatever the page already needed.
 *
 * CoinMarketCap's own trending/latest endpoint requires a Startup-tier-or-
 * higher plan and is not used here. "Trending Coins" is MOVING's own
 * locally-computed activity ranking (see lib/market-feeds.ts), not a claim
 * about official CMC trending data.
 *
 * Strictly best-effort: any failure returns both feeds as null rather than
 * throwing, so a data outage can never affect the core per-asset analysis —
 * the ticker component simply doesn't render.
 */
export async function getMarketFeeds(): Promise<MarketFeeds> {
  try {
    const quotes = await fetchTopByMarketCap(100);
    const pool = quotes.map((q) => normalize(q, null));
    return {
      trending: nullIfEmpty(selectTrendingCoins(pool)),
      gainers: nullIfEmpty(selectTopGainers(pool))
    };
  } catch {
    return { trending: null, gainers: null };
  }
}

function nullIfEmpty(list: AssetSnapshot[]): AssetSnapshot[] | null {
  return list.length > 0 ? list : null;
}
