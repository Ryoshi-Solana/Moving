/**
 * Scenario tests for the analysis engine.
 *
 *   npm run test:analysis
 *
 * Runs on plain Node (>=22) via type stripping — no test framework needed.
 * Each case asserts the driver key the engine should pick, so tuning a
 * threshold in analysis/signals.ts shows up here immediately.
 */

import { analyze } from '@/analysis/engine';
import type { AssetSnapshot } from '@/types';

function asset(overrides: Partial<AssetSnapshot>): AssetSnapshot {
  const base: AssetSnapshot = {
    id: 1,
    name: 'Test Coin',
    symbol: 'TEST',
    slug: 'test-coin',
    rank: 50,
    logoUrl: null,
    category: 'token',
    chain: null,
    primaryContract: null,
    contracts: [],
    websiteUrl: null,
    price: 1,
    percentChange1h: 0,
    percentChange24h: 0,
    percentChange7d: 0,
    percentChange30d: 0,
    marketCap: 1_000_000_000,
    fullyDilutedMarketCap: null,
    marketCapDominance: null,
    marketCapChange24h: 0,
    marketCapChangeIsDerived: true,
    volume24h: 50_000_000,
    volumeChange24h: 0,
    volumeToMarketCap: 0.05,
    circulatingSupply: 1_000_000_000,
    totalSupply: 1_000_000_000,
    maxSupply: null,
    numMarketPairs: 120,
    currency: 'USD',
    lastUpdated: new Date().toISOString()
  };
  const merged = { ...base, ...overrides };
  if (merged.marketCap && merged.volume24h && overrides.volumeToMarketCap === undefined) {
    merged.volumeToMarketCap = merged.volume24h / merged.marketCap;
  }
  if (overrides.marketCapChange24h === undefined) {
    merged.marketCapChange24h = merged.percentChange24h;
  }
  return merged;
}

interface Case {
  name: string;
  input: AssetSnapshot;
  expectPrimary: string;
  expectStructure?: string;
}

const cases: Case[] = [
  {
    name: 'A — price up, volume up much more (the PEPE case)',
    input: asset({
      symbol: 'PEPE',
      price: 0.0000124,
      percentChange1h: 1.2,
      percentChange24h: 27.4,
      percentChange7d: 38.1,
      volume24h: 2_100_000_000,
      marketCap: 5_000_000_000,
      volumeChange24h: 184.6
    }),
    expectPrimary: 'volume-expansion',
    expectStructure: 'Healthy momentum'
  },
  {
    name: 'B — price up hard, volume flat',
    input: asset({
      percentChange24h: 18,
      percentChange7d: 4,
      volumeChange24h: 3,
      volume24h: 12_000_000,
      marketCap: 900_000_000,
      numMarketPairs: 9
    }),
    expectPrimary: 'thin-liquidity-momentum',
    expectStructure: 'Unconfirmed momentum'
  },
  {
    name: 'C — price up, market cap up, very high turnover',
    input: asset({
      percentChange1h: 0.9,
      percentChange24h: 12,
      percentChange7d: 20,
      volume24h: 900_000_000,
      marketCap: 4_000_000_000,
      volumeChange24h: 60
    }),
    expectPrimary: 'broad-participation'
  },
  {
    name: 'D — price down, volume expanding',
    input: asset({
      percentChange1h: -1.4,
      percentChange24h: -14.2,
      percentChange7d: -9,
      volumeChange24h: 130,
      volume24h: 400_000_000,
      marketCap: 6_000_000_000
    }),
    expectPrimary: 'selling-pressure',
    expectStructure: 'Active distribution'
  },
  {
    name: 'E — extreme move, extreme turnover',
    input: asset({
      percentChange1h: 6,
      percentChange24h: 92,
      percentChange7d: 140,
      volume24h: 300_000_000,
      marketCap: 700_000_000,
      volumeChange24h: 620
    }),
    expectPrimary: 'speculative-activity',
    expectStructure: 'Reflexive and fast'
  },
  {
    name: 'F — tiny price move, huge volume increase',
    input: asset({
      percentChange1h: 0.1,
      percentChange24h: 1.1,
      percentChange7d: 2,
      volumeChange24h: 210,
      volume24h: 150_000_000,
      marketCap: 3_000_000_000
    }),
    expectPrimary: 'rising-activity'
  },
  {
    name: 'G — nothing happening',
    input: asset({
      percentChange1h: 0.1,
      percentChange24h: 0.4,
      percentChange7d: -1.2,
      volumeChange24h: 2,
      volume24h: 8_000_000,
      marketCap: 2_000_000_000
    }),
    expectPrimary: 'range-consolidation',
    expectStructure: 'Quiet consolidation'
  },
  {
    name: 'H — price down quietly',
    input: asset({
      percentChange1h: -0.3,
      percentChange24h: -7.5,
      percentChange7d: -5,
      volumeChange24h: -22,
      volume24h: 9_000_000,
      marketCap: 1_500_000_000
    }),
    expectPrimary: 'fading-interest',
    expectStructure: 'Quiet drawdown'
  },
  {
    name: 'I — volume change unavailable (missing data path)',
    input: asset({
      percentChange1h: null,
      percentChange24h: 9,
      percentChange7d: null,
      volumeChange24h: null,
      volume24h: 40_000_000,
      marketCap: 800_000_000
    }),
    expectPrimary: 'broad-participation'
  },
  {
    name: 'J — almost no data at all',
    input: asset({
      percentChange1h: null,
      percentChange24h: null,
      percentChange7d: null,
      percentChange30d: null,
      volumeChange24h: null,
      volume24h: null,
      marketCap: null,
      volumeToMarketCap: null,
      numMarketPairs: null
    }),
    expectPrimary: 'insufficient-signal'
  }
];

let failures = 0;

for (const testCase of cases) {
  const result = analyze(testCase.input);
  const okPrimary = result.primary.key === testCase.expectPrimary;
  const okStructure = !testCase.expectStructure || result.structure.title === testCase.expectStructure;
  const pass = okPrimary && okStructure;
  if (!pass) failures += 1;

  console.log(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name}`);
  console.log(`      primary   : ${result.primary.key} (${result.primary.score})${okPrimary ? '' : ` — expected ${testCase.expectPrimary}`}`);
  console.log(`      secondary : ${result.secondary ? `${result.secondary.key} (${result.secondary.score})` : 'none'}`);
  console.log(`      structure : ${result.structure.title}${okStructure ? '' : ` — expected ${testCase.expectStructure}`}`);
  console.log(`      confidence: ${result.confidence}${result.missing.length ? ` (missing: ${result.missing.join(', ')})` : ''}`);
  console.log(`      verdict   : ${result.verdict}`);
  console.log('');
}

console.log(failures === 0 ? `All ${cases.length} scenarios passed.` : `${failures} of ${cases.length} scenarios failed.`);
process.exit(failures === 0 ? 0 : 1);
