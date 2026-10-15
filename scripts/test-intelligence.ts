/**
 * Offline tests for the redesign's data layer:
 *   lib/history.ts        verified price history (identity + freshness gate)
 *   lib/asset-search.ts   autocomplete ranking
 *   lib/market-feeds.ts   move field + discovery boards
 *   lib/freshness.ts      quote freshness labels
 *   analysis/evidence.ts  evidence ledger (presentation only)
 *   services/dexscreener  pool detail normalization
 * No network, no API credits.
 */

import { analyze } from '@/analysis/engine';
import { buildEvidence } from '@/analysis/evidence';
import { rankSuggestions } from '@/lib/asset-search';
import { classifyFreshness } from '@/lib/freshness';
import {
  historySourceFor,
  parseCoinbaseCandles,
  parseGeckoCandles,
  parseHistorySource,
  summarizeCandles,
  verifyHistory
} from '@/lib/history';
import { buildDiscoveryBoards, buildMoveField, poolAsOf } from '@/lib/market-feeds';
import { normalizeDexPair } from '@/services/dexscreener';
import type { AssetSnapshot, Candle, CmcMapItem } from '@/types';

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
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
    percentChange1h: 0.2,
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
    numMarketPairs: 200,
    currency: 'USD',
    lastUpdated: null,
    dataSource: 'CoinMarketCap',
    ...overrides
  };
}

/* ---------------- history: source selection ---------------- */
{
  assert('CMC asset → Coinbase product', JSON.stringify(historySourceFor(coin({ id: 1, symbol: 'SOL', price: 100 }))) === JSON.stringify({ provider: 'coinbase', product: 'SOL-USD' }));
  assert('stablecoin gets no history', historySourceFor(coin({ id: 2, symbol: 'USDT' })) === null);
  assert('no price → no history', historySourceFor(coin({ id: 3, symbol: 'ABC', price: null })) === null);
  assert('odd ticker rejected', historySourceFor(coin({ id: 4, symbol: 'A.B' })) === null);

  const dexAsset = coin({
    id: 5,
    symbol: 'BONK',
    price: 0.00002,
    dataSource: 'DexScreener',
    dex: {
      chainId: 'solana',
      dexId: 'raydium',
      pairAddress: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      quoteSymbol: 'SOL',
      liquidityUsd: 1,
      pairCreatedAt: null,
      priceChange: { m5: null, h1: null, h6: null, h24: null },
      volume: { m5: null, h1: null, h6: null, h24: null },
      txns: { h1: null, h24: null }
    }
  });
  const src = historySourceFor(dexAsset);
  assert('Dex asset → GeckoTerminal pool', src?.provider === 'geckoterminal' && src.network === 'solana');
  assert('unknown chain → no history', historySourceFor({ ...dexAsset, dex: { ...dexAsset.dex!, chainId: 'mystery' } }) === null);
}

/* ---------------- history: untrusted query parsing ---------------- */
{
  assert('valid coinbase params', parseHistorySource(new URLSearchParams('provider=coinbase&product=BTC-USD'))?.provider === 'coinbase');
  assert('lowercase product rejected', parseHistorySource(new URLSearchParams('provider=coinbase&product=btc-usd')) === null);
  assert('path traversal rejected', parseHistorySource(new URLSearchParams('provider=coinbase&product=../../x')) === null);
  assert('bad pool rejected', parseHistorySource(new URLSearchParams('provider=geckoterminal&network=solana&pool=abc/def')) === null);
  assert('unknown provider rejected', parseHistorySource(new URLSearchParams('provider=evil')) === null);
}

