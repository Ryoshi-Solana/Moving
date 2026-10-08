/**
 * Focused tests for lib/market-feeds.ts — the pure selection logic behind the
 * "Trending Coins" and "Top Gainers 24h" tickers. No network, no server-only
 * dependency: these test the ranking/filtering rules directly.
 */

import { activityScore, selectTopGainers, selectTrendingCoins } from '@/lib/market-feeds';
import type { AssetSnapshot } from '@/types';

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function coin(overrides: Partial<AssetSnapshot> & { id: number; symbol: string }): AssetSnapshot {
  return {
    name: overrides.symbol,
    slug: overrides.symbol.toLowerCase(),
    rank: overrides.id,
    logoUrl: null,
    category: null,
    chain: null,
    primaryContract: null,
    contracts: [],
    websiteUrl: null,
    price: 1,
    percentChange1h: 0,
    percentChange24h: 1,
    percentChange7d: 1,
    percentChange30d: 1,
    marketCap: 1_000_000_000,
    fullyDilutedMarketCap: null,
    marketCapDominance: null,
    marketCapChange24h: 1,
    marketCapChangeIsDerived: true,
    volume24h: 10_000_000,
    volumeChange24h: 1,
    volumeToMarketCap: 0.01,
    cexVolume24h: null,
    dexVolume24h: null,
    circulatingSupply: null,
    totalSupply: null,
    maxSupply: null,
    numMarketPairs: null,
    currency: 'USD',
    lastUpdated: null,
    ...overrides
  };
}

/* ---------------- activityScore() ---------------- */
{
  const bigMoveLowTurnover = coin({ id: 1, symbol: 'A', percentChange24h: 20, volumeToMarketCap: 0.01 });
  const smallMoveHighTurnover = coin({ id: 2, symbol: 'B', percentChange24h: 1, volumeToMarketCap: 0.3 });
  const quiet = coin({ id: 3, symbol: 'C', percentChange24h: 0.1, volumeToMarketCap: 0.005 });
  assert('activityScore rewards a big price move', activityScore(bigMoveLowTurnover) > activityScore(quiet));
  assert('activityScore rewards high turnover even with a small price move', activityScore(smallMoveHighTurnover) > activityScore(quiet));
  assert('activityScore combines both terms additively', Math.abs(activityScore(bigMoveLowTurnover) - (20 + 1)) < 1e-9);
}

/* ---------------- selectTrendingCoins() ---------------- */
{
  const pool = [
    coin({ id: 1, symbol: 'QUIET', percentChange24h: 0.2, volumeToMarketCap: 0.002 }),
    coin({ id: 2, symbol: 'MOVER', percentChange24h: 25, volumeToMarketCap: 0.15 }),
    coin({ id: 3, symbol: 'ACTIVE', percentChange24h: 2, volumeToMarketCap: 0.4 })
  ];
  const picks = selectTrendingCoins(pool, 10);
  assert('trending ranks the highest-activity coin first', picks[0]?.symbol === 'MOVER' || picks[0]?.symbol === 'ACTIVE');
  assert('trending includes every eligible coin when count exceeds pool size', picks.length === 3);
  assert('trending excludes the quietest coin when count is limited', selectTrendingCoins(pool, 2).every((p) => p.symbol !== 'QUIET'));
}

{
  const pool = Array.from({ length: 15 }, (_, i) => coin({ id: i + 1, symbol: `T${i + 1}`, percentChange24h: i, volumeToMarketCap: 0.01 * i }));
  assert('trending respects the requested count', selectTrendingCoins(pool, 10).length === 10);
}

