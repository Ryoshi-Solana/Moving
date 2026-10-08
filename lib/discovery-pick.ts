import type { AssetSnapshot } from '@/types';

/**
 * Picks up to `count` distinct assets from `pool` for the "Done exploring?"
 * footer: excludes the currently analyzed asset, never repeats an asset
 * within the result, and prefers assets not in `recentSymbols` (session-scoped
 * repeat-avoidance) — falling back to including them anyway if excluding them
 * would leave too few candidates, so the footer never shows fewer cards than
 * the pool can actually support.
 *
 * Pure and framework-free by design: Investigation.tsx supplies
 * `recentSymbols` from sessionStorage, keeping the one bit of environment-
 * specific I/O (session storage) out of the logic itself so this is directly
 * unit-testable.
 */
export function pickDiscoveryCards(
  pool: AssetSnapshot[],
  currentAssetId: number,
  count: number,
  recentSymbols: string[] = []
): AssetSnapshot[] {
  const eligible = pool.filter((a) => a.id !== currentAssetId);
  const recent = new Set(recentSymbols);
  const preferred = eligible.filter((a) => !recent.has(a.symbol));
  const source = preferred.length >= count ? preferred : eligible;

  const shuffled = [...source];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const seen = new Set<number>();
  const picks: AssetSnapshot[] = [];
  for (const candidate of shuffled) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    picks.push(candidate);
    if (picks.length === count) break;
  }
  return picks;
}
