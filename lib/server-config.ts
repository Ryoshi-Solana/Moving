/**
 * Server-side tunables.
 *
 * Kept out of lib/config.ts because that file is imported by client components
 * (for SOCIAL_LINKS and APP copy) — there is no reason to ship process.env
 * lookups to the browser, even harmless ones.
 */
export const SERVER_CONFIG = {
  quoteTtlSeconds: Number(process.env.CMC_CACHE_TTL_SECONDS ?? 60),
  infoTtlSeconds: 60 * 60 * 24,
  mapTtlSeconds: 60 * 60 * 6,
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 20),
  requestTimeoutMs: 8000
} as const;
