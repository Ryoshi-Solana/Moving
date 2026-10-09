import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

import 'server-only';

import { cached, cacheGet } from '@/lib/cache';
import { SERVER_CONFIG } from '@/lib/server-config';
import { AppError } from '@/lib/errors';
import type {
  CmcGlobalMetrics,
  CmcInfoItem,
  CmcMapItem,
  CmcPlatform,
  CmcQuote,
  CmcQuoteItem,
  CmcStatus
} from '@/types';

/**
 * Thin, typed wrapper around the CoinMarketCap Pro API.
 *
 * Everything in the app that needs market data goes through here. The API key
 * is read from the environment at call time and never leaves the server.
 *
 * Endpoints used, all available on the free "Basic" plan:
 *   GET /v3/cryptocurrency/quotes/latest   Ã¢â‚¬â€ live market data (v3: array payloads)
 *   GET /v2/cryptocurrency/info            Ã¢â‚¬â€ logo, chain, contracts, links
 *   GET /v1/cryptocurrency/map             Ã¢â‚¬â€ id/name/symbol directory
 *   GET /v1/global-metrics/quotes/latest   Ã¢â‚¬â€ total market cap, BTC dominance
 *   GET /v3/cryptocurrency/listings/latest Ã¢â‚¬â€ Top-100 pool for discovery + market tickers
 *
 * v3 returns quote records as an ARRAY (and `quote` itself as an array of
 * per-currency entries) instead of the symbol-keyed v2 map. That difference is
 * absorbed entirely in this file (see "v3 adapter" below): callers still get
 * the same `CmcQuoteItem` shape, so normalize/analysis code is untouched.
 */

const DEFAULT_BASE_URL = 'https://pro-api.coinmarketcap.com';

/** `error_code` is documented as either 0 or "0", so accept both. */
interface CmcRawStatus extends Omit<CmcStatus, 'error_code'> {
  error_code: number | string;
}

interface CmcEnvelope<T> {
  status?: CmcRawStatus;
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

/**
 * After a 429 from CMC, stop calling it for a short cool-down: every request
 * made inside that window would be rejected anyway and only extend the limit.
 * Callers get RATE_LIMITED immediately (no HTTP), and nothing is retried.
 */
let rateLimitedUntil = 0;
const DEFAULT_COOLDOWN_MS = 30_000;

/** Test helper: clears the 429 cool-down. */
export function resetCmcThrottle(): void {
  rateLimitedUntil = 0;
}

function startCooldown(response: Response): void {
  const header = Number(response.headers?.get?.('retry-after'));
  const ms = Number.isFinite(header) && header > 0 ? Math.min(Math.max(header * 1000, 5_000), 60_000) : DEFAULT_COOLDOWN_MS;
  rateLimitedUntil = Date.now() + ms;
}

async function cmcFetch<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(baseUrl() + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  // Resolve the key *before* the try block: a missing key is a configuration
  // fault, and must not be swallowed and re-reported as a network failure.
  const key = apiKey();

  if (Date.now() < rateLimitedUntil) {
    throw new AppError('RATE_LIMITED', { detail: `CMC cool-down active after a 429; skipped ${path}` });
  }

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

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    raw = undefined;
  }

  // v3 payloads are normally wrapped as { status, data }; tolerate a bare array too.
  const body = Array.isArray(raw) ? ({ data: raw } as CmcEnvelope<T>) : (raw as CmcEnvelope<T> | undefined);
  const status = normalizeStatus(body?.status);

  if (!response.ok || (status && status.error_code !== 0)) {
    const error = mapCmcError(response.status, status, path);
    if (error.code === 'RATE_LIMITED') startCooldown(response);
    throw error;
  }
  if (!body) {
    throw new AppError('UPSTREAM_ERROR', { detail: `Unparseable response from ${path}` });
  }

  return body.data;
}

function normalizeStatus(status: CmcRawStatus | undefined): CmcStatus | undefined {
  if (!status) return undefined;
  const code = Number(status.error_code);
  return { ...status, error_code: Number.isFinite(code) ? code : 0 };
}

