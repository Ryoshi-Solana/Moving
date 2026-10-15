import { NextResponse } from 'next/server';

import { isHistoryRange, parseHistorySource } from '@/lib/history';
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { getHistory } from '@/services/price-history';
import type { HistoryResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HISTORY_LIMIT_PER_MINUTE = 40;

/**
 * GET /api/history?provider=coinbase&product=SOL-USD&range=7D&ref=106.03
 * GET /api/history?provider=geckoterminal&network=solana&pool=…&range=1D&ref=0.00002
 *
 * Supporting enrichment for the investigation chart. Every input is validated
 * against a strict pattern before any upstream call, and every failure comes
 * back as status "unavailable" with HTTP 200 so the page simply shows its
 * honest empty state. `ref` is the quote the visitor is already looking at;
 * it is used only to confirm the venue describes the same asset.
 */
export async function GET(request: Request): Promise<NextResponse<HistoryResponse | { error: string }>> {
  const { searchParams } = new URL(request.url);
  const source = parseHistorySource(searchParams);
  const range = searchParams.get('range');
  const ref = Number(searchParams.get('ref'));

  if (!source || !isHistoryRange(range) || !Number.isFinite(ref) || ref <= 0) {
    return NextResponse.json({ error: 'Invalid history request.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const limit = checkRateLimit(`history:${clientKeyFromHeaders(request.headers)}`, HISTORY_LIMIT_PER_MINUTE);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many requests right now.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds), 'Cache-Control': 'no-store' } }
    );
  }

  const history = await getHistory(source, range, ref);
  return NextResponse.json(history, {
    headers: {
      'Cache-Control':
        history.status === 'verified' ? 'public, max-age=0, s-maxage=120, stale-while-revalidate=300' : 'no-store'
    }
  });
}
