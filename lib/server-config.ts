/**
 * Server-side tunables only. Never place secrets here in a module imported by
 * client components; public destinations live separately in lib/config.ts.
 */
/**
 * Reject malformed environment values instead of allowing NaN to disable
 * comparisons in the in-memory rate limiter. Invalid values use safe defaults.
 */
export function positiveIntOrDefault(
  rawValue: string | undefined,
  fallback: number,
  max: number
): number {
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}

export const SERVER_CONFIG = {
  quoteTtlSeconds: positiveIntOrDefault(process.env.CMC_CACHE_TTL_SECONDS, 60, 3600),
  infoTtlSeconds: 60 * 60 * 24,
  /** ID directory (/v1/cryptocurrency/map). Large and slow-changing: one call per day per instance. */
  mapTtlSeconds: 60 * 60 * 24,
  /**
   * Per-analysis /v2/cryptocurrency/info lookups (website link only; logo and
   * contract come from the id-based logo URL and the quote payload). Off by
   * default to stay inside the Basic plan's 50 req/min; set CMC_INFO_LOOKUPS=true
   * to fetch (and 24h-cache) info on first analysis of each asset.
   */
  fetchInfoOnAnalyze: process.env.CMC_INFO_LOOKUPS === 'true',
  /** Context (BTC + global metrics) changes slowly; cache longer than quotes. */
  contextTtlSeconds: 120,
  /** Discovery pool (top 100 by market cap) barely shifts minute to minute.
   * Also backs the "Trending Coins"/"Top Gainers 24h" tickers, which sample
   * from this same cached pool — see services/trending.ts. */
  discoveryTtlSeconds: 300,
  rateLimitPerMinute: positiveIntOrDefault(process.env.RATE_LIMIT_PER_MINUTE, 20, 1000),
  requestTimeoutMs: 8000
} as const;
