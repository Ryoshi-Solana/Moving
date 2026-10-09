/**
 * Integration tests against a mocked CoinMarketCap API.
 *
 * Exercises resolve-asset.ts end to end (symbol / slug / directory / address
 * paths) and, new for V1, services/context.ts and services/discovery.ts —
 * specifically that a 401/403/429/timeout/malformed response degrades to
 * null gracefully rather than throwing, since those two services must never
 * be able to break the core per-asset analysis.
 */

process.env.CMC_API_KEY = 'test-key';

import { cacheClear } from '@/lib/cache';
import { fetchQuotesById, fetchInfoById, resetCmcThrottle } from '@/services/coinmarketcap';
import { AppError } from '@/lib/errors';
import { resolveAsset } from '@/services/resolve-asset';
import { getMarketContext } from '@/services/context';
import { getDiscoveryPool } from '@/services/discovery';
import { getMarketFeeds } from '@/services/trending';

let passed = 0;
let failed = 0;
let dexPairsForTest: unknown[] = [];

function assert(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function assertRejectsWith(label: string, fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert(label, false, 'did not throw');
  } catch (err) {
    assert(label, err instanceof AppError && err.code === code, `threw ${String(err)}`);
  }
}

type Responder = (url: URL) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

function mockFetch(responder: Responder) {
  (globalThis as any).fetch = async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    // The secondary provider is isolated in these offline CMC tests. Dedicated
    // DexScreener tests replace fetch with their own representative fixture.
    const { status, body } = url.hostname === 'api.dexscreener.com'
      ? { status: 200, body: { pairs: dexPairsForTest } }
      : await responder(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    } as Response;
  };
}

function envelope(data: unknown, error_code = 0, error_message: string | null = null) {
  return { status: { timestamp: new Date().toISOString(), error_code, error_message }, data };
}

/**
 * v3 record shape: `quote` is an ARRAY of per-currency entries (each carrying
 * its own id/symbol) instead of the v2 `{ USD: {...} }` map.
 */
function v3Item(item: ReturnType<typeof pepeQuote>) {
  return { ...item, quote: [{ id: 2781, symbol: 'USD', ...item.quote.USD }] };
}

/** v3 `data` is a plain array of records (no symbol/id-keyed map). */
function quotesEnvelope(items: Array<ReturnType<typeof pepeQuote>>) {
  return envelope(items.map(v3Item));
}

function pepeQuote(id = 24478) {
  return {
    id,
    name: 'Pepe',
    symbol: 'PEPE',
    slug: 'pepe',
    cmc_rank: 28,
    num_market_pairs: 412,
    circulating_supply: 1,
    total_supply: 1,
    max_supply: null,
    platform: null,
    last_updated: '2024-01-01T00:00:00.000Z',
    quote: {
      USD: {
        price: 0.0000124,
        volume_24h: 2_000_000_000,
        volume_change_24h: 184.6,
        percent_change_1h: 1.2,
        percent_change_24h: 27.4,
        percent_change_7d: 38.1,
        percent_change_30d: 52.3,
        market_cap: 5_000_000_000,
        market_cap_dominance: 0.18,
        fully_diluted_market_cap: 5_000_000_000,
        last_updated: '2024-01-01T00:00:00.000Z'
      }
    }
  };
}

function btcQuote() {
  return {
    ...pepeQuote(1),
    name: 'Bitcoin',
    symbol: 'BTC',
    slug: 'bitcoin',
    quote: { USD: { ...pepeQuote().quote.USD, percent_change_24h: 2.1, price: 65000 } }
  };
}

/** Clears the response cache and the 429 cool-down between scenarios. */
function reset(): void {
  cacheClear();
  resetCmcThrottle();
}

