import type { AssetSnapshot } from '@/types';

/**
 * Small, reusable calculations shared by several question handlers. Kept
 * separate from the handlers themselves so each handler stays a short,
 * readable function that composes these primitives.
 */

export type TrendReading = 'accelerating' | 'fading' | 'steady' | 'mixed' | 'unknown';

/**
 * Compares the short-term move (1h, annualized to a 24h-equivalent pace) against
 * the 24h move itself to say whether the move is picking up or losing steam.
 * Deliberately coarse — this is a directional read, not a precise derivative.
 */
export function readMomentumTrend(asset: AssetSnapshot): TrendReading {
  const hour = asset.percentChange1h;
  const day = asset.percentChange24h;
  if (hour === null || day === null) return 'unknown';

  // Project the last hour forward as if it continued for a full day, so it is
  // on the same scale as the 24h figure.
  const hourPace = hour * 24;

  if (Math.sign(hour) !== 0 && Math.sign(day) !== 0 && Math.sign(hour) !== Math.sign(day)) {
    return 'mixed';
  }
  if (Math.abs(day) < 1) return 'steady';

  const ratio = hourPace / day;
  if (ratio > 1.4) return 'accelerating';
  if (ratio < 0.5) return 'fading';
  return 'steady';
}

/** Same idea over the medium term: is the 24h move stronger or weaker than the 7d pace? */
export function readTrendVsWeek(asset: AssetSnapshot): TrendReading {
  const day = asset.percentChange24h;
  const week = asset.percentChange7d;
  if (day === null || week === null) return 'unknown';

  const weekDailyPace = week / 7;
  if (Math.sign(day) !== 0 && Math.sign(weekDailyPace) !== 0 && Math.sign(day) !== Math.sign(weekDailyPace)) {
    return 'mixed';
  }
  if (Math.abs(weekDailyPace) < 0.3) return Math.abs(day) < 1 ? 'steady' : 'accelerating';

  const ratio = day / weekDailyPace;
  if (ratio > 1.4) return 'accelerating';
  if (ratio < 0.5) return 'fading';
  return 'steady';
}

export interface ChangeMetric {
  label: string;
  value: number;
  formatted: string;
}

/**
 * The headline deltas used by both the "What changed" module and the
 * WHAT_CHANGED / FASTEST_CHANGE questions. Only metrics the asset actually
 * has are included — never padded with placeholders.
 */
export function collectChangeMetrics(asset: AssetSnapshot): ChangeMetric[] {
  const metrics: ChangeMetric[] = [];
  const push = (label: string, value: number | null) => {
    if (value !== null) metrics.push({ label, value, formatted: formatSigned(value) });
  };
  push('Price 24h', asset.percentChange24h);
  push('Volume 24h', asset.volumeChange24h);
  push('Price 1h', asset.percentChange1h);
  push('Price 7d', asset.percentChange7d);
  return metrics;
}

/** The metric with the largest absolute swing — ties favor volume, since a
 * volume surge alongside a modest price move is usually the more surprising
 * fact. Returns null when there is nothing to compare. */
export function biggestChange(asset: AssetSnapshot): ChangeMetric | null {
  const metrics = collectChangeMetrics(asset);
  if (metrics.length === 0) return null;
  return metrics.slice().sort((a, b) => {
    const diff = Math.abs(b.value) - Math.abs(a.value);
    if (Math.abs(diff) > 0.01) return diff;
    // Tie-break: prefer volume over price labels.
    return a.label.includes('Volume') ? -1 : b.label.includes('Volume') ? 1 : 0;
  })[0];
}

/** Same idea, but restricted to two named metrics — used by FASTEST_CHANGE. */
export function fastestOf(metrics: ChangeMetric[]): ChangeMetric | null {
  if (metrics.length === 0) return null;
  return metrics.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
}

function formatSigned(value: number): string {
  const sign = value > 0 ? '+' : '';
  const digits = Math.abs(value) >= 10 ? 1 : 2;
  return `${sign}${value.toFixed(digits)}%`;
}
