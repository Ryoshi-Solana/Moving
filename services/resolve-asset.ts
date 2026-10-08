import 'server-only';

import { classifyInput, looksLikeSymbol, slugify } from '@/lib/asset-input';
import { canonicalIdFor } from '@/lib/canonical-assets';
import { AppError } from '@/lib/errors';
import { SERVER_CONFIG } from '@/lib/server-config';
import {
  fetchInfoByAddress,
  fetchInfoById,
  fetchMap,
  fetchQuotesById,
  fetchQuotesBySlug,
  fetchQuotesBySymbol,
  peekInfoById
} from '@/services/coinmarketcap';
import { normalize, pickBest } from '@/services/normalize';
import type { AssetSnapshot, CmcInfoItem, CmcMapItem, CmcQuoteItem } from '@/types';

/**
 * Turns whatever the user typed into a normalized AssetSnapshot.
 *
 * Everything resolves to a stable CMC id first, then makes ONE quote-by-id call:
 *   1. Contract address -> /v2/cryptocurrency/info?address -> quote by info.id
 *   2. BTC / ETH / SOL  -> pinned canonical id (no directory lookup needed)
 *   3. Other text       -> cached (24h) /v1/cryptocurrency/map: exact ticker
 *                          (highest-ranked active match) -> slug -> name
 *   4. Not in the map   -> legacy quote lookup by symbol, then slug (rare path)
 * Quotes are cached 60s with single-flight, so a warm repeat costs no request.
 */
export async function resolveAsset(query: string): Promise<AssetSnapshot> {
  const kind = classifyInput(query);
  const { quote, info } = kind === 'address' ? await resolveByAddress(query) : await resolveByText(query);
  return normalize(quote, info);
}

async function resolveByAddress(address: string): Promise<{ quote: CmcQuoteItem; info: CmcInfoItem | null }> {
  let info: CmcInfoItem | null = null;
  try {
    info = await fetchInfoByAddress(address);
  } catch (err) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') {
      throw new AppError('INVALID_CONTRACT', { detail: err.detail });
    }
    throw err;
  }
  if (!info) throw new AppError('INVALID_CONTRACT', { detail: `Address not mapped: ${address}` });

  const quote = await fetchQuotesById(info.id);
  return { quote, info };
}

async function resolveByText(query: string): Promise<{ quote: CmcQuoteItem; info: CmcInfoItem | null }> {
  const id = await resolveId(query);
  if (id !== null) {
    const quote = await fetchQuotesById(id);
    return { quote, info: await infoFor(id) };
  }

  // Not in the directory (or the directory is unavailable): legacy lookup.
  const candidates: CmcQuoteItem[] = [];
  if (looksLikeSymbol(query)) {
    candidates.push(...(await safe(() => fetchQuotesBySymbol(query.replace(/^\$/, '')))));
  }
  if (candidates.length === 0) {
    const slug = slugify(query);
    if (slug) candidates.push(...(await safe(() => fetchQuotesBySlug(slug))));
  }
  const best = pickBest(candidates);
  if (!best) throw new AppError('NOT_FOUND', { detail: `No asset for query "${query}"` });
  return { quote: best, info: await infoFor(best.id) };
}

/** Ticker/name -> CMC id without touching the quotes endpoint. */
async function resolveId(query: string): Promise<number | null> {
  if (looksLikeSymbol(query)) {
    const pinned = canonicalIdFor(query);
    if (pinned !== undefined) return pinned;
  }
  const directory = await loadDirectory();
  return directory ? findInDirectory(query, directory) : null;
}

/**
 * The cached ID directory. A failing directory must not take analysis down
 * (the legacy lookup still works), but rate-limit and config faults propagate
 * so the user sees the real reason.
 */
async function loadDirectory(): Promise<CmcMapItem[] | null> {
  try {
    return await fetchMap();
  } catch (err) {
    if (err instanceof AppError && (err.code === 'RATE_LIMITED' || err.code === 'CONFIG_ERROR')) throw err;
    return null;
  }
}

function findInDirectory(query: string, map: CmcMapItem[]): number | null {
  const byRank = (a: { rank: number | null }, b: { rank: number | null }) => (a.rank ?? 1e9) - (b.rank ?? 1e9);
  const active = map.filter((item) => item.is_active !== 0);

  if (looksLikeSymbol(query)) {
    const symbol = query.replace(/^\$/, '').toUpperCase();
    const bySymbol = active.filter((item) => item.symbol.toUpperCase() === symbol).sort(byRank)[0];
    if (bySymbol) return bySymbol.id;
  }

  const slug = slugify(query);
  if (slug) {
    const bySlug = active.filter((item) => item.slug === slug).sort(byRank)[0];
    if (bySlug) return bySlug.id;
  }

  const needle = query.toLowerCase();
  const exact = active.filter((item) => item.name.toLowerCase() === needle).sort(byRank)[0];
  if (exact) return exact.id;

  const prefix = active.filter((item) => item.name.toLowerCase().startsWith(needle)).sort(byRank)[0];
  if (prefix) return prefix.id;

  const contains = active.filter((item) => item.name.toLowerCase().includes(needle)).sort(byRank)[0];
  return contains ? contains.id : null;
}

/**
 * Display metadata (website link). Never needed for the analysis itself, and
 * logo/contract already come from the id and the quote payload, so by default
 * this only reuses info that is already cached. CMC_INFO_LOOKUPS=true makes
 * the first analysis of each asset fetch (and 24h-cache) it.
 */
async function infoFor(id: number): Promise<CmcInfoItem | null> {
  if (!SERVER_CONFIG.fetchInfoOnAnalyze) return peekInfoById(id);
  return safeSingle(() => fetchInfoById(id));
}

async function safe<T>(loader: () => Promise<T[]>): Promise<T[]> {
  try {
    return await loader();
  } catch (err) {
    if (err instanceof AppError && (err.code === 'NOT_FOUND' || err.code === 'INVALID_CONTRACT')) return [];
    throw err;
  }
}

async function safeSingle<T>(loader: () => Promise<T | null>): Promise<T | null> {
  try {
    return await loader();
  } catch (err) {
    if (err instanceof AppError && err.code !== 'CONFIG_ERROR' && err.code !== 'RATE_LIMITED') return null;
    throw err;
  }
}
