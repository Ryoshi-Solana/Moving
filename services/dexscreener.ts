import 'server-only';

import { cached } from '@/lib/cache';
import { classifyInput, slugify } from '@/lib/asset-input';
import { AppError } from '@/lib/errors';
import { explorerFor } from '@/services/normalize';
import type { AssetSnapshot, ContractRef } from '@/types';

const API_BASE = 'https://api.dexscreener.com';
const CACHE_TTL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 8_000;

type DexToken = {
  address?: string;
  name?: string;
  symbol?: string;
};

export type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: DexToken;
  quoteToken?: DexToken | null;
  priceUsd?: string | null;
  priceNative?: string | null;
  txns?: Record<string, { buys?: number; sells?: number } | undefined> | null;
  volume?: Record<string, number | undefined> | null;
  priceChange?: Record<string, number | undefined> | null;
  liquidity?: { usd?: number | null } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
  info?: {
    imageUrl?: string | null;
    websites?: Array<{ url?: string }> | null;
    socials?: Array<{ platform?: string; handle?: string }> | null;
  } | null;
};

type DexSearchResponse = { pairs?: DexPair[] | null };

/**
 * Search DexScreener only after CMC cannot resolve an asset. We intentionally
 * use the base token of a pair: DexScreener's priceUsd and pair volume describe
 * that pool's base token, and treating the quote token as if it were the base
 * would silently attach the wrong market metrics to the requested asset.
 */
export async function resolveFromDexScreener(query: string): Promise<AssetSnapshot | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const response = await cached<DexSearchResponse | null>(
    `dexscreener:search:${trimmed.toLowerCase()}`,
    CACHE_TTL_SECONDS,
    () => searchPairs(trimmed)
  );
  const pairs = Array.isArray(response?.pairs) ? response.pairs : [];
  const isAddress = isLikelyAddress(trimmed);
  const best = selectDexPair(pairs, trimmed, isAddress);
  return best ? normalizeDexPair(best) : null;
}

/** Pure deterministic pair selection; address queries require exact base-token match. */
export function selectDexPair(pairs: DexPair[], query: string, isAddress = classifyInput(query) === 'address'): DexPair | null {
  const candidates = pairs
    .map((pair) => ({ pair, score: baseTokenMatchScore(pair.baseToken, query, isAddress) }))
    .filter((candidate) => candidate.score > 0 && candidate.pair.baseToken?.address && candidate.pair.baseToken.name && candidate.pair.baseToken.symbol && candidate.pair.chainId)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const liquidityDiff = (finite(b.pair.liquidity?.usd) ?? 0) - (finite(a.pair.liquidity?.usd) ?? 0);
      if (liquidityDiff !== 0) return liquidityDiff;
      return (finite(b.pair.volume?.h24) ?? 0) - (finite(a.pair.volume?.h24) ?? 0);
    });

  return candidates[0]?.pair ?? null;
}

