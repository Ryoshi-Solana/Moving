import { slugify } from '@/lib/asset-input';
import type { AssetSuggestion, CmcMapItem } from '@/types';

/**
 * Autocomplete ranking over the cached CoinMarketCap ID directory.
 *
 * The tiers mirror the resolver's own order (exact ticker → slug → exact name →
 * name prefix → name contains), with one addition for typing: a ticker prefix
 * tier. Within a tier, the best CMC rank wins. Choosing a suggestion submits
 * its exact ticker or name, so what the visitor picks is what the resolver
 * looks up — suggestions never introduce a competing resolution path.
 */

const TIER: Record<AssetSuggestion['match'], number> = {
  symbol: 0,
  slug: 1,
  name: 2,
  'symbol-prefix': 3,
  'name-prefix': 4,
  'name-contains': 5
};

export function rankSuggestions(query: string, directory: CmcMapItem[], limit = 6): AssetSuggestion[] {
  const needle = query.trim().replace(/^\$/, '').toLowerCase();
  if (needle.length === 0 || needle.length > 40) return [];
  const slug = slugify(needle);

  // Best (lowest) rank per ticker across the whole active directory: the
  // resolver sends a ticker to that asset, so any other asset sharing the
  // ticker must be submitted by name instead.
  const bestRankBySymbol = new Map<string, number>();
  for (const item of directory) {
    if (item.is_active === 0) continue;
    const key = item.symbol.toUpperCase();
    const rank = item.rank ?? 1e9;
    if (rank < (bestRankBySymbol.get(key) ?? Infinity)) bestRankBySymbol.set(key, rank);
  }

  const matches: Array<AssetSuggestion & { tier: number }> = [];
  for (const item of directory) {
    if (item.is_active === 0) continue;
    const symbol = item.symbol.toLowerCase();
    const name = item.name.toLowerCase();

    let match: AssetSuggestion['match'] | null = null;
    if (symbol === needle) match = 'symbol';
    else if (slug && item.slug === slug) match = 'slug';
    else if (name === needle) match = 'name';
    else if (symbol.startsWith(needle)) match = 'symbol-prefix';
    else if (name.startsWith(needle)) match = 'name-prefix';
    else if (needle.length >= 3 && name.includes(needle)) match = 'name-contains';
    if (!match) continue;

    const primaryTicker = (item.rank ?? 1e9) <= (bestRankBySymbol.get(item.symbol.toUpperCase()) ?? Infinity);
    matches.push({
      id: item.id,
      name: item.name,
      symbol: item.symbol,
      rank: item.rank ?? null,
      query: primaryTicker ? item.symbol : item.name,
      match,
      tier: TIER[match]
    });
  }

  matches.sort((a, b) => a.tier - b.tier || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.symbol.localeCompare(b.symbol));

  const seen = new Set<number>();
  const out: AssetSuggestion[] = [];
  for (const { id, name, symbol, rank, query: submit, match } of matches) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, symbol, rank, query: submit, match });
    if (out.length === limit) break;
  }
  return out;
}