/* ---------------- history: parsing ---------------- */
{
  const cb = parseCoinbaseCandles([
    [2000, 9, 11, 10, 10.5, 100],
    [1000, 8, 10, 9, 9.5, 50],
    ['bad'],
    [3000, 1, 1, 1, 0, 1]
  ]);
  assert('coinbase: sorted ascending, invalid rows dropped', cb.length === 2 && cb[0].t === 1000 && cb[1].t === 2000);
  assert('coinbase: field order (low/high/open/close)', cb[1].l === 9 && cb[1].h === 11 && cb[1].o === 10 && cb[1].c === 10.5);
  assert('coinbase: volume converted to USD', cb[1].v === 100 * 10.5);
  assert('coinbase: garbage payload → []', parseCoinbaseCandles({ message: 'NotFound' }).length === 0);

  const gt = parseGeckoCandles({ data: { attributes: { ohlcv_list: [[2000, 1, 2, 0.5, 1.5, 999], [1000, 1, 1, 1, 1, 5]] } } });
  assert('gecko: parsed + ascending', gt.length === 2 && gt[0].t === 1000 && gt[1].c === 1.5 && gt[1].v === 999);
  assert('gecko: garbage payload → []', parseGeckoCandles(null).length === 0);
}

/* ---------------- history: identity + freshness gate ---------------- */
{
  const now = 1_800_000_000;
  const series = (lastClose: number, lastT = now - 600): Candle[] =>
    Array.from({ length: 20 }, (_, i) => ({ t: lastT - (19 - i) * 900, o: 1, h: 2, l: 0.5, c: i === 19 ? lastClose : 1, v: 1 }));

  assert('verified when close matches quote', verifyHistory(series(100), 101, 900, now).status === 'verified');
  assert('mismatch when venue price differs >6%', verifyHistory(series(100), 120, 900, now).status === 'mismatch');
  assert('stale when last candle is old', verifyHistory(series(100, now - 86_400), 100, 900, now).status === 'stale');
  assert('unavailable with too few candles', verifyHistory(series(100).slice(0, 3), 100, 900, now).status === 'unavailable');
  assert('unavailable without a reference price', verifyHistory(series(100), null, 900, now).status === 'unavailable');

  const summary = summarizeCandles([
    { t: 1, o: 10, h: 12, l: 9, c: 11, v: 5 },
    { t: 2, o: 11, h: 15, l: 10, c: 14, v: null }
  ]);
  assert('summary: change from first open to last close', summary !== null && Math.abs(summary.changePct - 40) < 1e-9);
  assert('summary: range high/low', summary?.high === 15 && summary?.low === 9);
}

/* ---------------- autocomplete ranking ---------------- */
{
  const dir: CmcMapItem[] = [
    { id: 1, name: 'Bitcoin', symbol: 'BTC', slug: 'bitcoin', rank: 1, is_active: 1, platform: null },
    { id: 2, name: 'Solana', symbol: 'SOL', slug: 'solana', rank: 7, is_active: 1, platform: null },
    { id: 3, name: 'Solar Token', symbol: 'SOLAR', slug: 'solar', rank: 900, is_active: 1, platform: null },
    { id: 4, name: 'Pepe', symbol: 'PEPE', slug: 'pepe', rank: 30, is_active: 1, platform: null },
    { id: 5, name: 'Pepe Classic', symbol: 'PEPE', slug: 'pepe-classic', rank: 2000, is_active: 1, platform: null },
    { id: 6, name: 'Dead Sol', symbol: 'SOLD', slug: 'dead-sol', rank: 50, is_active: 0, platform: null }
  ];
  const sol = rankSuggestions('sol', dir);
  assert('exact ticker ranks first', sol[0]?.symbol === 'SOL');
  assert('prefix match included', sol.some((s) => s.symbol === 'SOLAR'));
  assert('inactive assets excluded', !sol.some((s) => s.id === 6));

  const pepe = rankSuggestions('pepe', dir);
  assert('ticker collision: best rank first', pepe[0]?.id === 4);
  assert('best-ranked collision submits ticker', pepe[0]?.query === 'PEPE');
  assert('lower-ranked collision submits name', pepe.find((s) => s.id === 5)?.query === 'Pepe Classic');
  assert('empty query → []', rankSuggestions('   ', dir).length === 0);
  assert('limit respected', rankSuggestions('o', dir, 2).length <= 2);
}