async function searchPairs(query: string): Promise<DexSearchResponse | null> {
  const url = `${API_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store'
    });
  } catch (err) {
    throw new AppError('UPSTREAM_ERROR', { detail: `DexScreener request failed: ${errorMessage(err)}` });
  }

  if (response.status === 429) {
    throw new AppError('UPSTREAM_ERROR', { detail: 'DexScreener rate limit reached.' });
  }
  if (!response.ok) {
    throw new AppError('UPSTREAM_ERROR', { detail: `DexScreener returned HTTP ${response.status}.` });
  }

  try {
    return (await response.json()) as DexSearchResponse;
  } catch (err) {
    throw new AppError('UPSTREAM_ERROR', { detail: `DexScreener returned invalid JSON: ${errorMessage(err)}` });
  }
}

/** Exact address/ticker/name matches are preferred over fuzzy text matches. */
function isLikelyAddress(query: string): boolean {
  if (classifyInput(query) === 'address') return true;
  // Also recognize long single-part identifiers from chains whose address format
  // is not covered by the app's existing EVM/Solana/Tron input classifier.
  return query.length >= 25 && !/\s/.test(query) && /^[A-Za-z0-9:_-]+$/.test(query);
}

function baseTokenMatchScore(token: DexToken | undefined, query: string, isAddress: boolean): number {
  if (!token) return 0;
  const normalizedQuery = query.trim().replace(/^\$/, '').toLowerCase();
  const address = token.address?.toLowerCase() ?? '';
  const symbol = token.symbol?.trim().toLowerCase() ?? '';
  const name = token.name?.trim().toLowerCase() ?? '';

  if (isAddress) {
    const exact = token.address === query.trim();
    const evmCaseInsensitive = /^0x[a-f0-9]{40}$/i.test(query.trim()) && address === normalizedQuery;
    return exact || evmCaseInsensitive ? 10_000 : 0;
  }
  if (!normalizedQuery) return 0;
  if (symbol === normalizedQuery) return 800;
  if (name === normalizedQuery) return 700;
  if (symbol.startsWith(normalizedQuery)) return 500;
  if (name.startsWith(normalizedQuery)) return 400;
  if (symbol.includes(normalizedQuery)) return 250;
  if (name.includes(normalizedQuery)) return 200;
  return 0;
}

/** Pure adapter tested against recorded-shaped fixtures; fields not supplied by
 * DexScreener remain null instead of being guessed. Values are for the selected
 * highest-ranked pool, not an aggregate across every DEX/pair for that token. */
export function normalizeDexPair(pair: DexPair): AssetSnapshot {
  const token = pair.baseToken;
  const chainId = pair.chainId ?? 'unknown';
  if (!token?.address || !token.symbol || !token.name) {
    throw new AppError('MISSING_DATA', { detail: 'DexScreener pair is missing its base-token identity.' });
  }

  const chain = chainName(chainId);
  const contractAddress = token.address;
  const contract: ContractRef = {
    address: contractAddress,
    platform: chain,
    explorerUrl: explorerFor(chain, contractAddress)
  };
  const price = numericString(pair.priceUsd);
  const percentChange24h = finite(pair.priceChange?.h24);
  const marketCap = finite(pair.marketCap);
  const volume24h = finite(pair.volume?.h24);
  const marketCapChange24h = percentChange24h;
  const safeUrl = validDexScreenerUrl(pair.url);
  const websiteUrl = validHttpUrl(pair.info?.websites?.find((item) => validHttpUrl(item.url))?.url);

  return {
    id: stableNumericId(`${chainId}:${contractAddress}`),
    name: token.name,
    symbol: token.symbol,
    slug: slugify(`${chainId}-${token.symbol}-${contractAddress}`),
    rank: null,
    logoUrl: validHttpUrl(pair.info?.imageUrl),
    category: null,
    chain,
    primaryContract: contract,
    contracts: [contract],
    websiteUrl,
    price,
    percentChange1h: finite(pair.priceChange?.h1),
    percentChange24h,
    percentChange7d: null,
    percentChange30d: null,
    marketCap,
    fullyDilutedMarketCap: finite(pair.fdv),
    marketCapDominance: null,
    marketCapChange24h,
    marketCapChangeIsDerived: marketCapChange24h !== null,
    volume24h,
    // DexScreener reports volume by timeframe but not a 24h percentage delta.
    volumeChange24h: null,
    volumeToMarketCap: marketCap !== null && marketCap > 0 && volume24h !== null ? volume24h / marketCap : null,
    cexVolume24h: null,
    dexVolume24h: null,
    circulatingSupply: null,
    totalSupply: null,
    maxSupply: null,
    numMarketPairs: null,
    currency: 'USD',
    // Do not manufacture a quote timestamp from the server's local clock.
    lastUpdated: null,
    dataSource: 'DexScreener',
    dataSourceUrl: safeUrl
  };
}

function chainName(chainId: string): string {
  const names: Record<string, string> = {
    solana: 'Solana',
    ethereum: 'Ethereum',
    bsc: 'BNB Smart Chain (BEP20)',
    base: 'Base',
    arbitrum: 'Arbitrum',
    optimism: 'Optimism',
    polygon: 'Polygon',
    avalanche: 'Avalanche',
    fantom: 'Fantom',
    cronos: 'Cronos',
    tron: 'Tron',
    sui: 'Sui',
    ton: 'TON',
    aptos: 'Aptos',
    near: 'NEAR'
  };
  return names[chainId.toLowerCase()] ?? chainId.charAt(0).toUpperCase() + chainId.slice(1);
}

function stableNumericId(value: string): number {
  // Deterministic positive 31-bit hash; CMC IDs remain untouched on CMC assets.
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) & 0x7fffffff || 1;
}

function numericString(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validHttpUrl(value: string | null | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}


function validDexScreenerUrl(value: string | null | undefined): string | null {
  const safe = validHttpUrl(value);
  if (!safe) return null;
  try {
    const parsed = new URL(safe);
    return parsed.protocol === 'https:' && (parsed.hostname === 'dexscreener.com' || parsed.hostname.endsWith('.dexscreener.com'))
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
