import 'server-only';

import { cached } from '@/lib/cache';
import { SERVER_CONFIG } from '@/lib/server-config';
import { AppError } from '@/lib/errors';
import type { CmcInfoItem, CmcMapItem, CmcQuoteItem, CmcStatus } from '@/types';

/**
 * Thin, typed wrapper around the CoinMarketCap Pro API.
 *
 * Everything in the app that needs market data goes through here. The API key
 * is read from the environment at call time and never leaves the server.
 *
 * Endpoints used (all available on the free "Basic" plan):
 *   GET /v2/cryptocurrency/quotes/latest   — live market data
 *   GET /v2/cryptocurrency/info            — logo, chain, contracts, links
 *   GET /v1/cryptocurrency/map             — id/name/symbol directory
 */

const DEFAULT_BASE_URL = 'https://pro-api.coinmarketcap.com';

interface CmcEnvelope<T> {
  status: CmcStatus;
  data: T;
}

function baseUrl(): string {
  return (process.env.CMC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function apiKey(): string {
  const key = process.env.CMC_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new AppError('CONFIG_ERROR', { detail: 'CMC_API_KEY is not set' });
  }
  return key.trim();
}

async function cmcFetch<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(baseUrl() + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  // Resolve the key *before* the try block: a missing key is a configuration
  // fault, and must not be swallowed and re-reported as a network failure.
  const key = apiKey();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVER_CONFIG.requestTimeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': key,
        Accept: 'application/json'
      },
      signal: controller.signal,
      cache: 'no-store'
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new AppError('UPSTREAM_ERROR', {
      detail: aborted ? `Timeout calling ${path}` : `Network error calling ${path}: ${String(err)}`
    });
  } finally {
    clearTimeout(timeout);
  }

  let body: CmcEnvelope<T> | undefined;
  try {
    body = (await response.json()) as CmcEnvelope<T>;
  } catch {
    body = undefined;
  }

  if (!response.ok || (body?.status && body.status.error_code !== 0)) {
    throw mapCmcError(response.status, body?.status, path);
  }
  if (!body) {
    throw new AppError('UPSTREAM_ERROR', { detail: `Unparseable response from ${path}` });
  }

  return body.data;
}

/** Translates CMC status codes into our own user-safe errors. */
function mapCmcError(httpStatus: number, status: CmcStatus | undefined, path: string): AppError {
  const detail = `CMC ${path} → http ${httpStatus}, code ${status?.error_code ?? 'n/a'}: ${status?.error_message ?? 'no message'}`;

  // 400 with "No results" / invalid symbol is a not-found from the user's POV.
  const message = (status?.error_message ?? '').toLowerCase();
  if (httpStatus === 400 && (message.includes('no results') || message.includes('invalid value'))) {
    return new AppError('NOT_FOUND', { detail });
  }
  if (httpStatus === 404) return new AppError('NOT_FOUND', { detail });
  if (httpStatus === 429 || status?.error_code === 1008 || status?.error_code === 1009) {
    return new AppError('RATE_LIMITED', { detail });
  }
  if (httpStatus === 401 || httpStatus === 403 || status?.error_code === 1001 || status?.error_code === 1002) {
    return new AppError('CONFIG_ERROR', { detail });
  }
  return new AppError('UPSTREAM_ERROR', { detail });
}

/* ------------------------------------------------------------------ *
 * Endpoint wrappers
 * ------------------------------------------------------------------ */

type QuoteMap = Record<string, CmcQuoteItem | CmcQuoteItem[]>;
type InfoMap = Record<string, CmcInfoItem | CmcInfoItem[]>;

export async function fetchQuotesById(id: number, convert = 'USD'): Promise<CmcQuoteItem> {
  const data = await cached(`quotes:id:${id}:${convert}`, SERVER_CONFIG.quoteTtlSeconds, () =>
    cmcFetch<QuoteMap>('/v2/cryptocurrency/quotes/latest', { id, convert })
  );
  const item = firstOf(data[String(id)]);
  if (!item) throw new AppError('NOT_FOUND', { detail: `No quote payload for id ${id}` });
  return item;
}

export async function fetchQuotesBySymbol(symbol: string, convert = 'USD'): Promise<CmcQuoteItem[]> {
  const normalized = symbol.toUpperCase();
  const data = await cached(`quotes:symbol:${normalized}:${convert}`, SERVER_CONFIG.quoteTtlSeconds, () =>
    cmcFetch<QuoteMap>('/v2/cryptocurrency/quotes/latest', { symbol: normalized, convert })
  );
  return asArray(data[normalized]);
}

export async function fetchQuotesBySlug(slug: string, convert = 'USD'): Promise<CmcQuoteItem[]> {
  const data = await cached(`quotes:slug:${slug}:${convert}`, SERVER_CONFIG.quoteTtlSeconds, () =>
    cmcFetch<QuoteMap>('/v2/cryptocurrency/quotes/latest', { slug, convert })
  );
  return Object.values(data).flatMap((entry) => asArray(entry));
}

export async function fetchInfoById(id: number): Promise<CmcInfoItem | null> {
  const data = await cached(`info:id:${id}`, SERVER_CONFIG.infoTtlSeconds, () =>
    cmcFetch<InfoMap>('/v2/cryptocurrency/info', { id })
  );
  return firstOf(data[String(id)]) ?? null;
}

/**
 * Contract-address lookup. CMC resolves the address itself and tells us which
 * chain it belongs to, so we do not need to guess the network up front.
 */
export async function fetchInfoByAddress(address: string): Promise<CmcInfoItem | null> {
  const key = `info:address:${address.toLowerCase()}`;
  const data = await cached(key, SERVER_CONFIG.infoTtlSeconds, () =>
    cmcFetch<InfoMap>('/v2/cryptocurrency/info', { address })
  );
  const entries = Object.values(data).flatMap((entry) => asArray(entry));
  return entries[0] ?? null;
}

/**
 * Directory of active assets, used only as a last resort for fuzzy name search.
 * One call every 6 hours, shared across all searches on the instance.
 */
export async function fetchMap(limit = 5000): Promise<CmcMapItem[]> {
  return cached(`map:${limit}`, SERVER_CONFIG.mapTtlSeconds, () =>
    cmcFetch<CmcMapItem[]>('/v1/cryptocurrency/map', {
      listing_status: 'active',
      sort: 'cmc_rank',
      limit
    })
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstOf<T>(value: T | T[] | undefined): T | undefined {
  return asArray(value)[0];
}