/* ---------------- selectTopGainers() ---------------- */
{
  const pool = [
    coin({ id: 1, symbol: 'UP_BIG', percentChange24h: 42 }),
    coin({ id: 2, symbol: 'UP_SMALL', percentChange24h: 3 }),
    coin({ id: 3, symbol: 'DOWN', percentChange24h: -15 }),
    coin({ id: 4, symbol: 'FLAT', percentChange24h: 0 })
  ];
  const gainers = selectTopGainers(pool, 10);
  assert('gainers are sorted highest-first', gainers[0]?.symbol === 'UP_BIG' && gainers[1]?.symbol === 'UP_SMALL');
  assert('gainers never include a negative mover', !gainers.some((g) => g.symbol === 'DOWN'));
  assert('gainers never include a flat (0%) mover', !gainers.some((g) => g.symbol === 'FLAT'));
  assert('gainers list length matches only the actual positive movers', gainers.length === 2);
}

{
  const allNegative = [coin({ id: 1, symbol: 'A', percentChange24h: -5 }), coin({ id: 2, symbol: 'B', percentChange24h: -1 })];
  assert('gainers is empty (not padded with losers) when nothing is actually up', selectTopGainers(allNegative, 10).length === 0);
}

/* ---------------- stablecoin / wrapped-variant exclusion ---------------- */
{
  const pool = [
    coin({ id: 1, symbol: 'USDT', percentChange24h: 0.01, volumeToMarketCap: 0.5 }),
    coin({ id: 2, symbol: 'USDC', percentChange24h: 5, volumeToMarketCap: 0.5 }),
    coin({ id: 3, symbol: 'WBTC', percentChange24h: 8, volumeToMarketCap: 0.2 }),
    coin({ id: 4, symbol: 'STETH', percentChange24h: 6, volumeToMarketCap: 0.2 }),
    coin({ id: 5, symbol: 'REAL', percentChange24h: 7, volumeToMarketCap: 0.1 })
  ];
  const trending = selectTrendingCoins(pool, 10);
  const gainers = selectTopGainers(pool, 10);
  for (const excluded of ['USDT', 'USDC', 'WBTC', 'STETH']) {
    assert(`trending excludes ${excluded}`, !trending.some((c) => c.symbol === excluded));
    assert(`gainers excludes ${excluded}`, !gainers.some((c) => c.symbol === excluded));
  }
  assert('a genuine non-excluded coin still appears in trending', trending.some((c) => c.symbol === 'REAL'));
  assert('a genuine non-excluded coin still appears in gainers', gainers.some((c) => c.symbol === 'REAL'));
}

/* ---------------- duplicate-symbol avoidance ---------------- */
{
  const pool = [
    coin({ id: 1, symbol: 'DUP', percentChange24h: 10, volumeToMarketCap: 0.2 }),
    coin({ id: 2, symbol: 'DUP', percentChange24h: 9, volumeToMarketCap: 0.2 }), // same symbol, different id — e.g. a bridged duplicate
    coin({ id: 3, symbol: 'UNIQUE', percentChange24h: 8, volumeToMarketCap: 0.2 })
  ];
  const trending = selectTrendingCoins(pool, 10);
  const gainers = selectTopGainers(pool, 10);
  assert('trending never shows the same symbol twice', trending.filter((c) => c.symbol === 'DUP').length <= 1);
  assert('gainers never shows the same symbol twice', gainers.filter((c) => c.symbol === 'DUP').length <= 1);
  assert('the earlier (higher-ranked) duplicate is kept', trending.find((c) => c.symbol === 'DUP')?.id === 1);
}

/* ---------------- missing-data safety ---------------- */
{
  const pool = [
    coin({ id: 1, symbol: 'NODATA', percentChange24h: null, volume24h: null, volumeToMarketCap: null }),
    coin({ id: 2, symbol: 'GOOD', percentChange24h: 4 })
  ];
  assert('a coin with no usable data is excluded rather than crashing the ranking', !selectTrendingCoins(pool, 10).some((c) => c.symbol === 'NODATA'));
  assert('a coin with no usable data never appears in gainers', !selectTopGainers(pool, 10).some((c) => c.symbol === 'NODATA'));
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