/** Translates CMC status codes into our own user-safe errors. */
function mapCmcError(httpStatus: number, status: CmcStatus | undefined, path: string): AppError {
  const detail = `CMC ${path} Ã¢â€ â€™ http ${httpStatus}, code ${status?.error_code ?? 'n/a'}: ${status?.error_message ?? 'no message'}`;

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

type InfoMap = Record<string, CmcInfoItem | CmcInfoItem[]>;

const QUOTES_PATH = '/v3/cryptocurrency/quotes/latest';
const LISTINGS_PATH = '/v3/cryptocurrency/listings/latest';

export async function fetchQuotesById(id: number, convert = 'USD'): Promise<CmcQuoteItem> {
  const items = await cached(`quotes:id:${id}:${convert}`, SERVER_CONFIG.quoteTtlSeconds, async () =>
    toQuoteItems(await cmcFetch<unknown>(QUOTES_PATH, { id, convert }))
  );
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new AppError('NOT_FOUND', { detail: `No quote payload for id ${id}` });
  return item;
}

export async function fetchQuotesBySymbol(symbol: string, convert = 'USD'): Promise<CmcQuoteItem[]> {
  const normalized = symbol.toUpperCase();
  const items = await cached(`quotes:symbol:${normalized}:${convert}`, SERVER_CONFIG.quoteTtlSeconds, async () =>
    toQuoteItems(await cmcFetch<unknown>(QUOTES_PATH, { symbol: normalized, convert }))
  );
  return items.filter((entry) => entry.symbol.toUpperCase() === normalized);
}

export async function fetchQuotesBySlug(slug: string, convert = 'USD'): Promise<CmcQuoteItem[]> {
  return cached(`quotes:slug:${slug}:${convert}`, SERVER_CONFIG.quoteTtlSeconds, async () =>
    toQuoteItems(await cmcFetch<unknown>(QUOTES_PATH, { slug, convert }))
  );
}

export async function fetchInfoById(id: number): Promise<CmcInfoItem | null> {
  // Cache the resolved item (not the raw id-keyed map) so peekInfoById can read it.
  return cached(`info:id:${id}`, SERVER_CONFIG.infoTtlSeconds, async () => {
    const data = await cmcFetch<InfoMap>('/v2/cryptocurrency/info', { id });
    return firstOf(data?.[String(id)]) ?? null;
  });
}

/** Cache-only read of /info for an id: never makes an HTTP request. */
export function peekInfoById(id: number): CmcInfoItem | null {
  return cacheGet<CmcInfoItem | null>(`info:id:${id}`) ?? null;
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
 * Directory of active assets: the canonical ticker/name -> CMC id mapping.
 * Resolving to an id first lets every quote request be an id lookup (the form
 * CMC recommends). One call per day per instance, shared across all searches;
 * an empty/malformed payload is an error so it is never cached for 24h.
 */
export async function fetchMap(limit = 5000): Promise<CmcMapItem[]> {
  return cached(`map:${limit}`, SERVER_CONFIG.mapTtlSeconds, async () => {
    const data = await cmcFetch<unknown>('/v1/cryptocurrency/map', {
      listing_status: 'active',
      sort: 'cmc_rank',
      limit
    });
    if (!Array.isArray(data) || data.length === 0) {
      throw new AppError('UPSTREAM_ERROR', { detail: 'Empty or malformed /v1/cryptocurrency/map payload' });
    }
    return data as CmcMapItem[];
  });
}

/**
 * Whole-market snapshot (total cap, total volume, BTC dominance). Used only as
 * an optional enrichment for CONTEXT questions Ã¢â‚¬â€ BTC's own quote is the
 * primary, always-available market signal (see services/context.ts).
 */
export async function fetchGlobalMetrics(convert = 'USD'): Promise<CmcGlobalMetrics> {
  return cached(`global:${convert}`, SERVER_CONFIG.contextTtlSeconds, () =>
    cmcFetch<CmcGlobalMetrics>('/v1/global-metrics/quotes/latest', { convert })
  );
}

/**
 * Top assets by market cap, restricted to established coins (rank 1Ã¢â‚¬â€œ100)
 * rather than thin, low-liquidity tickers. Shared sampling pool for two
 * consumers: the "Done exploring?" discovery module (services/discovery.ts)
 * and the "Trending Coins" / "Top Gainers 24h" tickers (services/trending.ts)
 * Ã¢â‚¬â€ one cached call serves both, so the tickers add no extra CMC request
 * beyond what discovery already needed. Feature-gated: any failure here must
 * never affect the core analysis.
 */
export async function fetchTopByMarketCap(limit = 100, convert = 'USD'): Promise<CmcQuoteItem[]> {
  return cached(`top-market-cap:${limit}:${convert}`, SERVER_CONFIG.discoveryTtlSeconds, async () =>
    toQuoteItems(
      await cmcFetch<unknown>(LISTINGS_PATH, {
        start: 1,
        limit,
        convert,
        sort: 'market_cap',
        sort_dir: 'desc'
      })
    )
  );
}

/* ------------------------------------------------------------------ *
 * v3 adapter
 *
 * v3 `data` is an array of asset records and each record's `quote` is an
 * array of per-currency entries (identified by their own `symbol`), where v2
 * returned a symbol-keyed map with `quote: { USD: {...} }`. The functions
 * below accept either generation (and tolerate missing/null fields) and always
 * emit the stable internal `CmcQuoteItem` shape.
 * ------------------------------------------------------------------ */

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toQuote(raw: Loose): CmcQuote {
  return {
    price: numOrNull(raw.price),
    volume_24h: numOrNull(raw.volume_24h),
    volume_change_24h: numOrNull(raw.volume_change_24h),
    percent_change_1h: numOrNull(raw.percent_change_1h),
    percent_change_24h: numOrNull(raw.percent_change_24h),
    percent_change_7d: numOrNull(raw.percent_change_7d),
    percent_change_30d: numOrNull(raw.percent_change_30d),
    market_cap: numOrNull(raw.market_cap),
    market_cap_dominance: numOrNull(raw.market_cap_dominance),
    fully_diluted_market_cap: numOrNull(raw.fully_diluted_market_cap),
    last_updated: typeof raw.last_updated === 'string' ? raw.last_updated : null
  };
}

/** v3 array of quote entries *or* v2 object keyed by currency -> keyed record. */
function toQuoteRecord(raw: unknown): Record<string, CmcQuote> {
  const out: Record<string, CmcQuote> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isObject(entry)) continue;
      const symbol = typeof entry.symbol === 'string' && entry.symbol ? entry.symbol.toUpperCase() : 'USD';
      out[symbol] = toQuote(entry);
    }
  } else if (isObject(raw)) {
    for (const [symbol, entry] of Object.entries(raw)) {
      if (isObject(entry)) out[symbol.toUpperCase()] = toQuote(entry);
    }
  }
  return out;
}

