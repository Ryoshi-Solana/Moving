import assert from 'node:assert/strict';
import { normalizeDexPair, resolveFromDexScreener, selectDexPair, type DexPair } from '@/services/dexscreener';

const pair = (overrides: Partial<DexPair> = {}): DexPair => ({
  chainId: 'solana',
  dexId: 'raydium',
  url: 'https://dexscreener.com/solana/pair123',
  pairAddress: 'pair123',
  baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'Test Coin', symbol: 'TEST' },
  quoteToken: { address: 'USDC', name: 'USD Coin', symbol: 'USDC' },
  priceUsd: '0.0025',
  priceNative: '0.0025',
  txns: { h24: { buys: 120, sells: 90 } },
  volume: { h1: 1200, h6: 5000, h24: 18000 },
  priceChange: { h1: 4.2, h6: 7.1, h24: 18.5 },
  liquidity: { usd: 62000 },
  fdv: 2500000,
  marketCap: 2200000,
  pairCreatedAt: 1_760_000_000_000,
  info: {
    imageUrl: 'https://cdn.example.test/test.png',
    websites: [{ url: 'https://test.example.test' }],
    socials: [{ platform: 'twitter', handle: 'testcoin' }]
  },
  ...overrides
});

// Exact ticker wins over a higher-liquidity fuzzy-name collision.
const exactTicker = pair({
  baseToken: { address: 'ExactAddr', name: 'Test Coin Community', symbol: 'TEST' },
  liquidity: { usd: 5_000 }
});
const fuzzyToken = pair({
  baseToken: { address: 'FuzzyAddr', name: 'TEST Finance', symbol: 'TSTF' },
  liquidity: { usd: 500_000 }
});
assert.equal(selectDexPair([fuzzyToken, exactTicker], 'TEST')?.baseToken?.address, 'ExactAddr');

// Address input must match the base-token address exactly, never a quote token.
assert.equal(selectDexPair([pair()], 'So11111111111111111111111111111111111111112')?.baseToken?.symbol, 'TEST');
assert.equal(selectDexPair([pair()], 'so11111111111111111111111111111111111111112'), null);
assert.equal(selectDexPair([pair()], 'So11111111111111111111111111111111111111112', true)?.baseToken?.address, 'So11111111111111111111111111111111111111112');
assert.equal(selectDexPair([pair({ baseToken: { address: '0x000000000000000000000000000000000000000A', name: 'EVM Coin', symbol: 'EVM' } })], '0x000000000000000000000000000000000000000a')?.baseToken?.symbol, 'EVM');
assert.equal(selectDexPair([pair()], '0x0000000000000000000000000000000000000001'), null);
assert.equal(selectDexPair([pair({ quoteToken: { address: 'WantedAddress', name: 'Wanted', symbol: 'WANT' } })], 'WantedAddress', true), null);

// The adapter preserves real available values and leaves unsupported history blank.
const snapshot = normalizeDexPair(pair());
assert.equal(snapshot.dataSource, 'DexScreener');
assert.equal(snapshot.dataSourceUrl, 'https://dexscreener.com/solana/pair123');
assert.equal(snapshot.name, 'Test Coin');
assert.equal(snapshot.chain, 'Solana');
assert.equal(snapshot.price, 0.0025);
assert.equal(snapshot.percentChange1h, 4.2);
assert.equal(snapshot.percentChange24h, 18.5);
assert.equal(snapshot.percentChange7d, null);
assert.equal(snapshot.percentChange30d, null);
assert.equal(snapshot.volume24h, 18000);
assert.equal(snapshot.volumeChange24h, null);
assert.equal(snapshot.dexVolume24h, null);
assert.equal(snapshot.circulatingSupply, null);
assert.equal(snapshot.numMarketPairs, null);

// Bad or unsafe URLs are dropped rather than surfaced as clickable links.
const unsafe = normalizeDexPair(pair({ url: 'javascript:alert(1)', info: { imageUrl: 'data:image/png;base64,abc', websites: [{ url: 'javascript:alert(1)' }] } }));
assert.equal(unsafe.dataSourceUrl, null);
assert.equal(unsafe.logoUrl, null);
assert.equal(unsafe.websiteUrl, null);

async function testMockedSearchEndpoint(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  const mockPair = pair({
    baseToken: { address: 'MockContractAddress1234567890123456789012', name: 'Mock Coin', symbol: 'MOCK' }
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ pairs: [mockPair] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const result = await resolveFromDexScreener('MOCK');
    assert.ok(requestedUrl.startsWith('https://api.dexscreener.com/latest/dex/search?q=MOCK'));
    assert.equal(result?.symbol, 'MOCK');
    assert.equal(result?.dataSource, 'DexScreener');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await testMockedSearchEndpoint();
console.log('DexScreener: mocked API request, pair selection, contract matching, normalization, missing-data, and URL safety checks passed.');
