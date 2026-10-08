import type { AssetSnapshot, Direction, MoveSize, Signals, TurnoverLevel, VolumeTrend } from '@/types';

/**
 * Step 1 of the engine: reduce raw CMC metrics to a small set of comparable
 * signals. Every threshold lives here so the behaviour of the whole product can
 * be tuned from one file.
 */

export const THRESHOLDS = {
  /**
   * |24h price change| boundaries, in percent.
   *   < noise    → quiet    (nothing to explain)
   *   < notable  → modest
   *   < extreme  → strong   (a normal "why is this moving?" search)
   *   >= extreme → extreme  (parabolic; reserved for genuine outliers)
   */
  move: { noise: 2, notable: 10, extreme: 40 },
  /** 24h volume change boundaries, in percent. */
  volume: { flatLow: -15, flatHigh: 25, expanding: 100, surging: 300 },
  /** volume_24h / market_cap boundaries. */
  turnover: { dormant: 0.01, normal: 0.05, elevated: 0.15 },
  /** num_market_pairs boundaries. */
  pairs: { thin: 15, deep: 100 },
  /** Reference move used to normalize momentum to 0–1. */
  referenceMove: 25
} as const;

export function buildSignals(asset: AssetSnapshot): Signals {
  const price24h = asset.percentChange24h;
  const volumeChange = asset.volumeChange24h;
  const turnover = asset.volumeToMarketCap;

  const direction = classifyDirection(price24h);
  const moveSize = classifyMoveSize(price24h);
  const momentumStrength = price24h === null ? 0 : clamp(Math.abs(price24h) / THRESHOLDS.referenceMove, 0, 1);

  const volumeTrend = classifyVolumeTrend(volumeChange);
  const turnoverLevel = classifyTurnover(turnover);

  return {
    direction,
    moveSize,
    momentumStrength,
    volumeTrend,
    volumeConfirmation: volumeConfirmation(volumeChange),
    turnover,
    turnoverLevel,
    amplification: amplification(price24h, volumeChange),
    trendAlignment: trendAlignment(asset),
    shortTermReversal: shortTermReversal(asset),
    liquidityBreadth: classifyLiquidity(asset.numMarketPairs),
    missing: listMissing(asset)
  };
}

export function classifyDirection(price24h: number | null): Direction {
  if (price24h === null) return 'flat';
  if (price24h > THRESHOLDS.move.noise) return 'up';
  if (price24h < -THRESHOLDS.move.noise) return 'down';
  return 'flat';
}

export function classifyMoveSize(price24h: number | null): MoveSize {
  if (price24h === null) return 'quiet';
  const abs = Math.abs(price24h);
  if (abs >= THRESHOLDS.move.extreme) return 'extreme';
  if (abs >= THRESHOLDS.move.notable) return 'strong';
  if (abs >= THRESHOLDS.move.noise) return 'modest';
  return 'quiet';
}

export function classifyVolumeTrend(volumeChange: number | null): VolumeTrend {
  if (volumeChange === null) return 'unknown';
  if (volumeChange >= THRESHOLDS.volume.surging) return 'surging';
  if (volumeChange >= THRESHOLDS.volume.expanding) return 'expanding';
  if (volumeChange >= THRESHOLDS.volume.flatHigh) return 'expanding';
  if (volumeChange <= THRESHOLDS.volume.flatLow) return 'contracting';
  return 'flat';
}

export function classifyTurnover(turnover: number | null): TurnoverLevel {
  if (turnover === null) return 'unknown';
  if (turnover >= THRESHOLDS.turnover.elevated) return 'extreme';
  if (turnover >= THRESHOLDS.turnover.normal) return 'elevated';
  if (turnover >= THRESHOLDS.turnover.dormant) return 'normal';
  return 'dormant';
}

function classifyLiquidity(pairs: number | null): Signals['liquidityBreadth'] {
  if (pairs === null) return 'unknown';
  if (pairs >= THRESHOLDS.pairs.deep) return 'deep';
  if (pairs >= THRESHOLDS.pairs.thin) return 'moderate';
  return 'thin';
}

/**
 * 0 = volume gave the move no support, 1 = volume expanded dramatically.
 * Null when the plan/asset did not return volume_change_24h.
 */
export function volumeConfirmation(volumeChange: number | null): number | null {
  if (volumeChange === null) return null;
  if (volumeChange <= 0) return 0;
  return clamp(volumeChange / THRESHOLDS.volume.surging, 0, 1);
}

/** How much louder the volume move is than the price move. */
export function amplification(price24h: number | null, volumeChange: number | null): number | null {
  if (price24h === null || volumeChange === null) return null;
  const denominator = Math.max(Math.abs(price24h), 1);
  return volumeChange / denominator;
}

/** -1 (timeframes disagree) to 1 (1h, 24h and 7d all point the same way). */
export function trendAlignment(asset: AssetSnapshot): number {
  const values = [asset.percentChange1h, asset.percentChange24h, asset.percentChange7d].filter(
    (value): value is number => value !== null
  );
  if (values.length < 2) return 0;
  const signs = values.map((value) => Math.sign(value));
  const sum = signs.reduce((acc, sign) => acc + sign, 0);
  return sum / signs.length;
}

export function shortTermReversal(asset: AssetSnapshot): boolean {
  const { percentChange1h: hour, percentChange24h: day } = asset;
  if (hour === null || day === null) return false;
  if (Math.abs(day) < THRESHOLDS.move.noise) return false;
  return Math.sign(hour) !== Math.sign(day) && Math.abs(hour) >= 1;
}

function listMissing(asset: AssetSnapshot): string[] {
  const missing: string[] = [];
  if (asset.percentChange24h === null) missing.push('24h price change');
  if (asset.volumeChange24h === null) missing.push('24h volume change');
  if (asset.marketCap === null || asset.marketCap === 0) missing.push('market cap');
  if (asset.volume24h === null) missing.push('24h volume');
  if (asset.percentChange7d === null) missing.push('7d price change');
  return missing;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
