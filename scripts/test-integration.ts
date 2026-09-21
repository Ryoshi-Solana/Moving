/**
 * Integration tests for the CoinMarketCap client, resolver and error mapping.
 *
 *   npm test
 *
 * `fetch` is replaced with a mock CMC server that returns payloads in the exact
 * envelope shape the real API uses. This exercises the genuine code path —
 * cmcFetch, caching, resolution strategies, normalization, analysis — without
 * network access or API credits.
 */

import { analyze } from '@/analysis/engine';
import { sanitizeQuery } from '@/lib/asset-input';
import { cacheClear } from '@/lib/cache';
import { AppError } from '@/lib/errors';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveAsset } from '@/services/resolve-asset';
import type { CmcQuoteItem } from '@/types';

const API_KEY = 'unit-test-key-4f2b8c';
process.env.CMC_API_KEY = API_KEY;

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !detail ? '' : ` — ${detail}`}`);
}

/* ------------------------------------------------------------------ *
 * Mock CoinMarketCap
 * ------------------------------------------------------------------ */

interface RequestLog {
  path: string;
  params: Record<string, string>;
  apiKeyHeader: string | null;
  url: string;
}

const requests: RequestLog[] = [];
let networkDown = false;
let forceStatus: number | null = null;

function quote(overrides: Partial<CmcQuoteItem> & { id: number; name: string; symbol: string; slug: string }, usd: Record<string, number | null>): CmcQuoteItem {
  return {
    cmc_rank: 1,
    num_market_pairs: 200,
    circulating_supply: 1_000_000,
    total_supply: 1_000_000,
    max_supply: null,
    platform: null,
    last_updated: '2026-09-15T12:00:00.000Z',
    quote: {
      USD: {
        price: 1,
        volume_24h: 1_000_000,
        volume_change_24h: 0,
        percent_change_1h: 0,
        percent_change_24h: 0,
        percent_change_7d: 0,
        percent_change_30d: 0,
        market_cap: 10_000_000,
        market_cap_dominance: 0,
        fully_diluted_market_cap: 10_000_000,
        last_updated: '2026-09-15T12:00:00.000Z',
        ...usd
      }
    },
    ...overrides
  } as CmcQuoteItem;
}

const PEPE_ADDRESS = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

const QUOTES: Record<string, CmcQuoteItem> = {
  PEPE: quote(
    {
      id: 24478,
      name: 'Pepe',
      symbol: 'PEPE',
      slug: 'pepe',
      cmc_rank: 28,
      num_market_pairs: 412,
      circulating_supply: 420_690_000_000_000,
      total_supply: 420_690_000_000_000,
      platform: { id: 1027, name: 'Ethereum', symbol: 'ETH', token_address: PEPE_ADDRESS }
    },
    {
      price: 0.0000124,
      volume_24h: 2_180_000_000,
      volume_change_24h: 184.6,
      percent_change_1h: 1.2,
      percent_change_24h: 27.4,
      percent_change_7d: 38.1,
      market_cap: 5_210_000_000
    }
  ),
  BTC: quote(
    { id: 1, name: 'Bitcoin', symbol: 'BTC', slug: 'bitcoin', cmc_rank: 1, num_market_pairs: 11_800 },
    {
      price: 96_420.18,
      volume_24h: 38_000_000_000,
      volume_change_24h: -12.4,
      percent_change_1h: -0.2,
      percent_change_24h: -3.1,
      percent_change_7d: 2.4,
      market_cap: 1_910_000_000_000
    }
  ),
  SOL: quote(
    { id: 5426, name: 'Solana', symbol: 'SOL', slug: 'solana', cmc_rank: 5, num_market_pairs: 820 },
    {
      price: 214.55,
      volume_24h: 5_400_000_000,
      volume_change_24h: 46.2,
      percent_change_1h: 0.6,
      percent_change_24h: 6.8,
      percent_change_7d: 11.2,
      market_cap: 103_000_000_000
    }
  ),
  // An asset whose plan/liquidity leaves fields null.
  SPARSE: quote(
    { id: 9999, name: 'Sparse Token', symbol: 'SPARSE', slug: 'sparse-token', cmc_rank: null, num_market_pairs: 2 },
    {
      price: 0.42,
      volume_24h: null,
      volume_change_24h: null,
      percent_change_1h: null,
      percent_change_24h: 5.5,
      percent_change_7d: null,
      market_cap: null,
      fully_diluted_market_cap: null
    }
  )
};

const INFO: Record<string, unknown> = {
  '24478': {
    id: 24478,
    name: 'Pepe',
    symbol: 'PEPE',
    slug: 'pepe',
    category: 'token',
    logo: 'https://s2.coinmarketcap.com/static/img/coins/64x64/24478.png',
    platform: { id: 1027, name: 'Ethereum', symbol: 'ETH', token_address: PEPE_ADDRESS },
    urls: { website: ['https://www.pepe.vip/'] }
  },
  '1': { id: 1, name: 'Bitcoin', symbol: 'BTC', slug: 'bitcoin', category: 'coin', logo: 'https://s2.coinmarketcap.com/static/img/coins/64x64/1.png', platform: null, urls: { website: ['https://bitcoin.org/'] } },
  '5426': { id: 5426, name: 'Solana', symbol: 'SOL', slug: 'solana', category: 'coin', logo: 'https://s2.coinmarketcap.com/static/img/coins/64x64/5426.png', platform: null, urls: { website: ['https://solana.com/'] } },
  '9999': { id: 9999, name: 'Sparse Token', symbol: 'SPARSE', slug: 'sparse-token', platform: null }
};

function envelope(data: unknown, errorCode = 0, errorMessage: string | null = null) {
  return {
    status: { timestamp: '2026-09-15T12:00:00.000Z', error_code: errorCode, error_message: errorMessage, credit_count: 1 },
    data
  };
}

function notFound(message: string, status = 400): Response {
  return new Response(JSON.stringify(envelope(null, 400, message)), { status });
}

globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const params = Object.fromEntries(url.searchParams.entries());
  const headers = new Headers(init?.headers);

  requests.push({
    path: url.pathname,
    params,
    apiKeyHeader: headers.get('X-CMC_PRO_API_KEY'),
    url: url.toString()
  });

  if (networkDown) throw new TypeError('fetch failed');
  if (forceStatus === 401) return new Response(JSON.stringify(envelope(null, 1002, 'API key missing.')), { status: 401 });
  if (forceStatus === 429) return new Response(JSON.stringify(envelope(null, 1008, 'Minute rate limit reached.')), { status: 429 });
  if (forceStatus === 500) return new Response('upstream exploded', { status: 500 });

  if (url.pathname === '/v2/cryptocurrency/quotes/latest') {
    if (params.id) {
      const match = Object.values(QUOTES).find((item) => String(item.id) === params.id);
      if (!match) return notFound('No results found.');
      return new Response(JSON.stringify(envelope({ [params.id]: match })));
    }
    if (params.symbol) {
      const match = QUOTES[params.symbol.toUpperCase()];
      if (!match) return notFound('Invalid value for "symbol"');
      // v2 returns an array per symbol, since tickers collide.
      return new Response(JSON.stringify(envelope({ [params.symbol.toUpperCase()]: [match] })));
    }
    if (params.slug) {
      const match = Object.values(QUOTES).find((item) => item.slug === params.slug);
      if (!match) return notFound('No results found.');
      return new Response(JSON.stringify(envelope({ [String(match.id)]: match })));
    }
    return notFound('No lookup parameter.');
  }

  if (url.pathname === '/v2/cryptocurrency/info') {
    if (params.address) {
      if (params.address.toLowerCase() === PEPE_ADDRESS) {
        return new Response(JSON.stringify(envelope({ '24478': INFO['24478'] })));
      }
      return notFound('No results found.');
    }
    if (params.id && INFO[params.id]) {
      return new Response(JSON.stringify(envelope({ [params.id]: INFO[params.id] })));
    }
    return notFound('No results found.');
  }

  if (url.pathname === '/v1/cryptocurrency/map') {
    return new Response(
      JSON.stringify(
        envelope(
          Object.values(QUOTES).map((item) => ({
            id: item.id,
            name: item.name,
            symbol: item.symbol,
            slug: item.slug,
            rank: item.cmc_rank,
            is_active: 1,
            platform: item.platform
          }))
        )
      )
    );
  }

  return notFound('Unknown endpoint', 404);
}) as typeof fetch;

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function expectError(fn: () => Promise<unknown>): Promise<AppError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err : null;
  }
}

async function run(): Promise<void> {
  console.log('\nFull pipeline: search → CMC → analysis → diagnosis');

  for (const [query, expected] of [
    ['PEPE', 'PEPE'],
    ['btc', 'BTC'],
    ['SOL', 'SOL']
  ] as const) {
    cacheClear();
    const asset = await resolveAsset(sanitizeQuery(query));
    const analysis = analyze(asset);
    const ok =
      asset.symbol === expected &&
      asset.price !== null &&
      analysis.primary.title.length > 0 &&
      analysis.verdict.includes(expected) &&
      analysis.dataUsed.length > 0;
    check(`${query} resolves and produces a diagnosis`, ok, `${asset.symbol} / ${analysis.primary.key}`);
    console.log(`      → ${analysis.primary.key} | ${analysis.structure.title} | confidence ${analysis.confidence}`);
  }

  // Direction sanity: BTC is down on contracting volume, SOL up on expansion.
  cacheClear();
  const btc = analyze(await resolveAsset('BTC'));
  check('BTC (down, volume contracting) reads as a quiet drawdown', btc.structure.title === 'Quiet drawdown', btc.structure.title);
  cacheClear();
  const sol = analyze(await resolveAsset('SOL'));
  check('SOL (up, volume expanding) reads as healthy momentum', sol.structure.title === 'Healthy momentum', sol.structure.title);

  console.log('\nName and slug resolution');
  cacheClear();
  const bySlug = await resolveAsset(sanitizeQuery('Sparse Token'));
  check('multi-word name resolves via slug', bySlug.symbol === 'SPARSE', bySlug.symbol);
  check('slug lookup hit the slug parameter', requests.some((r) => r.params.slug === 'sparse-token'));

  console.log('\nContract address resolution');
  cacheClear();
  const byAddress = await resolveAsset(sanitizeQuery(PEPE_ADDRESS));
  check('EVM contract address resolves to the asset', byAddress.symbol === 'PEPE', byAddress.symbol);
  check('chain is identified from the payload', byAddress.chain === 'Ethereum', String(byAddress.chain));
  check('explorer link is built', byAddress.primaryContract?.explorerUrl?.includes('etherscan.io') === true);
  check('address lookup used info?address', requests.some((r) => r.path === '/v2/cryptocurrency/info' && r.params.address));

  console.log('\nError states');
  cacheClear();
  const unknown = await expectError(() => resolveAsset(sanitizeQuery('ZZQQNOTACOIN')));
  check('invalid ticker → NOT_FOUND', unknown?.code === 'NOT_FOUND', unknown?.code);
  check('invalid ticker message is the user-facing copy', unknown?.message === "We couldn't find this asset.", unknown?.message);

  cacheClear();
  const badContract = await expectError(() => resolveAsset('0x000000000000000000000000000000000000dead'));
  check('invalid contract → INVALID_CONTRACT', badContract?.code === 'INVALID_CONTRACT', badContract?.code);
  check(
    'invalid contract message is the user-facing copy',
    badContract?.message === "That doesn't appear to be a valid supported asset or contract address.",
    badContract?.message
  );

  cacheClear();
  forceStatus = 401;
  const unauthorized = await expectError(() => resolveAsset('BTC'));
  check('401 from CMC → CONFIG_ERROR', unauthorized?.code === 'CONFIG_ERROR', unauthorized?.code);
  check('401 never shows the user an auth problem', unauthorized?.message === 'Market data is temporarily unavailable. Please try again.');

  cacheClear();
  forceStatus = 429;
  const limited = await expectError(() => resolveAsset('BTC'));
  check('429 from CMC → RATE_LIMITED', limited?.code === 'RATE_LIMITED', limited?.code);
  check('429 message is the user-facing copy', limited?.message === 'Too many requests right now. Please try again shortly.');

  cacheClear();
  forceStatus = 500;
  const upstream = await expectError(() => resolveAsset('BTC'));
  check('500 from CMC → UPSTREAM_ERROR', upstream?.code === 'UPSTREAM_ERROR', upstream?.code);

  cacheClear();
  forceStatus = null;
  networkDown = true;
  const offline = await expectError(() => resolveAsset('BTC'));
  check('network failure → UPSTREAM_ERROR', offline?.code === 'UPSTREAM_ERROR', offline?.code);
  networkDown = false;

  console.log('\nMissing-data handling');
  cacheClear();
  const sparse = await resolveAsset('SPARSE');
  const sparseAnalysis = analyze(sparse);
  check('asset with null metrics still resolves', sparse.symbol === 'SPARSE');
  check('missing metrics are reported', sparseAnalysis.missing.length > 0, sparseAnalysis.missing.join(', '));
  check('confidence is downgraded', sparseAnalysis.confidence !== 'high', sparseAnalysis.confidence);
  check('a diagnosis is still produced', sparseAnalysis.verdict.length > 0);
  check('no NaN leaks into the output', !JSON.stringify(sparseAnalysis).includes('NaN'));

  console.log('\nAPI key handling');
  cacheClear();
  const keyAsset = await resolveAsset('PEPE');
  const serialized = JSON.stringify({ asset: keyAsset, analysis: analyze(keyAsset) });
  check('API key never appears in the response payload', !serialized.includes(API_KEY));
  check('API key is sent as a header, not a query parameter', requests.every((r) => !r.url.includes(API_KEY)));
  check('API key header is present on every upstream call', requests.every((r) => r.apiKeyHeader === API_KEY));

  const missingKey = process.env.CMC_API_KEY;
  delete process.env.CMC_API_KEY;
  cacheClear();
  const unconfigured = await expectError(() => resolveAsset('BTC'));
  check('missing key → CONFIG_ERROR, not a crash', unconfigured?.code === 'CONFIG_ERROR', unconfigured?.code);
  process.env.CMC_API_KEY = missingKey;

  console.log('\nCaching and rate limiting');
  cacheClear();
  requests.length = 0;
  await resolveAsset('PEPE');
  const firstCallCount = requests.length;
  await resolveAsset('PEPE');
  check('repeat search inside the TTL makes no extra upstream calls', requests.length === firstCallCount, `${firstCallCount} → ${requests.length}`);

  cacheClear();
  requests.length = 0;
  await Promise.all([resolveAsset('SOL'), resolveAsset('SOL'), resolveAsset('SOL')]);
  const quoteCalls = requests.filter((r) => r.path === '/v2/cryptocurrency/quotes/latest').length;
  check('concurrent identical searches collapse into one request', quoteCalls === 1, `${quoteCalls} quote calls`);

  const key = 'rate-test-ip';
  let allowed = 0;
  for (let i = 0; i < 25; i += 1) {
    if (checkRateLimit(key, 20).ok) allowed += 1;
  }
  check('rate limiter allows exactly the configured number', allowed === 20, String(allowed));
  check('rate limiter reports a retry delay', checkRateLimit(key, 20).retryAfterSeconds > 0);
  check('a different client is unaffected', checkRateLimit('other-ip', 20).ok);

  console.log(`\n${failures === 0 ? `All ${checks} checks passed.` : `${failures} of ${checks} checks failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void run();
