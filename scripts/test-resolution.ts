/**
 * Unit tests for the pure helpers behind asset resolution: input
 * classification/sanitization, CMC payload normalization, and display
 * formatting. No network — these test logic only.
 */

import { classifyInput, looksLikeSymbol, sanitizeQuery, slugify } from '@/lib/asset-input';
import { AppError } from '@/lib/errors';
import {
  formatCompactNumber,
  formatCompactUsd,
  formatPercent,
  formatPrice,
  formatRatio,
  impliedPriceDelta,
  relativeTime,
  signedPrice,
  truncateMiddle
} from '@/lib/format';
import { pickDiscoveryCards } from '@/lib/discovery-pick';
import { explorerFor, normalize, pickBest } from '@/services/normalize';
import type { AssetSnapshot, CmcInfoItem, CmcQuoteItem } from '@/types';

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

function assertEq<T>(label: string, actual: T, expected: T): void {
  assert(label, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function assertThrowsInvalid(label: string, fn: () => void): void {
  try {
    fn();
    assert(label, false, 'did not throw');
  } catch (err) {
    assert(label, err instanceof AppError && err.code === 'INVALID_INPUT', `threw ${String(err)}`);
  }
}

/* ---------------- classifyInput ---------------- */
assertEq('EVM address classified', classifyInput('0x1234567890abcdef1234567890abcdef12345678'), 'address');
assertEq('Solana-shaped address classified', classifyInput('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), 'address');
assertEq('Tron address classified', classifyInput('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'), 'address');
assertEq('Ticker classified as text', classifyInput('PEPE'), 'text');
assertEq('Coin name classified as text', classifyInput('Solana'), 'text');
assertEq('Dollar-prefixed ticker classified as text', classifyInput('$PEPE'), 'text');

/* ---------------- sanitizeQuery ---------------- */
assertEq('trims whitespace', sanitizeQuery('  BTC  '), 'BTC');
assertEq('collapses internal whitespace', sanitizeQuery('shiba   inu'), 'shiba inu');
assertThrowsInvalid('rejects empty string', () => sanitizeQuery(''));
assertThrowsInvalid('rejects whitespace-only string', () => sanitizeQuery('   '));
assertThrowsInvalid('rejects non-string input', () => sanitizeQuery(42 as unknown as string));
assertThrowsInvalid('rejects overlong input', () => sanitizeQuery('a'.repeat(65)));
assertThrowsInvalid('rejects script-injection-shaped input', () => sanitizeQuery('<script>alert(1)</script>'));
assert('allows apostrophe in name-shaped queries', (() => {
  try {
    sanitizeQuery("Trader's Coin");
    return true;
  } catch {
    return false;
  }
})());

/* ---------------- looksLikeSymbol / slugify ---------------- */
assertEq('short alnum looks like a symbol', looksLikeSymbol('PEPE'), true);
assertEq('long phrase does not look like a symbol', looksLikeSymbol('the sandbox metaverse'), false);
assertEq('slugify basic name', slugify('The Sandbox'), 'the-sandbox');
assertEq('slugify strips punctuation', slugify("Trader's Coin!"), 'trader-s-coin');
assertEq('slugify collapses repeated separators', slugify('Multi   Word   Name'), 'multi-word-name');

/* ---------------- formatPrice ---------------- */
assertEq('formats zero', formatPrice(0), '$0.00');
assertEq('formats null as em dash', formatPrice(null), '—');
assertEq('formats large price without excess decimals', formatPrice(65000.4), '$65,000.40');
assertEq('formats mid-range price to cents', formatPrice(1.5), '$1.50');
assertEq('formats sub-dollar price to four decimals', formatPrice(0.0234), '$0.0234');
assertEq('formats sub-cent price with significant digits (PEPE case)', formatPrice(0.0000124), '$0.0000124');
assertEq('trims trailing zeros on sub-cent price', formatPrice(0.00001), '$0.00001');

/* ---------------- formatCompactUsd / formatCompactNumber ---------------- */
assertEq('compact trillions', formatCompactUsd(1_500_000_000_000), '$1.5T');
assertEq('compact billions', formatCompactUsd(5_210_000_000), '$5.21B');
assertEq('compact millions trims a whole number', formatCompactUsd(184_000_000), '$184M');
assertEq('compact small value stays plain', formatCompactUsd(42.5), '$42.50');
assertEq('compact handles negative sign', formatCompactUsd(-2_000_000), '-$2M');
assertEq('compact number (no currency)', formatCompactNumber(420_690_000_000_000), '420.69T');

/* ---------------- formatPercent ---------------- */
assertEq('adds plus sign for positive', formatPercent(27.4), '+27.4%');
assertEq('keeps minus sign for negative', formatPercent(-14.2), '-14.2%');
assertEq('formats null as em dash', formatPercent(null), '—');
assertEq('drops decimal for large magnitude', formatPercent(184.6), '+184.6%');
assertEq('unsigned mode has no plus', formatPercent(27.4, { signed: false }), '27.4%');
assertEq('zero has no sign', formatPercent(0), '0%');

/* ---------------- formatRatio ---------------- */
assertEq('ratio under 1 shows 3 decimals', formatRatio(0.052), '0.052');
assertEq('ratio over 1 shows 2 decimals', formatRatio(2.5), '2.50');
assertEq('null ratio is em dash', formatRatio(null), '—');

/* ---------------- impliedPriceDelta / signedPrice ---------------- */
{
  const delta = impliedPriceDelta(100, 25); // was ~80, now 100
  assert('implied delta is positive and plausible', delta !== null && delta > 19 && delta < 21, String(delta));
  assertEq('signedPrice adds a plus', signedPrice(5), '+$5.00');
  assertEq('signedPrice adds a minus', signedPrice(-5), '-$5.00');
  assertEq('signedPrice null is em dash', signedPrice(null), '—');
}

/* ---------------- truncateMiddle ---------------- */
assertEq(
  'truncates a long contract address',
  truncateMiddle('0x1234567890abcdef1234567890abcdef12345678', 6, 4),
  '0x1234…5678'
);
assertEq('leaves short strings untouched', truncateMiddle('0xshort', 6, 4), '0xshort');

/* ---------------- relativeTime ---------------- */
assertEq('empty input yields empty string', relativeTime(null), '');
assert('recent timestamp reads in seconds', relativeTime(new Date().toISOString()).endsWith('s ago'));

/* ---------------- normalize() ---------------- */
function quoteItem(overrides: Partial<CmcQuoteItem> = {}): CmcQuoteItem {
  return {
    id: 24478,
    name: 'Pepe',
    symbol: 'PEPE',
    slug: 'pepe',
    cmc_rank: 28,
    num_market_pairs: 412,
    circulating_supply: 420_690_000_000_000,
    total_supply: 420_690_000_000_000,
    max_supply: null,
    platform: { name: 'Ethereum', symbol: 'ETH', token_address: '0xabc0000000000000000000000000000000dead' },
    last_updated: '2024-01-01T00:00:00.000Z',
    quote: {
      USD: {
        price: 0.0000124,
        volume_24h: 2_180_000_000,
        volume_change_24h: 184.6,
        percent_change_1h: 1.2,
        percent_change_24h: 27.4,
        percent_change_7d: 38.1,
        percent_change_30d: 52.3,
        market_cap: 5_210_000_000,
        market_cap_dominance: 0.18,
        fully_diluted_market_cap: 5_210_000_000,
        last_updated: '2024-01-01T00:00:00.000Z'
      }
    },
    ...overrides
  };
}

{
  const normalized = normalize(quoteItem(), null);
  assertEq('normalize keeps symbol', normalized.symbol, 'PEPE');
  assertEq('normalize keeps chain from platform', normalized.chain, 'Ethereum');
  assertEq('normalize sets primary contract address', normalized.primaryContract?.address, '0xabc0000000000000000000000000000000dead');
  assert('normalize computes volume/marketcap ratio', Math.abs((normalized.volumeToMarketCap ?? 0) - 2_180_000_000 / 5_210_000_000) < 1e-9);
  assertEq('normalize always nulls cexVolume24h (Basic plan has no split)', normalized.cexVolume24h, null);
  assertEq('normalize always nulls dexVolume24h (Basic plan has no split)', normalized.dexVolume24h, null);
  assertEq('normalize marks market cap change as derived', normalized.marketCapChangeIsDerived, true);
}

{
  const missingQuote = quoteItem({ quote: {} });
  let threw = false;
  try {
    normalize(missingQuote, null);
  } catch (err) {
    threw = err instanceof AppError && err.code === 'MISSING_DATA';
  }
  assert('normalize throws MISSING_DATA when USD quote is absent', threw);
}

{
  const info: CmcInfoItem = {
    id: 24478,
    name: 'Pepe',
    symbol: 'PEPE',
    slug: 'pepe',
    platform: null,
    urls: { website: ['https://pepe.vip'] }
  };
  const normalized = normalize(quoteItem(), info);
  assertEq('normalize reads website from info.urls', normalized.websiteUrl, 'https://pepe.vip');
}

/* ---------------- pickBest() ---------------- */
{
  const low = quoteItem({ id: 1, quote: { USD: { ...quoteItem().quote.USD, market_cap: 1_000, volume_24h: 10 } } });
  const high = quoteItem({ id: 2, quote: { USD: { ...quoteItem().quote.USD, market_cap: 9_000_000, volume_24h: 500_000 } } });
  const best = pickBest([low, high]);
  assertEq('pickBest prefers higher market cap', best?.id, 2);
  assertEq('pickBest returns null for empty list', pickBest([]), null);
}

/* ---------------- explorerFor() ---------------- */
assertEq('ethereum explorer link', explorerFor('Ethereum', '0xabc'), 'https://etherscan.io/token/0xabc');
assertEq('solana explorer link', explorerFor('Solana', 'ABC123'), 'https://solscan.io/token/ABC123');
assertEq('unknown platform has no explorer link', explorerFor('SomeNewChain', '0xabc'), null);
assertEq('null platform has no explorer link', explorerFor(null, '0xabc'), null);

/* ---------------- pickDiscoveryCards() ---------------- */
function coin(id: number, symbol: string): AssetSnapshot {
  return {
    id,
    name: symbol,
    symbol,
    slug: symbol.toLowerCase(),
    rank: id,
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
    marketCap: 1_000_000,
    fullyDilutedMarketCap: null,
    marketCapDominance: null,
    marketCapChange24h: 1,
    marketCapChangeIsDerived: true,
    volume24h: 1000,
    volumeChange24h: 1,
    volumeToMarketCap: 0.001,
    cexVolume24h: null,
    dexVolume24h: null,
    circulatingSupply: null,
    totalSupply: null,
    maxSupply: null,
    numMarketPairs: null,
    currency: 'USD',
    lastUpdated: null
  };
}

{
  const pool = Array.from({ length: 10 }, (_, i) => coin(i + 1, `C${i + 1}`));
  const picks = pickDiscoveryCards(pool, 3, 3);
  assert('discovery picks never include the current asset', !picks.some((p) => p.id === 3));
  assert('discovery picks contain no duplicates', new Set(picks.map((p) => p.id)).size === picks.length);
  assert('discovery picks respect the requested count', picks.length === 3);
}

{
  // Pool has only 4 eligible entries (5 total minus the current asset) and 3
  // of those 4 are "recent" — excluding all of them would leave just 1
  // candidate, below the requested count of 3, so recent ones must be let
  // back in rather than starving the footer down to 1 card.
  const pool = Array.from({ length: 5 }, (_, i) => coin(i + 1, `C${i + 1}`));
  const picks = pickDiscoveryCards(pool, 1, 3, ['C2', 'C3', 'C4']);
  assert('discovery falls back to recent picks when excluding them leaves too few candidates', picks.length === 3);
}

{
  // Plenty of non-recent candidates remain, so recent ones should be skipped.
  const pool = Array.from({ length: 10 }, (_, i) => coin(i + 1, `C${i + 1}`));
  const picks = pickDiscoveryCards(pool, 1, 3, ['C2', 'C3']);
  assert('discovery avoids recently-clicked assets when enough alternatives exist', !picks.some((p) => p.symbol === 'C2' || p.symbol === 'C3'));
}

{
  const pool = [coin(1, 'ONLY')];
  const picks = pickDiscoveryCards(pool, 2, 3);
  assert('discovery degrades gracefully when the pool has fewer entries than requested', picks.length === 1);
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
