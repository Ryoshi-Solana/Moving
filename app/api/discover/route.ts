import { NextResponse } from 'next/server';

import { checkRateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { getDiscoveryPool } from '@/services/discovery';
import type { AssetSnapshot } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface DiscoverResponse {
  /** Top-100-by-market-cap sampling pool. The client picks 3 at random,
   * excluding the current asset and (session-permitting) recently-clicked
   * ones — see Investigation.tsx. Field kept as `movers` for API stability;
   * it no longer means "24h movers," see services/discovery.ts. */
  movers: AssetSnapshot[] | null;
}

/**
 * GET /api/discover
 *
 * Powers the optional "Done exploring?" footer. getDiscoveryPool() never
 * throws — a plan/endpoint issue simply yields movers: null, and the UI
 * hides the footer rather than showing a dead button.
 */
export async function GET(request: Request): Promise<NextResponse<DiscoverResponse>> {
  const limit = checkRateLimit(clientKeyFromHeaders(request.headers));
  if (!limit.ok) {
    return NextResponse.json({ movers: null });
  }

  const movers = await getDiscoveryPool();
  return NextResponse.json(
    { movers },
    { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=600' } }
  );
}
