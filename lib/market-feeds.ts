import { THRESHOLDS } from '@/analysis/signals';
import { formatPercent, formatRatio } from '@/lib/format';
import type { AssetSnapshot, BoardEntry, DiscoveryBoard, FieldPoint } from '@/types';

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

/** True for stablecoins and wrapped/staked derivatives, which say nothing about a move. */
export function isExcludedAsset(symbol: string): boolean {
  return EXCLUDED_SYMBOLS.has(symbol.toUpperCase());
}

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

/* ------------------------------------------------------------------ *
 * Move field + discovery boards
 *
 * Both are computed from the same cached top-100 pool as the tickers, so they
 * add no upstream requests. Every board states its exact screening rule and
 * every entry carries a number-backed reason, so nothing appears on a board
 * merely because it was present in an API response.
 * ------------------------------------------------------------------ */

/** Every eligible asset with both a 24h price change and a 24h volume change. */
export function buildMoveField(pool: AssetSnapshot[]): FieldPoint[] {
  return dedupeBySymbol(pool.filter(isEligible))
    .filter((asset) => asset.percentChange24h !== null && asset.volumeChange24h !== null)
    .map((asset) => ({
      id: asset.id,
      symbol: asset.symbol,
      name: asset.name,
      rank: asset.rank,
      price: asset.price,
      priceChange24h: asset.percentChange24h as number,
      volumeChange24h: asset.volumeChange24h as number,
      turnover: asset.volumeToMarketCap,
      marketCap: asset.marketCap
    }));
}

const BOARD_SIZE = 5;
const UNCONFIRMED_MIN_MOVE = 5;

function entry(asset: AssetSnapshot, reason: string): BoardEntry {
  return {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    rank: asset.rank,
    priceChange24h: asset.percentChange24h,
    reason
  };
}

export function buildDiscoveryBoards(pool: AssetSnapshot[]): DiscoveryBoard[] {
  const eligible = dedupeBySymbol(pool.filter(isEligible));
  const pct = (value: number | null) => formatPercent(value);

  const biggest = [...eligible]
    .filter((a) => Math.abs(a.percentChange24h ?? 0) >= THRESHOLDS.move.noise)
    .sort((a, b) => Math.abs(b.percentChange24h ?? 0) - Math.abs(a.percentChange24h ?? 0))
    .slice(0, BOARD_SIZE)
    .map((a) =>
      entry(
        a,
        a.volumeChange24h !== null
          ? `Volume ${pct(a.volumeChange24h)} vs the prior 24h`
          : `${formatRatio(a.volumeToMarketCap)} of market cap traded in 24h`
      )
    );

  const surge = eligible
    .filter((a) => (a.volumeChange24h ?? -Infinity) >= THRESHOLDS.volume.expanding)
    .sort((a, b) => (b.volumeChange24h ?? 0) - (a.volumeChange24h ?? 0))
    .slice(0, BOARD_SIZE)
    .map((a) => entry(a, `Volume ${pct(a.volumeChange24h)} vs the prior 24h`));

  const unconfirmed = eligible
    .filter(
      (a) =>
        Math.abs(a.percentChange24h ?? 0) >= UNCONFIRMED_MIN_MOVE &&
        a.volumeChange24h !== null &&
        a.volumeChange24h <= 0
    )
    .sort((a, b) => Math.abs(b.percentChange24h ?? 0) - Math.abs(a.percentChange24h ?? 0))
    .slice(0, BOARD_SIZE)
    .map((a) => entry(a, `Volume ${pct(a.volumeChange24h)} while price moved`));

  const turnover = eligible
    .filter((a) => (a.volumeToMarketCap ?? 0) >= THRESHOLDS.turnover.elevated)
    .sort((a, b) => (b.volumeToMarketCap ?? 0) - (a.volumeToMarketCap ?? 0))
    .slice(0, BOARD_SIZE)
    .map((a) => entry(a, `${formatRatio(a.volumeToMarketCap)} of market cap traded in 24h`));

  return [
    {
      key: 'biggest-moves',
      title: 'Largest moves',
      criterion: `Biggest absolute 24h price change, at least ${THRESHOLDS.move.noise}% either way.`,
      entries: biggest
    },
    {
      key: 'volume-surge',
      title: 'Volume surging',
      criterion: `24h volume at least ${THRESHOLDS.volume.expanding}% above the prior 24h, whatever price did.`,
      entries: surge
    },
    {
      key: 'unconfirmed-moves',
      title: 'Moving without volume',
      criterion: `Price moved ${UNCONFIRMED_MIN_MOVE}% or more either way while 24h volume did not rise — moves with less participation behind them.`,
      entries: unconfirmed
    },
    {
      key: 'heavy-turnover',
      title: 'Heavy turnover',
      criterion: `24h volume worth at least ${THRESHOLDS.turnover.elevated} of market cap — unusually active trading for the asset's size.`,
      entries: turnover
    }
  ];
}

/** Newest quote timestamp in the pool, so the UI can state how fresh the boards are. */
export function poolAsOf(pool: AssetSnapshot[]): string | null {
  let newest = 0;
  for (const asset of pool) {
    const t = asset.lastUpdated ? Date.parse(asset.lastUpdated) : NaN;
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest > 0 ? new Date(newest).toISOString() : null;
}
