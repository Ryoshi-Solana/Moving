import type { AssetSnapshot } from '@/types';

/**
 * MOVING's own market-activity feeds ("Trending Coins" and "Top Gainers 24h"),
 * computed locally from a top-100-by-market-cap pool. This is NOT a claim
 * about CoinMarketCap's official "trending" ranking (that endpoint requires a
 * paid plan tier we don't have) — it's MOVING's own simple, transparent
 * activity read on the same data the "Done exploring?" discovery pool
 * already uses.
 */

/**
 * Major stablecoins and common wrapped/staked-derivative tickers, excluded
 * from both feeds. A small, explicit, readable list rather than a pattern-
 * matching heuristic — easy to verify, easy to extend, never a surprise.
 */
const EXCLUDED_SYMBOLS = new Set([
  // stablecoins
  'USDT',
  'USDC',
  'DAI',
  'BUSD',
  'TUSD',
  'USDP',
  'FDUSD',
  'USDE',
  'PYUSD',
  'GUSD',
  'FRAX',
  'LUSD',
  'USDD',
  'EURS',
  'USDJ',
  'SUSD',
  'USD1',
  // wrapped / staked / liquid-staking derivative variants
  'WBTC',
  'WETH',
  'WBNB',
  'WSTETH',
  'STETH',
  'RETH',
  'CBETH',
  'WEETH',
  'METH',
  'SFRXETH',
  'ANKRETH',
  'BETH',
  'WEETH'
]);

function isEligible(asset: AssetSnapshot): boolean {
  return (
    !EXCLUDED_SYMBOLS.has(asset.symbol.toUpperCase()) &&
    asset.percentChange24h !== null &&
    asset.volume24h !== null &&
    asset.marketCap !== null &&
    asset.marketCap > 0
  );
}

/** Keeps the first occurrence of each symbol — the pool is already sorted by
 * market cap descending, so "first" naturally means "higher ranked." */
function dedupeBySymbol(assets: AssetSnapshot[]): AssetSnapshot[] {
  const seen = new Set<string>();
  const out: AssetSnapshot[] = [];
  for (const asset of assets) {
    const key = asset.symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

/**
 * Simple, transparent activity score: today's absolute price move (in
 * percentage points) plus trading turnover (volume ÷ market cap, scaled to a
 * comparable magnitude). Coins that are both moving and seeing real trading
 * interest rank highest. Deliberately just two additive terms — not a
 * multi-factor weighted model — so the ranking stays easy to explain and
 * reason about.
 */
export function activityScore(asset: AssetSnapshot): number {
  const move = Math.abs(asset.percentChange24h ?? 0);
  const turnover = (asset.volumeToMarketCap ?? 0) * 100;
  return move + turnover;
}

/** MOVING's "Trending Coins" feed: highest activity score from the pool. */
export function selectTrendingCoins(pool: AssetSnapshot[], count = 10): AssetSnapshot[] {
  return dedupeBySymbol(pool.filter(isEligible))
    .sort((a, b) => activityScore(b) - activityScore(a))
    .slice(0, count);
}

/** "Top Gainers 24h": highest positive percent_change_24h from the pool.
 * Negative or flat movers never appear here, even if nothing else qualifies —
 * a "gainer" that isn't actually up would be misleading. */
export function selectTopGainers(pool: AssetSnapshot[], count = 10): AssetSnapshot[] {
  return dedupeBySymbol(pool.filter(isEligible))
    .filter((asset) => (asset.percentChange24h ?? 0) > 0)
    .sort((a, b) => (b.percentChange24h ?? 0) - (a.percentChange24h ?? 0))
    .slice(0, count);
}
