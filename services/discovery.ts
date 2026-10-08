import 'server-only';

import { fetchTopByMarketCap } from '@/services/coinmarketcap';
import { normalize } from '@/services/normalize';
import type { AssetSnapshot } from '@/types';

/**
 * Sampling pool for the "Done exploring?" footer: CMC's top 100 by market
 * cap, rather than raw 24h movers, so recommendations are always established,
 * liquid assets rather than tiny/thin tokens. The client (Investigation.tsx)
 * does the actual random 3-of-100 pick and session-based repeat-avoidance,
 * since only the browser knows what the visitor has already clicked this
 * session — this function's job is just to hand back a safe pool to sample
 * from.
 *
 * Strictly best-effort: any failure (wrong plan, rate limit, network) returns
 * null rather than throwing, so a discovery outage can never affect the core
 * per-asset analysis. The UI omits the footer entirely when this returns
 * null — never a dead button.
 */
export async function getDiscoveryPool(limit = 100): Promise<AssetSnapshot[] | null> {
  try {
    const quotes = await fetchTopByMarketCap(limit);
    const snapshots = quotes.map((q) => normalize(q, null)).filter((a) => a.marketCap !== null);
    return snapshots.length > 0 ? snapshots : null;
  } catch {
    return null;
  }
}