/* ---------------- move field + discovery boards ---------------- */
{
  const pool = [
    coin({ id: 1, symbol: 'AAA', percentChange24h: 18, volumeChange24h: 150, volumeToMarketCap: 0.2, lastUpdated: '2026-10-15T10:00:00Z' }),
    coin({ id: 2, symbol: 'BBB', percentChange24h: -12, volumeChange24h: -20, volumeToMarketCap: 0.03, lastUpdated: '2026-10-15T10:05:00Z' }),
    coin({ id: 3, symbol: 'CCC', percentChange24h: 0.5, volumeChange24h: 400, volumeToMarketCap: 0.4 }),
    coin({ id: 4, symbol: 'USDT', percentChange24h: 0.01, volumeChange24h: 5 }),
    coin({ id: 5, symbol: 'DDD', percentChange24h: 3, volumeChange24h: null })
  ];
  const field = buildMoveField(pool);
  assert('field excludes stablecoins', !field.some((p) => p.symbol === 'USDT'));
  assert('field excludes missing volume change', !field.some((p) => p.symbol === 'DDD'));
  assert('field has the rest', field.length === 3);

  const boards = buildDiscoveryBoards(pool);
  const byKey = Object.fromEntries(boards.map((b) => [b.key, b]));
  assert('four boards, each with a criterion', boards.length === 4 && boards.every((b) => b.criterion.length > 20));
  assert('largest moves ordered by |change|', byKey['biggest-moves'].entries[0]?.symbol === 'AAA' && byKey['biggest-moves'].entries[1]?.symbol === 'BBB');
  assert('largest moves skip quiet assets', !byKey['biggest-moves'].entries.some((e) => e.symbol === 'CCC'));
  assert('volume surge requires ≥100%', byKey['volume-surge'].entries.map((e) => e.symbol).join() === 'CCC,AAA');
  assert('moving without volume: price ≥5% and volume ≤0', byKey['unconfirmed-moves'].entries.map((e) => e.symbol).join() === 'BBB');
  assert('heavy turnover ≥0.15', byKey['heavy-turnover'].entries.map((e) => e.symbol).join() === 'CCC,AAA');
  assert('every entry explains itself with a number', boards.every((b) => b.entries.every((e) => /\d/.test(e.reason))));
  assert('empty pool → empty boards, not invented entries', buildDiscoveryBoards([]).every((b) => b.entries.length === 0));
  assert('asOf is the newest quote', poolAsOf(pool) === '2026-10-15T10:05:00.000Z');
  assert('asOf null without timestamps', poolAsOf([coin({ id: 9, symbol: 'Z' })]) === null);
}

/* ---------------- freshness ---------------- */
{
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert('fresh within 5 min', classifyFreshness('2026-10-15T11:57:00Z', now) === 'fresh');
  assert('delayed within 1h', classifyFreshness('2026-10-15T11:20:00Z', now) === 'delayed');
  assert('stale beyond 1h', classifyFreshness('2026-10-15T09:00:00Z', now) === 'stale');
  assert('null → unknown, never "now"', classifyFreshness(null, now) === 'unknown');
  assert('garbage → unknown', classifyFreshness('not a date', now) === 'unknown');
}

