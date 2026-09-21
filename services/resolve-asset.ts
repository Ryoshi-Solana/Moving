import 'server-only';

import { classifyInput, looksLikeSymbol, slugify } from '@/lib/asset-input';
import { AppError } from '@/lib/errors';
import {
  fetchInfoByAddress,
  fetchInfoById,
  fetchMap,
  fetchQuotesById,
  fetchQuotesBySlug,
  fetchQuotesBySymbol
} from '@/services/coinmarketcap';
import { normalize, pickBest } from '@/services/normalize';
import type { AssetSnapshot, CmcInfoItem, CmcQuoteItem } from '@/types';

/**
 * Turns whatever the user typed into a normalized AssetSnapshot.
 *
 * Resolution order (each step only runs if the previous found nothing):
 *   1. Contract address -> /v2/cryptocurrency/info?address, then quotes by id
 *   2. Exact ticker     -> /v2/cryptocurrency/quotes/latest?symbol
 *   3. Slugified name   -> /v2/cryptocurrency/quotes/latest?slug
 *   4. Fuzzy name       -> cached /v1/cryptocurrency/map, then quotes by id
 *
 * Typical cost is 1-2 credits; the map call is shared across every search on
 * the instance for six hours.
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
  const candidates: CmcQuoteItem[] = [];

  if (looksLikeSymbol(query)) {
    candidates.push(...(await safe(() => fetchQuotesBySymbol(query.replace(/^\$/, '')))));
  }

  if (candidates.length === 0) {
    const slug = slugify(query);
    if (slug) candidates.push(...(await safe(() => fetchQuotesBySlug(slug))));
  }

  if (candidates.length === 0) {
    const match = await searchDirectory(query);
    if (match !== null) candidates.push(await fetchQuotesById(match));
  }

  const best = pickBest(candidates);
  if (!best) throw new AppError('NOT_FOUND', { detail: `No asset for query "${query}"` });

  const info = await safeSingle(() => fetchInfoById(best.id));
  return { quote: best, info };
}

async function searchDirectory(query: string): Promise<number | null> {
  const map = await safe(() => fetchMap());
  if (map.length === 0) return null;

  const needle = query.toLowerCase();
  const byRank = (a: { rank: number | null }, b: { rank: number | null }) => (a.rank ?? 1e9) - (b.rank ?? 1e9);

  const exact = map.filter((item) => item.name.toLowerCase() === needle).sort(byRank)[0];
  if (exact) return exact.id;

  const prefix = map.filter((item) => item.name.toLowerCase().startsWith(needle)).sort(byRank)[0];
  if (prefix) return prefix.id;

  const contains = map.filter((item) => item.name.toLowerCase().includes(needle)).sort(byRank)[0];
  return contains ? contains.id : null;
}

/** Swallows "not found" so a failed strategy falls through to the next one. */
async function safe<T>(loader: () => Promise<T[]>): Promise<T[]> {
  try {
    return await loader();
  } catch (err) {
    if (err instanceof AppError && (err.code === 'NOT_FOUND' || err.code === 'INVALID_CONTRACT')) return [];
    throw err;
  }
}

/** Metadata is optional: losing it degrades the page, it should not fail it. */
async function safeSingle<T>(loader: () => Promise<T | null>): Promise<T | null> {
  try {
    return await loader();
  } catch (err) {
    if (err instanceof AppError && err.code !== 'CONFIG_ERROR' && err.code !== 'RATE_LIMITED') return null;
    throw err;
  }
}
