import { NextResponse } from 'next/server';

import { analyze } from '@/analysis/engine';
import { SERVER_CONFIG } from '@/lib/server-config';
import { AppError, toAppError } from '@/lib/errors';
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { sanitizeQuery } from '@/lib/asset-input';
import { resolveAsset } from '@/services/resolve-asset';
import type { AnalyzeResponse, ApiErrorBody } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/analyze?q=PEPE
 *
 * The only server endpoint for the core analysis. The CMC key is read here and
 * in the service layer, never sent to the browser.
 */
export async function GET(request: Request): Promise<NextResponse<AnalyzeResponse | ApiErrorBody>> {
  const started = Date.now();
  let query = '';
  let retryAfterSeconds: number | null = null;

  try {
    const limit = checkRateLimit(clientKeyFromHeaders(request.headers));
    if (!limit.ok) {
      retryAfterSeconds = limit.retryAfterSeconds;
      throw new AppError('RATE_LIMITED', { detail: `retry in ${limit.retryAfterSeconds}s` });
    }

    const { searchParams } = new URL(request.url);
    query = sanitizeQuery(searchParams.get('q'));

    const asset = await resolveAsset(query);

    if (asset.price === null && asset.marketCap === null && asset.volume24h === null) {
      throw new AppError('MISSING_DATA', { detail: `No usable market data for ${asset.symbol}` });
    }

    const payload: AnalyzeResponse = {
      asset,
      analysis: analyze(asset),
      generatedAt: new Date().toISOString()
    };

    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': `public, max-age=0, s-maxage=${SERVER_CONFIG.quoteTtlSeconds}, stale-while-revalidate=120`,
        'X-Response-Time': `${Date.now() - started}ms`
      }
    });
  } catch (err) {
    const error = toAppError(err);

    console.error('[analyze] failed', {
      query,
      code: error.code,
      detail: error.detail ?? error.message
    });

    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {})
      }
    };

    return NextResponse.json(body, {
      status: error.status,
      headers: {
        'Cache-Control': 'no-store',
        ...(error.code === 'RATE_LIMITED' ? { 'Retry-After': String(retryAfterSeconds ?? 30) } : {})
      }
    });
  }
}
