import { SERVER_CONFIG } from '@/lib/server-config';

/**
 * Fixed-window limiter, keyed by client IP, held in process memory.
 *
 * On serverless this is per-instance rather than global, so treat it as abuse
 * dampening rather than a hard quota. Swap in Upstash/Vercel KV if the product
 * ever needs a real shared limit.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
const WINDOW_MS = 60_000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string, limit = SERVER_CONFIG.rateLimitPerMinute): RateLimitResult {
  const now = Date.now();
  const current = windows.get(key);

  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (windows.size > 5000) pruneExpired(now);
    return { ok: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
  }

  current.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));

  if (current.count > limit) {
    return { ok: false, remaining: 0, retryAfterSeconds };
  }
  return { ok: true, remaining: Math.max(0, limit - current.count), retryAfterSeconds };
}

function pruneExpired(now: number): void {
  for (const [key, win] of windows) {
    if (win.resetAt <= now) windows.delete(key);
  }
}

/** Best-effort client IP from proxy headers. */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return headers.get('x-real-ip') ?? headers.get('cf-connecting-ip') ?? 'anonymous';
}
