import { NextResponse } from 'next/server';

import { rankSuggestions } from '@/lib/asset-search';
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { fetchMap } from '@/services/coinmarketcap';
import type { AssetSuggestion } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUGGEST_LIMIT_PER_MINUTE = 90;

export interface SuggestResponse {
  suggestions: AssetSuggestion[];
}

/**
 * GET /api/suggest?q=sol
 *
 * Autocomplete from the same 24h-cached CoinMarketCap directory the resolver
 * already uses, so typing never spends a quote request. Supporting feature:
 * any failure, oversized input or rate limit returns an empty list and the
 * search box still works exactly as before.
 */
export async function GET(request: Request): Promise<NextResponse<SuggestResponse>> {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  const empty = NextResponse.json({ suggestions: [] }, { headers: { 'Cache-Control': 'no-store' } });

  // Addresses are not autocompleted; they go straight to the resolver.
  if (q.trim().length === 0 || q.length > 40 || !/^[\w\s.$\-']+$/u.test(q) || q.trim().length >= 30) return empty;

  const limit = checkRateLimit(`suggest:${clientKeyFromHeaders(request.headers)}`, SUGGEST_LIMIT_PER_MINUTE);
  if (!limit.ok) return empty;

  try {
    const directory = await fetchMap();
    return NextResponse.json(
      { suggestions: rankSuggestions(q, directory, 6) },
      { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400' } }
    );
  } catch {
    return empty;
  }
}