async function run() {
  /* ---------------- resolve-asset.ts (regression) ---------------- */

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/quotes/latest')) {
      return { status: 200, body: quotesEnvelope([pepeQuote()]) };
    }
    return { status: 404, body: envelope(null, 400, 'no results') };
  });
  const bySymbol = await resolveAsset('PEPE');
  assert('resolves by exact symbol', bySymbol.symbol === 'PEPE');
  assert('CMC remains the primary source for a listed asset', bySymbol.dataSource === 'CoinMarketCap');

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/quotes/latest') && url.searchParams.get('symbol')) {
      return { status: 400, body: envelope(null, 400, 'no results') };
    }
    if (url.pathname.includes('/quotes/latest') && url.searchParams.get('slug')) {
      return { status: 200, body: quotesEnvelope([pepeQuote()]) };
    }
    return { status: 404, body: envelope(null, 400, 'no results') };
  });
  const bySlug = await resolveAsset('Pepe Coin Name Without Ticker Shape');
  assert('falls back to slug when symbol search is empty', bySlug.symbol === 'PEPE');

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/info') && url.searchParams.get('address')) {
      return {
        status: 200,
        body: envelope({
          '24478': { id: 24478, name: 'Pepe', symbol: 'PEPE', slug: 'pepe', platform: null, urls: {} }
        })
      };
    }
    if (url.pathname.includes('/quotes/latest')) {
      return { status: 200, body: quotesEnvelope([pepeQuote()]) };
    }
    return { status: 404, body: envelope(null, 400, 'not found') };
  });
  const byAddress = await resolveAsset('0xabc0000000000000000000000000000000dead');
  assert('resolves by contract address', byAddress.symbol === 'PEPE');

  reset();
  mockFetch(() => ({ status: 400, body: envelope(null, 400, 'no results') }));
  await assertRejectsWith('unresolvable text query throws NOT_FOUND', () => resolveAsset('zzzznotacoinzzzz'), 'NOT_FOUND');

  reset();
  mockFetch(() => ({ status: 400, body: envelope(null, 400, 'no results') }));
  await assertRejectsWith(
    'unresolvable address throws INVALID_CONTRACT',
    // A genuine 40-hex-char EVM-shaped address, so classifyInput correctly
    // routes this through resolveByAddress rather than the text path.
    () => resolveAsset('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead'),
    'INVALID_CONTRACT'
  );

  reset();
  mockFetch(() => ({ status: 429, body: envelope(null, 1008, 'rate limited') }));
  await assertRejectsWith('rate limit surfaces as RATE_LIMITED', () => resolveAsset('BTC'), 'RATE_LIMITED');

  reset();
  mockFetch(() => ({ status: 401, body: envelope(null, 1001, 'invalid key') }));
  await assertRejectsWith('bad API key surfaces as CONFIG_ERROR', () => resolveAsset('BTC'), 'CONFIG_ERROR');

  /* ---------------- services/context.ts (new) ---------------- */

  // NOTE: the real global-metrics endpoint path (/v1/global-metrics/quotes/latest)
  // contains "/quotes/latest" as a substring, so every mock below checks
  // '/global-metrics' BEFORE the generic '/quotes/latest' pattern used for
  // the BTC quote call — checking them in the other order would let the
  // global-metrics request be mis-routed to the BTC branch.

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/global-metrics')) {
      return {
        status: 200,
        body: {
          status: { timestamp: '', error_code: 0, error_message: null },
          data: { btc_dominance: 54.2, eth_dominance: 17.1, quote: { USD: { total_market_cap: 2_500_000_000_000, total_volume_24h: 90_000_000_000 } } }
        }
      };
    }
    if (url.pathname.includes('/quotes/latest')) return { status: 200, body: quotesEnvelope([btcQuote()]) };
    return { status: 500, body: {} };
  });
  {
    const ctx = await getMarketContext();
    assert('context: BTC resolves when both endpoints succeed', ctx.btc?.symbol === 'BTC');
    assert('context: global resolves when both endpoints succeed', ctx.global?.totalMarketCap === 2_500_000_000_000);
  }

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/global-metrics')) return { status: 403, body: envelope(null, 1002, 'plan does not include this endpoint') };
    if (url.pathname.includes('/quotes/latest')) return { status: 200, body: quotesEnvelope([btcQuote()]) };
    return { status: 500, body: {} };
  });
  {
    const ctx = await getMarketContext();
    assert('context: BTC still resolves when global-metrics 403s', ctx.btc?.symbol === 'BTC');
    assert('context: global is null (not thrown) on 403', ctx.global === null);
  }

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/global-metrics')) {
      return { status: 200, body: { status: { error_code: 0 }, data: { btc_dominance: 50, eth_dominance: 15, quote: { USD: { total_market_cap: 1, total_volume_24h: 1 } } } } };
    }
    if (url.pathname.includes('/quotes/latest')) return { status: 429, body: envelope(null, 1009, 'rate limited') };
    return { status: 500, body: {} };
  });
  {
    const ctx = await getMarketContext();
    assert('context: BTC is null (not thrown) on 429', ctx.btc === null);
    assert('context: global still resolves independently of BTC failing', ctx.global !== null);
  }

  reset();
  mockFetch(() => {
    throw new Error('simulated network failure');
  });
  {
    const ctx = await getMarketContext();
    assert('context: both null on total network failure, never throws', ctx.btc === null && ctx.global === null);
  }

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/global-metrics')) return { status: 200, body: { not: 'the expected shape' } };
    if (url.pathname.includes('/quotes/latest')) return { status: 200, body: quotesEnvelope([btcQuote()]) };
    return { status: 500, body: {} };
  });
  {
    const ctx = await getMarketContext();
    assert('context: malformed global-metrics payload degrades to null, not a crash', ctx.global === null);
    assert('context: BTC unaffected by malformed global payload', ctx.btc?.symbol === 'BTC');
  }

  /* ---------------- services/discovery.ts (top-100-by-market-cap pool) ---------------- */

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/listings/latest')) {
      assert('discovery pool requests sort=market_cap (not percent_change)', url.searchParams.get('sort') === 'market_cap');
      assert('discovery pool requests start=1', url.searchParams.get('start') === '1');
      return { status: 200, body: quotesEnvelope([pepeQuote(1), pepeQuote(2), pepeQuote(3)]) };
    }
    return { status: 500, body: {} };
  });
  {
    const pool = await getDiscoveryPool();
    assert('discovery pool: resolves a list on success', Array.isArray(pool) && pool!.length === 3);
  }

  reset();
  mockFetch(() => ({ status: 403, body: envelope(null, 1006, "your plan doesn't support this endpoint") }));
  {
    const pool = await getDiscoveryPool();
    assert('discovery pool: 403 (plan-gated endpoint) degrades to null, never throws', pool === null);
  }

  reset();
  mockFetch(() => ({ status: 401, body: envelope(null, 1001, 'invalid key') }));
  {
    const pool = await getDiscoveryPool();
    assert('discovery pool: 401 degrades to null', pool === null);
  }

  reset();
  mockFetch(() => ({ status: 429, body: envelope(null, 1008, 'rate limited') }));
  {
    const pool = await getDiscoveryPool();
    assert('discovery pool: 429 degrades to null', pool === null);
  }

  reset();
  mockFetch(() => {
    throw new Error('simulated timeout');
  });
  {
    const pool = await getDiscoveryPool();
    assert('discovery pool: network failure degrades to null, never throws', pool === null);
  }

  reset();
  mockFetch(() => ({ status: 200, body: envelope([]) }));
  {
    const pool = await getDiscoveryPool();
    assert('discovery pool: empty list normalizes to null (nothing to show)', pool === null);
  }

  /* ---------------- services/trending.ts (now sourced from listings/latest, not trending/latest) ---------------- */

  reset();
  mockFetch((url) => {
    if (url.pathname.includes('/listings/latest')) {
      return {
        status: 200,
        body: envelope([
          v3Item(pepeQuote(1)), // percent_change_24h: 27.4 — qualifies as both a mover and a gainer
          { ...pepeQuote(2), symbol: 'FLAT', quote: { USD: { ...pepeQuote().quote.USD, percent_change_24h: 0.1, volume_change_24h: 1 } } }
        ])
      };
    }
    return { status: 500, body: {} };
  });
  {
    const feeds = await getMarketFeeds();
    // The mock above only serves /listings/latest (anything else 500s), so a
    // non-empty result here is itself proof getMarketFeeds() no longer
    // depends on trending/latest at all.
    assert('market feeds: trending resolves a list, sourced only from listings/latest', Array.isArray(feeds.trending) && feeds.trending!.length > 0);
    assert('market feeds: gainers resolves a list, sourced only from listings/latest', Array.isArray(feeds.gainers) && feeds.gainers!.length > 0);
  }

  reset();
  mockFetch(() => ({ status: 403, body: envelope(null, 1002, "your plan doesn't include this endpoint") }));
  {
    const feeds = await getMarketFeeds();
    assert('market feeds: 403 degrades both feeds to null, never throws — page stays intact', feeds.trending === null && feeds.gainers === null);
  }

  reset();
  mockFetch(() => ({ status: 401, body: envelope(null, 1001, 'invalid key') }));
  {
    const feeds = await getMarketFeeds();
    assert('market feeds: 401 degrades to null', feeds.trending === null && feeds.gainers === null);
  }

  reset();
  mockFetch(() => ({ status: 429, body: envelope(null, 1008, 'rate limited') }));
  {
    const feeds = await getMarketFeeds();
    assert('market feeds: 429 degrades to null', feeds.trending === null && feeds.gainers === null);
  }

  reset();
  mockFetch(() => {
    throw new Error('simulated network failure');
  });
  {
    const feeds = await getMarketFeeds();
    assert('market feeds: network failure degrades to null, never throws', feeds.trending === null && feeds.gainers === null);
  }

  reset();
  mockFetch(() => ({ status: 200, body: envelope([]) }));
  {
    const feeds = await getMarketFeeds();
    assert('market feeds: empty pool normalizes to null for both feeds', feeds.trending === null && feeds.gainers === null);
  }

  /* ---------------- CMC v3 migration: endpoints, response shape, canonical assets ---------------- */

  // 1. Requests go to the supported v3 paths — never the deprecated v2 quotes / v1 listings.
  {
    const seen: string[] = [];
    reset();
    mockFetch((url) => {
      seen.push(url.pathname);
      if (url.pathname.includes('/listings/latest')) return { status: 200, body: quotesEnvelope([pepeQuote(1)]) };
      if (url.pathname.includes('/quotes/latest')) return { status: 200, body: quotesEnvelope([pepeQuote()]) };
      if (url.pathname.includes('/info')) return { status: 200, body: envelope({ '24478': { id: 24478, name: 'Pepe', symbol: 'PEPE', slug: 'pepe', platform: null, urls: {} } }) };
      return { status: 404, body: envelope(null, 400, 'no results') };
    });
    await resolveAsset('PEPE');
    await getDiscoveryPool();
    assert('v3: quotes use /v3/cryptocurrency/quotes/latest', seen.includes('/v3/cryptocurrency/quotes/latest'));
    assert('v3: listings use /v3/cryptocurrency/listings/latest', seen.includes('/v3/cryptocurrency/listings/latest'));
    assert('v3: no deprecated /v2 quotes or /v1 listings request', !seen.some((p) => p === '/v2/cryptocurrency/quotes/latest' || p === '/v1/cryptocurrency/listings/latest'));
  }

  // 2. v3 record + array-shaped quote normalizes into the stable AssetSnapshot.
  reset();
  mockFetch((url) => {
    if (url.pathname === '/v3/cryptocurrency/quotes/latest') return { status: 200, body: quotesEnvelope([pepeQuote()]) };
    return { status: 404, body: envelope(null, 400, 'no results') };
  });
  {
    const asset = await resolveAsset('PEPE');
    assert('v3: array-shaped quote yields price', asset.price === 0.0000124);
    assert('v3: array-shaped quote yields 24h change', asset.percentChange24h === 27.4);
    assert('v3: array-shaped quote yields market cap', asset.marketCap === 5_000_000_000);
  }

  // 3. Sparse v3 quote (no volume_change_24h / 30d / dominance) degrades to nulls, not a crash.
  reset();
  mockFetch((url) => {
    if (url.pathname === '/v3/cryptocurrency/quotes/latest') {
      return {
        status: 200,
        body: envelope([
          {
            id: 24478, name: 'Pepe', symbol: 'PEPE', slug: 'pepe', cmc_rank: 28, circulating_supply: 1, max_supply: null,
            last_updated: '2024-01-01T00:00:00.000Z',
            quote: [{ id: 2781, symbol: 'USD', price: 0.0000124, volume_24h: 2e9, percent_change_1h: 1.2, percent_change_24h: 27.4, percent_change_7d: 38.1, market_cap: 5e9 }]
          }
        ])
      };
    }
    return { status: 404, body: envelope(null, 400, 'no results') };
  });
  {
    const asset = await resolveAsset('PEPE');
    assert('v3: sparse quote still resolves', asset.symbol === 'PEPE' && asset.price === 0.0000124);
  }

  // 4. status.error_code may be the string "0".
  reset();
  mockFetch((url) => {
    if (url.pathname === '/v3/cryptocurrency/quotes/latest') {
      return { status: 200, body: { status: { timestamp: 'x', error_code: '0', error_message: null }, data: [v3Item(pepeQuote())] } };
    }
    return { status: 404, body: envelope(null, 400, 'no results') };
  });
  assert('v3: string error_code "0" is treated as success', (await resolveAsset('PEPE')).symbol === 'PEPE');

  // 5. A bare top-level array (no status wrapper) is accepted.
  reset();
  mockFetch((url) => {
    if (url.pathname === '/v3/cryptocurrency/quotes/latest') return { status: 200, body: [v3Item(pepeQuote())] };
    return { status: 404, body: envelope(null, 400, 'no results') };
  });
  assert('v3: unwrapped array response is accepted', (await resolveAsset('PEPE')).symbol === 'PEPE');

  // 6. A non-zero string error_code still maps to the right error.
  reset();
  mockFetch(() => ({ status: 200, body: { status: { timestamp: 'x', error_code: '1008', error_message: 'rate limited' }, data: null } }));
  await assertRejectsWith('v3: string error_code "1008" maps to RATE_LIMITED', () => resolveAsset('PEPE'), 'RATE_LIMITED');

  // 7. Legacy v2 symbol-keyed shape is still tolerated by the adapter.
  reset();
  mockFetch((url) => {
    if (url.pathname === '/v3/cryptocurrency/quotes/latest') return { status: 200, body: envelope({ PEPE: [pepeQuote()] }) };
    return { status: 404, body: envelope(null, 400, 'no results') };
  });
  assert('v3: legacy symbol-keyed payload still parses', (await resolveAsset('PEPE')).symbol === 'PEPE');

  // 8. Non-pinned ticker with a larger-market-cap duplicate in the legacy symbol path still picks highest cap.
  reset();
  mockFetch((url) => {
    if (url.pathname === '/v3/cryptocurrency/quotes/latest' && url.searchParams.get('symbol') === 'PEPE') {
      const small = { ...pepeQuote(777), name: 'Pepe Clone', quote: { USD: { ...pepeQuote().quote.USD, market_cap: 1000 } } };
      return { status: 200, body: quotesEnvelope([small, pepeQuote()]) };
    }
    return { status: 404, body: envelope(null, 400, 'no results') };
  });
  assert('legacy fallback: PEPE still picks the highest market cap', (await resolveAsset('PEPE')).id === 24478);

  /* ---------------- Request budget (Basic plan: 50 HTTP req/min) ---------------- */

  const DIRECTORY = [
    { id: 1, name: 'Bitcoin', symbol: 'BTC', slug: 'bitcoin', rank: 1, is_active: 1, platform: null },
    { id: 99991, name: 'Fake BTC', symbol: 'BTC', slug: 'fake-btc', rank: 4000, is_active: 1, platform: null },
    { id: 1027, name: 'Ethereum', symbol: 'ETH', slug: 'ethereum', rank: 2, is_active: 1, platform: null },
    { id: 1839, name: 'BNB', symbol: 'BNB', slug: 'bnb', rank: 4, is_active: 1, platform: null },
    { id: 99992, name: 'BNB Clone', symbol: 'BNB', slug: 'bnb-clone', rank: 3000, is_active: 1, platform: null },
    { id: 5426, name: 'Solana', symbol: 'SOL', slug: 'solana', rank: 6, is_active: 1, platform: null },
    { id: 24478, name: 'Pepe', symbol: 'PEPE', slug: 'pepe', rank: 28, is_active: 1, platform: null },
    { id: 22861, name: 'Celestia', symbol: 'TIA', slug: 'celestia', rank: 60, is_active: 1, platform: null },
    { id: 21159, name: 'Ondo', symbol: 'ONDO', slug: 'ondo-finance', rank: 55, is_active: 1, platform: null }
  ];

  const quoteById = (id: number) => {
    const row = DIRECTORY.find((d) => d.id === id)!;
    return { ...pepeQuote(id), name: row.name, symbol: row.symbol, slug: row.slug, cmc_rank: row.rank };
  };

  interface World {
    calls: string[];
    count: (needle: string) => number;
    quoteIds: () => string[];
  }

  /** Mock CMC that records every HTTP request. `latencyMs` makes concurrent callers overlap. */
  function world(options: { latencyMs?: number; quoteStatus?: number; mapStatus?: number } = {}): World {
    const calls: string[] = [];
    mockFetch(async (url) => {
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));

      if (url.pathname === '/v1/cryptocurrency/map') {
        if (options.mapStatus) return { status: options.mapStatus, body: envelope(null, 500, 'boom') };
        return { status: 200, body: envelope(DIRECTORY) };
      }
      if (url.pathname === '/v3/cryptocurrency/quotes/latest') {
        if (options.quoteStatus) return { status: options.quoteStatus, body: envelope(null, options.quoteStatus === 429 ? 1008 : 500, 'nope') };
        const id = url.searchParams.get('id');
        if (id && DIRECTORY.some((d) => d.id === Number(id))) return { status: 200, body: quotesEnvelope([quoteById(Number(id))]) };
        const symbol = url.searchParams.get('symbol');
        if (symbol === 'NEWCOIN') return { status: 200, body: quotesEnvelope([{ ...pepeQuote(31337), name: 'NewCoin', symbol: 'NEWCOIN', slug: 'newcoin' }]) };
        return { status: 400, body: envelope(null, 400, 'no results') };
      }
      if (url.pathname === '/v2/cryptocurrency/info') {
        const address = url.searchParams.get('address');
        const id = Number(url.searchParams.get('id'));
        if (address) return { status: 200, body: envelope({ '24478': { id: 24478, name: 'Pepe', symbol: 'PEPE', slug: 'pepe', platform: null, urls: {} } }) };
        return { status: 200, body: envelope({ [String(id)]: { id, name: 'x', symbol: 'X', slug: 'x', platform: null, urls: { website: ['https://example.org'] } } }) };
      }
      if (url.pathname.includes('/global-metrics')) {
        return { status: 200, body: envelope({ btc_dominance: 52, eth_dominance: 17, quote: { USD: { total_market_cap: 3e12, total_volume_24h: 1e11 } } }) };
      }
      if (url.pathname === '/v3/cryptocurrency/listings/latest') return { status: 200, body: quotesEnvelope([quoteById(1), quoteById(1027)]) };
      return { status: 404, body: envelope(null, 400, 'no results') };
    });
    return {
      calls,
      count: (needle) => calls.filter((c) => c.includes(needle)).length,
      quoteIds: () => calls.filter((c) => c.startsWith('/v3/cryptocurrency/quotes/latest')).map((c) => new URL('http://x/' + c.split('?')[1]).search)
    };
  }

  // A / B / C: pinned canonical assets cost exactly one quote request, by id — no map, symbol, or info call.
  for (const [ticker, id, name] of [['BTC', 1, 'Bitcoin'], ['ETH', 1027, 'Ethereum'], ['SOL', 5426, 'Solana']] as const) {
    reset();
    const w = world();
    const asset = await resolveAsset(ticker);
    assert(`budget: ${ticker} resolves to ${name} (id ${id})`, asset.id === id && asset.name === name);
    assert(`budget: ${ticker} makes exactly ONE HTTP request in total`, w.calls.length === 1, w.calls.join(' | '));
    assert(`budget: ${ticker} request is quotes?id=${id}`, w.calls[0]?.startsWith('/v3/cryptocurrency/quotes/latest?') === true && w.calls[0].includes(`id=${id}`));
    assert(`budget: ${ticker} never uses symbol= lookup`, w.count('symbol=') === 0);
  }

  reset();
  {
    const w = world();
    await resolveAsset('sol');
    assert('budget: lowercase "sol" also pins to Solana with one request', w.calls.length === 1 && w.calls[0].includes('id=5426'));
  }

  // D: arbitrary ticker -> id from the cached directory (highest-ranked active match) -> one quote-by-id.
  reset();
  {
    const w = world();
    const asset = await resolveAsset('BNB');
    assert('budget: BNB resolves via directory to the highest-ranked active BNB (id 1839)', asset.id === 1839);
    assert('budget: BNB makes one map call and exactly one quote call', w.count('/v1/cryptocurrency/map') === 1 && w.count('/quotes/latest') === 1, w.calls.join(' | '));
    assert('budget: BNB quote is by id, not symbol', w.count('id=1839') === 1 && w.count('symbol=') === 0);
    assert('budget: no info request on a normal analysis', w.count('/info') === 0);

    // F: second request inside the TTL hits no endpoint at all (map + quote cached).
    const before = w.calls.length;
    await resolveAsset('BNB');
    await resolveAsset('TIA');
    assert('cache: repeat BNB within TTL makes no CMC call', w.calls.slice(before).filter((c) => c.includes('id=1839')).length === 0);
    assert('cache: a different ticker reuses the cached directory (no 2nd map call)', w.count('/v1/cryptocurrency/map') === 1);
    assert('budget: TIA costs exactly one more request (its quote by id 22861)', w.calls.length === before + 1 && w.count('id=22861') === 1, w.calls.slice(before).join(' | '));
  }

  reset();
  {
    const w = world();
    const byName = await resolveAsset('Celestia');
    const byTicker = await resolveAsset('ondo');
    assert('budget: names and tickers resolve through the same cached directory', byName.id === 22861 && byTicker.id === 21159 && w.count('/v1/cryptocurrency/map') === 1);
    assert('budget: name/ticker lookups never call symbol= or slug=', w.count('symbol=') === 0 && w.count('slug=') === 0);
  }

  // F (expiry): after the 60s quote TTL a fresh request is made; the 24h directory is still cached.
  reset();
  {
    const w = world();
    await resolveAsset('BNB');
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      await resolveAsset('BNB');
    } finally {
      Date.now = realNow;
    }
    assert('cache: quote refreshes after the 60s TTL', w.count('id=1839') === 2);
    assert('cache: directory is still cached after 61s (24h TTL)', w.count('/v1/cryptocurrency/map') === 1);
  }

  // E: single-flight. 10 concurrent requests for BTC -> ONE HTTP quote call.
  reset();
  {
    const w = world({ latencyMs: 30 });
    const results = await Promise.all(Array.from({ length: 10 }, () => fetchQuotesById(1)));
    assert('single-flight: 10 concurrent fetchQuotesById(1) all succeed', results.every((r) => r.id === 1));
    assert('single-flight: 10 concurrent BTC quote requests -> exactly 1 CMC HTTP call', w.count('/quotes/latest') === 1, `calls=${w.count('/quotes/latest')}`);
  }
  reset();
  {
    const w = world({ latencyMs: 30 });
    const results = await Promise.all(Array.from({ length: 10 }, () => resolveAsset('BTC')));
    assert('single-flight: 10 concurrent BTC analyses all resolve', results.every((r) => r.symbol === 'BTC'));
    assert('single-flight: 10 concurrent BTC analyses -> exactly 1 CMC HTTP call', w.calls.length === 1, `calls=${w.calls.length}`);
  }
  reset();
  {
    const w = world({ latencyMs: 30 });
    await Promise.all(Array.from({ length: 10 }, () => resolveAsset('BNB')));
    assert('single-flight: 10 concurrent BNB analyses -> 1 map call + 1 quote call', w.count('/v1/cryptocurrency/map') === 1 && w.count('/quotes/latest') === 1, w.calls.join(' | '));
  }

  // G: context reuses the BTC quote (either order) — never a second BTC request.
  reset();
  {
    const w = world();
    await resolveAsset('BTC');
    const ctx = await getMarketContext();
    assert('context: BTC analysis then /context -> BTC quote fetched once', ctx.btc?.symbol === 'BTC' && w.count('/v3/cryptocurrency/quotes/latest') === 1, w.calls.join(' | '));
    assert('context: only the (separately cached) global-metrics call is added', w.calls.length === 2 && w.count('/global-metrics') === 1);
  }
  reset();
  {
    const w = world();
    await getMarketContext();
    await resolveAsset('BTC');
    await getMarketContext();
    assert('context: /context then BTC analysis then /context -> BTC quote fetched once', w.count('/v3/cryptocurrency/quotes/latest') === 1);
    assert('context: global-metrics also cached across the repeated /context', w.count('/global-metrics') === 1);
  }
  reset();
  {
    const w = world();
    await resolveAsset('BNB');
    await getMarketContext();
    await getMarketContext();
    assert('context: follow-up questions add no request for the analysed asset', w.count('id=1839') === 1);
  }

  // H: 429 -> RATE_LIMITED, no retry storm.
  reset();
  {
    const w = world({ quoteStatus: 429 });
    await assertRejectsWith('429: BTC analysis surfaces RATE_LIMITED', () => resolveAsset('BTC'), 'RATE_LIMITED');
    assert('429: exactly one HTTP attempt (no automatic retry)', w.calls.length === 1, w.calls.join(' | '));
    for (let i = 0; i < 5; i++) await resolveAsset('BNB').catch(() => undefined);
    await resolveAsset('ETH').catch(() => undefined);
    assert('429: cool-down blocks follow-up requests (no retry storm)', w.calls.length === 1, `calls=${w.calls.length}`);
  }
  reset();
  {
    const w = world({ quoteStatus: 429, latencyMs: 20 });
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => resolveAsset('BTC')));
    assert('429: 10 concurrent requests -> 1 HTTP call, all RATE_LIMITED', w.calls.length === 1 && settled.every((r) => r.status === 'rejected' && (r.reason as AppError).code === 'RATE_LIMITED'), `calls=${w.calls.length}`);
  }
  reset();
  {
    const w = world();
    // After the cool-down is cleared, requests flow again.
    mockFetch(() => ({ status: 429, body: envelope(null, 1008, 'rate limited') }));
    await resolveAsset('BTC').catch(() => undefined);
    resetCmcThrottle();
    cacheClear();
    const w2 = world();
    assert('429: service recovers once the cool-down is cleared', (await resolveAsset('BTC')).symbol === 'BTC' && w2.calls.length === 1);
    void w;
  }

  // 5xx on a quote is not retried either (and stays UPSTREAM_ERROR).
  reset();
  {
    const w = world({ quoteStatus: 500 });
    await assertRejectsWith('5xx: BTC surfaces UPSTREAM_ERROR', () => resolveAsset('BTC'), 'UPSTREAM_ERROR');
    assert('5xx: exactly one HTTP attempt (no retry)', w.calls.length === 1);
  }

  // I: contract address -> info resolves id -> ONE quote-by-id request.
  reset();
  {
    const w = world();
    const asset = await resolveAsset('0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
    assert('address: resolves to the info id', asset.id === 24478);
    assert('address: one info?address call and exactly one quote-by-id call', w.count('/v2/cryptocurrency/info') === 1 && w.count('/quotes/latest') === 1 && w.count('id=24478') === 1, w.calls.join(' | '));
    assert('address: no map or symbol lookups', w.count('/map') === 0 && w.count('symbol=') === 0);
    assert('address: info is still hit on /v2/cryptocurrency/info?address', w.calls.some((c) => c.startsWith('/v2/cryptocurrency/info?address=')));
  }

  // Info: only when cached or explicitly enabled; fetching it once is then cached.
  reset();
  {
    const w = world();
    await fetchInfoById(1839); // warm the 24h info cache (as the CMC_INFO_LOOKUPS=true / address paths do)
    const asset = await resolveAsset('BNB');
    assert('info: already-cached info is reused for display (website link)', asset.websiteUrl === 'https://example.org');
    assert('info: reusing cached info makes no additional info request', w.count('/info') === 1);
  }

  // Not in the directory -> legacy symbol lookup still resolves it (rare path).
  reset();
  {
    const w = world();
    const asset = await resolveAsset('NEWCOIN');
    assert('fallback: ticker missing from the directory still resolves via symbol lookup', asset.symbol === 'NEWCOIN');
    assert('fallback: costs map + symbol only (no slug, no info)', w.count('/map') === 1 && w.count('symbol=NEWCOIN') === 1 && w.count('slug=') === 0 && w.count('/info') === 0, w.calls.join(' | '));
  }

  // CMC cannot resolve a DEX-only ticker -> fallback preserves the same report flow.
  reset();
  {
    dexPairsForTest = [{
      chainId: 'solana',
      dexId: 'raydium',
      url: 'https://dexscreener.com/solana/dexonly-pair',
      pairAddress: 'dexonly-pair',
      baseToken: { address: 'DexOnlyContract1234567890123456789012', name: 'Dex Only Coin', symbol: 'DEXONLY' },
      quoteToken: { address: 'USDC', name: 'USD Coin', symbol: 'USDC' },
      priceUsd: '0.0025',
      priceChange: { h1: 2.2, h24: 18.5 },
      volume: { h24: 18000 },
      liquidity: { usd: 62000 },
      marketCap: 2200000,
      fdv: 2500000,
      info: { websites: [{ url: 'https://dexonly.example.org' }] }
    }];
    mockFetch((url) => {
      if (url.pathname === '/v1/cryptocurrency/map') return { status: 200, body: envelope([]) };
      if (url.pathname === '/v3/cryptocurrency/quotes/latest') return { status: 200, body: quotesEnvelope([]) };
      return { status: 200, body: envelope({}) };
    });
    const dexOnly = await resolveAsset('DEXONLY');
    assert('DexScreener fallback resolves a token absent from CMC', dexOnly.symbol === 'DEXONLY' && dexOnly.dataSource === 'DexScreener');
    assert('DexScreener fallback preserves the selected pool URL', dexOnly.dataSourceUrl === 'https://dexscreener.com/solana/dexonly-pair');
    dexPairsForTest = [];
  }

  // Directory unavailable -> analysis still works through the legacy lookup.
  reset();
  {
    world({ mapStatus: 500 });
    // map 500s; legacy symbol path needs a symbol-capable responder
    mockFetch((url) => {
      if (url.pathname === '/v1/cryptocurrency/map') return { status: 500, body: envelope(null, 500, 'boom') };
      if (url.pathname === '/v3/cryptocurrency/quotes/latest' && url.searchParams.get('symbol') === 'PEPE') return { status: 200, body: quotesEnvelope([pepeQuote()]) };
      return { status: 400, body: envelope(null, 400, 'no results') };
    });
    assert('fallback: a failing directory does not break ticker analysis', (await resolveAsset('PEPE')).symbol === 'PEPE');
  }

  // Directory rate-limited -> RATE_LIMITED surfaces (not hidden as "not found").
  reset();
  mockFetch((url) => (url.pathname === '/v1/cryptocurrency/map' ? { status: 429, body: envelope(null, 1008, 'rate limited') } : { status: 200, body: envelope({}) }));
  await assertRejectsWith('directory 429 surfaces as RATE_LIMITED', () => resolveAsset('TIA'), 'RATE_LIMITED');

  // v3 listings discovery/trending: unchanged and still one shared cached call.
  reset();
  {
    const w = world();
    await getDiscoveryPool();
    await getMarketFeeds();
    await getDiscoveryPool();
    assert('feeds: discovery + trending + discovery share ONE listings request', w.count('/v3/cryptocurrency/listings/latest') === 1, w.calls.join(' | '));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
