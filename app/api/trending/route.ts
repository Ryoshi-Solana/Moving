import { NextResponse } from 'next/server';

import { checkRateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { getMarketFeeds } from '@/services/trending';
import type { AssetSnapshot } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface TrendingResponse {
  trending: AssetSnapshot[] | null;
  gainers: AssetSnapshot[] | null;
}

/**
 * GET /api/trending
 *
 * Powers the two market-feed ticker strips ("Trending Coins" and "Top
 * Gainers 24h"). getMarketFeeds() never throws — any failure yields both
 * fields null and the ticker component simply doesn't render. Backed by the
 * same cached top-100-by-market-cap pool the discovery feature uses
 * (SERVER_CONFIG.discoveryTtlSeconds, ~5 min), so this route adds no extra
 * CMC request on top of whatever the page already needed.
 */
export async function GET(request: Request): Promise<NextResponse<TrendingResponse>> {
  const limit = checkRateLimit(clientKeyFromHeaders(request.headers));
  if (!limit.ok) {
    return NextResponse.json({ trending: null, gainers: null });
  }

  const feeds = await getMarketFeeds();
  return NextResponse.json(feeds, {
    headers: { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=600' }
  });
}