/* ---------------- evidence ledger ---------------- */
{
  const up = coin({ id: 1, symbol: 'UPV', percentChange1h: 1, percentChange24h: 15, percentChange7d: 20, volumeChange24h: 180, volumeToMarketCap: 0.2 });
  const upAnalysis = analyze(up);
  const ev = buildEvidence(up, upAnalysis);
  assert('evidence does not change the engine', JSON.stringify(analyze(up)) === JSON.stringify(upAnalysis));
  assert('volume-backed rise is supporting', ev.supporting.some((t) => t.includes('Volume rose')));
  assert('observed facts carry reported numbers', ev.observed.some((f) => f.label === 'Price, 24h' && f.value === '+15%'));
  assert('outside-data list is always present', ev.outsideData.length >= 4);
  assert('invalidation text present', ev.invalidation.length > 20);

  const thin = coin({ id: 2, symbol: 'THN', percentChange1h: -1, percentChange24h: 12, percentChange7d: -5, volumeChange24h: -30, volumeToMarketCap: 0.004, numMarketPairs: 4 });
  const thinEv = buildEvidence(thin, analyze(thin));
  assert('unbacked rise is opposing', thinEv.opposing.some((t) => t.includes('not backed')));
  assert('thin pairs opposing', thinEv.opposing.some((t) => t.includes('market pairs')));
  assert('hourly reversal opposing', thinEv.opposing.some((t) => t.includes('last hour')));

  const flat = coin({ id: 4, symbol: 'FLT', percentChange1h: 0.1, percentChange24h: 1, percentChange7d: 2, volumeChange24h: 180, volumeToMarketCap: 0.06 });
  const flatAnalysis = analyze(flat);
  const flatEv = buildEvidence(flat, flatAnalysis);
  assert('flat + rising activity: engine picks rising-activity', flatAnalysis.primary.key === 'rising-activity');
  assert('flat + rising activity: volume build-up is supporting, not opposing', flatEv.supporting.some((t) => t.includes('build-up')) && !flatEv.opposing.some((t) => t.includes('Volume is up')));

  const missing = coin({ id: 3, symbol: 'MIS', volumeChange24h: null });
  const missingEv = buildEvidence(missing, analyze(missing));
  assert('missing metrics disclosed', missingEv.opposing.some((t) => t.startsWith('Not reported')));
  assert('missing volume → no fabricated volume fact', !missingEv.observed.some((f) => f.label === 'Volume vs prior 24h'));
}

/* ---------------- DexScreener pool detail ---------------- */
{
  const asset = normalizeDexPair({
    chainId: 'solana',
    dexId: 'raydium',
    url: 'https://dexscreener.com/solana/pool',
    pairAddress: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    baseToken: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'Bonk', symbol: 'BONK' },
    quoteToken: { symbol: 'SOL' },
    priceUsd: '0.00002',
    txns: { h1: { buys: 10, sells: 5 }, h24: { buys: 300, sells: 200 } },
    volume: { m5: 1, h1: 10, h6: 60, h24: 240 },
    priceChange: { m5: 0.1, h1: 1, h6: -2, h24: 5 },
    liquidity: { usd: 123_456 },
    marketCap: 1_000_000,
    pairCreatedAt: 1_700_000_000_000
  });
  assert('dex detail attached', asset.dex?.liquidityUsd === 123_456 && asset.dex?.quoteSymbol === 'SOL');
  assert('dex windows mapped', asset.dex?.priceChange.h6 === -2 && asset.dex?.volume.m5 === 1);
  assert('dex txns mapped', asset.dex?.txns.h24?.buys === 300 && asset.dex?.txns.h1?.sells === 5);
  assert('pool created timestamp', asset.dex?.pairCreatedAt === new Date(1_700_000_000_000).toISOString());
  assert('quote time still not invented', asset.lastUpdated === null);

  const bad = normalizeDexPair({
    chainId: 'solana',
    pairAddress: 'bad/address',
    baseToken: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'Bonk', symbol: 'BONK' },
    txns: { h24: { buys: -1, sells: 3 } },
    pairCreatedAt: 99
  });
  assert('unsafe pool address dropped', bad.dex?.pairAddress === null);
  assert('invalid txn counts dropped', bad.dex?.txns.h24 === null);
  assert('implausible creation date dropped', bad.dex?.pairCreatedAt === null);
}

console.log(`Intelligence data layer: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