function toQuoteItem(raw: Loose): CmcQuoteItem {
  const platform = isObject(raw.platform) ? (raw.platform as unknown as CmcPlatform) : null;
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ''),
    symbol: String(raw.symbol ?? ''),
    slug: String(raw.slug ?? ''),
    cmc_rank: numOrNull(raw.cmc_rank),
    num_market_pairs: numOrNull(raw.num_market_pairs),
    circulating_supply: numOrNull(raw.circulating_supply),
    total_supply: numOrNull(raw.total_supply),
    max_supply: numOrNull(raw.max_supply),
    infinite_supply: typeof raw.infinite_supply === 'boolean' ? raw.infinite_supply : undefined,
    is_active: raw.is_active === undefined || raw.is_active === null ? undefined : Number(raw.is_active),
    platform,
    last_updated: typeof raw.last_updated === 'string' ? raw.last_updated : null,
    quote: toQuoteRecord(raw.quote)
  };
}

function looksLikeQuoteItem(value: unknown): value is Loose {
  return isObject(value) && Number.isFinite(Number(value.id)) && 'quote' in value;
}

/**
 * Accepts every payload shape CMC has used for quote data Ã¢â‚¬â€ v3 array, a single
 * v3 record, or the v2 id/symbol-keyed map (values being a record or an array
 * of records) Ã¢â‚¬â€ and returns a flat list of normalized quote items.
 */
function toQuoteItems(data: unknown): CmcQuoteItem[] {
  if (data === null || data === undefined) return [];
  let records: unknown[];
  if (Array.isArray(data)) records = data;
  else if (looksLikeQuoteItem(data)) records = [data];
  else if (isObject(data)) records = Object.values(data).flatMap((entry) => asArray(entry));
  else return [];
  return records.filter(looksLikeQuoteItem).map(toQuoteItem);
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
