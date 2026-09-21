/**
 * Tests for input handling and CMC payload normalization.
 *
 *   npm run test:resolution
 *
 * Uses recorded-shape CMC payloads rather than live calls, so it runs offline
 * and without spending API credits.
 */

import { classifyInput, looksLikeSymbol, sanitizeQuery, slugify } from '@/lib/asset-input';
import { formatCompactUsd, formatPercent, formatPrice, impliedPriceDelta, truncateMiddle } from '@/lib/format';
import { AppError } from '@/lib/errors';
import { explorerFor, normalize, pickBest } from '@/services/normalize';
import type { CmcInfoItem, CmcQuoteItem } from '@/types';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !detail ? '' : ` — ${detail}`}`);
}

/* ---------------- input classification ---------------- */

console.log('\nInput classification');
check('BTC is text', classifyInput('BTC') === 'text');
check('Shiba Inu is text', classifyInput('Shiba Inu') === 'text');
check('EVM address detected', classifyInput('0x6982508145454ce325ddbe47a25d4ec3d2311933') === 'address');
check('Checksummed EVM address detected', classifyInput('0x6982508145454Ce325dDbE47a25d4ec3d2311933') === 'address');
check('Solana mint detected', classifyInput('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263') === 'address');
check('Tron address detected', classifyInput('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t') === 'address');
check('Short hex is not an address', classifyInput('0x1234') === 'text');
check('looksLikeSymbol accepts $PEPE', looksLikeSymbol('$PEPE'));
check('looksLikeSymbol rejects a sentence', !looksLikeSymbol('why is btc up'));
check('slugify handles spaces', slugify('Shiba Inu') === 'shiba-inu', slugify('Shiba Inu'));

/* ---------------- input validation ---------------- */

console.log('\nInput validation');
check('trims and collapses whitespace', sanitizeQuery('  shiba   inu ') === 'shiba inu');
check('keeps an address intact', sanitizeQuery('0x6982508145454ce325ddbe47a25d4ec3d2311933').length === 42);
check('rejects empty', rejects(() => sanitizeQuery('   ')));
check('rejects non-string', rejects(() => sanitizeQuery(null)));
check('rejects overlong input', rejects(() => sanitizeQuery('x'.repeat(65))));
check('rejects angle brackets (XSS shape)', rejects(() => sanitizeQuery('<script>alert(1)</script>')));
check('rejects path traversal', rejects(() => sanitizeQuery('../../etc/passwd')));
check('rejects query injection', rejects(() => sanitizeQuery('BTC&convert=USD&aux=all')));

function rejects(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof AppError && err.code === 'INVALID_INPUT';
  }
}

/* ---------------- normalization ---------------- */

console.log('\nNormalization');

const pepeQuote: CmcQuoteItem = {
  id: 24478,
  name: 'Pepe',
  symbol: 'PEPE',
  slug: 'pepe',
  cmc_rank: 28,
  num_market_pairs: 412,
  circulating_supply: 420_690_000_000_000,
  total_supply: 420_690_000_000_000,
  max_supply: null,
  platform: { id: 1027, name: 'Ethereum', symbol: 'ETH', token_address: '0x6982508145454ce325ddbe47a25d4ec3d2311933' },
  last_updated: '2026-09-15T10:00:00.000Z',
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
      last_updated: '2026-09-15T10:00:00.000Z'
    }
  }
};

const pepeInfo: CmcInfoItem = {
  id: 24478,
  name: 'Pepe',
  symbol: 'PEPE',
  slug: 'pepe',
  category: 'token',
  logo: 'https://s2.coinmarketcap.com/static/img/coins/64x64/24478.png',
  platform: { id: 1027, name: 'Ethereum', symbol: 'ETH', token_address: '0x6982508145454ce325ddbe47a25d4ec3d2311933' },
  urls: { website: ['https://www.pepe.vip/'], explorer: ['https://etherscan.io/token/0x6982508145454ce325ddbe47a25d4ec3d2311933'] }
};

const pepe = normalize(pepeQuote, pepeInfo);
check('carries symbol', pepe.symbol === 'PEPE');
check('carries chain', pepe.chain === 'Ethereum');
check('extracts contract', pepe.primaryContract?.address === '0x6982508145454ce325ddbe47a25d4ec3d2311933');
check('builds explorer link', pepe.primaryContract?.explorerUrl === 'https://etherscan.io/token/0x6982508145454ce325ddbe47a25d4ec3d2311933');
check('computes turnover', Math.abs((pepe.volumeToMarketCap ?? 0) - 0.4184) < 0.001, String(pepe.volumeToMarketCap));
check('flags derived market cap change', pepe.marketCapChangeIsDerived && pepe.marketCapChange24h === 27.4);
check('picks website url', pepe.websiteUrl === 'https://www.pepe.vip/');

// A native coin with no platform and a plan that omits volume_change_24h.
const sparse: CmcQuoteItem = {
  ...pepeQuote,
  id: 1,
  name: 'Bitcoin',
  symbol: 'BTC',
  slug: 'bitcoin',
  platform: null,
  quote: {
    USD: {
      ...pepeQuote.quote.USD,
      volume_change_24h: null,
      percent_change_7d: null,
      market_cap: null,
      fully_diluted_market_cap: null
    }
  }
};
const btc = normalize(sparse, null);
check('handles null platform', btc.chain === null && btc.primaryContract === null);
check('handles missing volume change', btc.volumeChange24h === null);
check('turnover null without market cap', btc.volumeToMarketCap === null);
check('falls back to generated logo url', btc.logoUrl?.includes('/1.png') === true, String(btc.logoUrl));

// Garbage numbers from upstream must not leak into the UI.
const dirty: CmcQuoteItem = {
  ...pepeQuote,
  quote: { USD: { ...pepeQuote.quote.USD, price: Number.NaN, market_cap: Number.POSITIVE_INFINITY } }
};
const cleaned = normalize(dirty, null);
check('NaN price becomes null', cleaned.price === null);
check('Infinite market cap becomes null', cleaned.marketCap === null);

check('throws when the USD quote is absent', (() => {
  try {
    normalize({ ...pepeQuote, quote: {} }, null);
    return false;
  } catch (err) {
    return err instanceof AppError && err.code === 'MISSING_DATA';
  }
})());

/* ---------------- formatting ---------------- */

console.log('\nFormatting');
check('sub-cent price keeps significant digits', formatPrice(0.0000124) === '$0.0000124', formatPrice(0.0000124));
check('no trailing zeros on sub-cent prices', !/0$/.test(formatPrice(0.00001)) || formatPrice(0.00001) === '$0.00001', formatPrice(0.00001));
check('large price uses thousands separators', formatPrice(96420.18) === '$96,420.18', formatPrice(96420.18));
check('mid price uses two decimals', formatPrice(214.55) === '$214.55', formatPrice(214.55));
check('cent-range price uses four decimals', formatPrice(0.0425) === '$0.0425', formatPrice(0.0425));
check('null price renders as a dash', formatPrice(null) === '—');
check('NaN price renders as a dash', formatPrice(Number.NaN) === '—');
check('billions compact correctly', formatCompactUsd(5_210_000_000) === '$5.21B', formatCompactUsd(5_210_000_000));
check('trillions compact correctly', formatCompactUsd(1_910_000_000_000) === '$1.91T', formatCompactUsd(1_910_000_000_000));
check('null market cap renders as a dash', formatCompactUsd(null) === '—');
check('percent keeps one decimal when large', formatPercent(184.6) === '+184.6%', formatPercent(184.6));
check('percent drops a pointless .0', formatPercent(620) === '+620%', formatPercent(620));
check('negative percent keeps its sign', formatPercent(-3.12) === '-3.12%', formatPercent(-3.12));
check('null percent renders as a dash', formatPercent(null) === '—');
check('implied delta matches the percentage', Math.abs((impliedPriceDelta(127.4, 27.4) ?? 0) - 27.4) < 0.01, String(impliedPriceDelta(127.4, 27.4)));
check('implied delta is null without inputs', impliedPriceDelta(null, 12) === null);
check('address truncation keeps both ends', truncateMiddle('0x6982508145454ce325ddbe47a25d4ec3d2311933', 8, 6) === '0x698250…311933', truncateMiddle('0x6982508145454ce325ddbe47a25d4ec3d2311933', 8, 6));
check('short strings are not truncated', truncateMiddle('BTC') === 'BTC');

/* ---------------- explorers + ticker disambiguation ---------------- */

console.log('\nExplorers and ticker collisions');
check('solana explorer', explorerFor('Solana', 'abc') === 'https://solscan.io/token/abc');
check('bnb explorer', explorerFor('BNB Smart Chain (BEP20)', 'abc')?.startsWith('https://bscscan.com') === true);
check('unknown chain gets no link', explorerFor('Some New Chain', 'abc') === null);
check('null platform gets no link', explorerFor(null, 'abc') === null);

const impostor: CmcQuoteItem = {
  ...pepeQuote,
  id: 99999,
  cmc_rank: 4200,
  quote: { USD: { ...pepeQuote.quote.USD, market_cap: 12_000, volume_24h: 900 } }
};
check('prefers the real PEPE over an impostor', pickBest([impostor, pepeQuote])?.id === 24478);
check('returns null for an empty candidate list', pickBest([]) === null);

console.log(`\n${failures === 0 ? `All ${checks} checks passed.` : `${failures} of ${checks} checks failed.`}`);
process.exit(failures === 0 ? 0 : 1);
