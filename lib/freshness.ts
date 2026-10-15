/**
 * Quote freshness, from the provider's own timestamp. When a provider does not
 * report one (DexScreener pair search), the state is "unknown" — MOVING never
 * substitutes the server clock and calls it a quote time.
 */

export type Freshness = 'fresh' | 'delayed' | 'stale' | 'unknown';

export const FRESHNESS_LIMITS = {
  /** Up to this age (seconds) a quote is labelled fresh. */
  fresh: 5 * 60,
  /** Up to this age it is delayed; beyond it, stale. */
  delayed: 60 * 60
} as const;

export function classifyFreshness(iso: string | null | undefined, now = Date.now()): Freshness {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const age = Math.max(0, (now - t) / 1000);
  if (age <= FRESHNESS_LIMITS.fresh) return 'fresh';
  if (age <= FRESHNESS_LIMITS.delayed) return 'delayed';
  return 'stale';
}

export const FRESHNESS_COPY: Record<Freshness, string> = {
  fresh: 'Quote is current',
  delayed: 'Quote is delayed',
  stale: 'Quote is stale',
  unknown: 'Quote time not reported'
};
