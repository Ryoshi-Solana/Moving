import { NextResponse } from 'next/server';

import { checkRateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { getMarketContext } from '@/services/context';
import type { AssetSnapshot, GlobalSnapshot } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface ContextResponse {
  btc: AssetSnapshot | null;
  global: GlobalSnapshot | null;
}

/**
 * GET /api/context
 *
 * Powers CONTEXT-category investigation questions (MARKET_CONTEXT, VS_BTC,
 * ISOLATED_OR_MARKETWIDE, RELATIVE_STRENGTH). The client fetches this once per
 * search and reuses it across every CONTEXT question that gets clicked — see
 * Investigation.tsx. getMarketContext() never throws: btc/global are each
 * independently null on failure, so this route always returns 200.
 */
export async function GET(request: Request): Promise<NextResponse<ContextResponse>> {
  const limit = checkRateLimit(clientKeyFromHeaders(request.headers));
  if (!limit.ok) {
    // Context is a supporting enrichment, not the core analysis: on rate
    // limit, degrade to "no context" rather than surfacing an error the user
    // would have to dismiss — the CONTEXT questions simply won't appear.
    return NextResponse.json({ btc: null, global: null });
  }

  const context = await getMarketContext();
  return NextResponse.json(context, {
    headers: { 'Cache-Control': 'public, max-age=0, s-maxage=120, stale-while-revalidate=300' }
  });
}
