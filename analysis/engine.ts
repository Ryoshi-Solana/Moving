import { buildSignals, THRESHOLDS } from '@/analysis/signals';
import { formatCompactUsd, formatPercent, formatRatio } from '@/lib/format';
import type { Analysis, AssetSnapshot, Confidence, DataPoint, Driver, MarketStructure, Signals } from '@/types';

/**
 * Deterministic diagnosis engine.
 *
 * Every candidate driver scores itself from 0–100 against the signals. The
 * highest score becomes the primary driver; the highest-scoring candidate from
 * a different group becomes the secondary. Market structure is classified
 * separately, and the verdict is composed from the winning driver plus the
 * actual numbers behind it.
 *
 * Adding a new diagnosis means adding one entry to CANDIDATES — nothing else.
 */

const MIN_SECONDARY_SCORE = 25;

type Candidate = (signals: Signals, asset: AssetSnapshot) => Driver | null;

export function analyze(asset: AssetSnapshot): Analysis {
  const signals = buildSignals(asset);

  const drivers = CANDIDATES.map((candidate) => candidate(signals, asset))
    .filter((driver): driver is Driver => driver !== null && driver.score > 0)
    .sort((a, b) => b.score - a.score);

  const primary = drivers[0] ?? fallbackDriver(asset);
  const secondary =
    drivers.find((driver) => driver.group !== primary.group && driver.score >= MIN_SECONDARY_SCORE) ?? null;

  return {
    primary,
    secondary,
    structure: classifyStructure(signals),
    verdict: buildVerdict(primary, signals, asset),
    confidence: confidenceFrom(signals),
    dataUsed: buildDataUsed(asset, signals),
    missing: signals.missing,
    signals
  };
}

/* ------------------------------------------------------------------ *
 * Candidate drivers
 * ------------------------------------------------------------------ */

const volumeExpansion: Candidate = (s, asset) => {
  if (s.direction !== 'up') return null;
  if (s.volumeTrend !== 'expanding' && s.volumeTrend !== 'surging') return null;

  const confirmation = s.volumeConfirmation ?? 0;
  // When the move is extreme *and* turnover is extreme, "volume expansion" is
  // technically true but under-describes it — speculative-activity is the more
  // informative headline, so step aside and take the secondary slot instead.
  const overshadowed = s.moveSize === 'extreme' && s.turnoverLevel === 'extreme' ? 25 : 0;
  const score = 30 + 40 * confirmation + 25 * s.momentumStrength + (s.turnoverLevel === 'extreme' ? 5 : 0) - overshadowed;

  return {
    key: 'volume-expansion',
    group: 'volume',
    title: 'Volume expansion',
    tone: 'positive',
    score: round(score),
    explanation: `24h trading volume is up ${formatPercent(asset.volumeChange24h)} while price moved ${formatPercent(
      asset.percentChange24h
    )}. The move is being carried by a real increase in trading activity, not just a repricing on the same flow.`
  };
};

const broadParticipation: Candidate = (s, asset) => {
  if (s.direction !== 'up') return null;
  if (s.turnoverLevel !== 'elevated' && s.turnoverLevel !== 'extreme') return null;
  // 0 means the other timeframes are missing, not that they disagree.
  if (s.trendAlignment < 0) return null;

  const base = s.turnoverLevel === 'extreme' ? 48 : 36;
  const score = base + 20 * s.momentumStrength + 15 * Math.max(0, s.trendAlignment);

  return {
    key: 'broad-participation',
    group: 'participation',
    title: 'Broad market participation',
    tone: 'positive',
    score: round(score),
    explanation: `${formatCompactUsd(asset.volume24h)} changed hands against a ${formatCompactUsd(
      asset.marketCap
    )} market cap — turnover of ${formatRatio(s.turnover)}. Activity is spread across the book rather than sitting in one metric.`
  };
};

const thinLiquidityMomentum: Candidate = (s, asset) => {
  if (s.direction !== 'up') return null;
  if (s.moveSize === 'quiet') return null;

  const volumeLagging = s.volumeTrend === 'flat' || s.volumeTrend === 'contracting';
  const thinBook = s.liquidityBreadth === 'thin';
  const dormant = s.turnoverLevel === 'dormant';
  if (!volumeLagging && !thinBook && !dormant) return null;

  let score = 25 + 35 * s.momentumStrength;
  if (volumeLagging) score += 20;
  if (thinBook) score += 12;
  if (dormant) score += 10;

  const reason = volumeLagging
    ? `volume changed ${formatPercent(asset.volumeChange24h)} over the same window`
    : thinBook
      ? `the asset trades on only ${asset.numMarketPairs} market pairs`
      : `turnover is just ${formatRatio(s.turnover)} of market cap`;

  return {
    key: 'thin-liquidity-momentum',
    group: 'volume',
    title: 'Thin-liquidity momentum',
    tone: 'caution',
    score: round(score),
    explanation: `Price is up ${formatPercent(
      asset.percentChange24h
    )} but ${reason}. Moves that are not matched by trading activity tend to be easier to reverse.`
  };
};

const sellingPressure: Candidate = (s, asset) => {
  if (s.direction !== 'down') return null;
  if (s.volumeTrend !== 'expanding' && s.volumeTrend !== 'surging') return null;

  const confirmation = s.volumeConfirmation ?? 0;
  const score = 32 + 38 * confirmation + 25 * s.momentumStrength;

  return {
    key: 'selling-pressure',
    group: 'volume',
    title: 'Selling pressure',
    tone: 'negative',
    score: round(score),
    explanation: `Price is down ${formatPercent(asset.percentChange24h)} with volume up ${formatPercent(
      asset.volumeChange24h
    )}. Sellers are meeting real bids, which reads as active distribution rather than a quiet drift lower.`
  };
};

const fadingInterest: Candidate = (s, asset) => {
  if (s.direction !== 'down') return null;
  if (s.volumeTrend === 'expanding' || s.volumeTrend === 'surging') return null;

  const score = 26 + 30 * s.momentumStrength + (s.volumeTrend === 'contracting' ? 15 : 5);

  return {
    key: 'fading-interest',
    group: 'volume',
    title: 'Drift on thin flow',
    tone: 'neutral',
    score: round(score),
    explanation: `Price is down ${formatPercent(
      asset.percentChange24h
    )} without a matching pickup in volume. The data points to fading demand rather than an aggressive wave of selling.`
  };
};

const speculativeActivity: Candidate = (s, asset) => {
  if (s.moveSize !== 'extreme') return null;
  if (s.turnoverLevel !== 'extreme' && (s.volumeConfirmation ?? 0) < 0.6) return null;

  const score = 45 + 30 * s.momentumStrength + (s.turnoverLevel === 'extreme' ? 15 : 0);

  return {
    key: 'speculative-activity',
    group: 'participation',
    title: 'Speculative activity',
    tone: 'caution',
    score: round(score),
    explanation: `A ${formatPercent(asset.percentChange24h, { signed: false })} move with turnover at ${formatRatio(
      s.turnover
    )} of market cap is short-horizon trading behaviour. Data like this is usually associated with fast positioning on both sides.`
  };
};

const risingActivity: Candidate = (s, asset) => {
  if (s.moveSize !== 'quiet' && s.moveSize !== 'modest') return null;
  if (s.volumeTrend !== 'expanding' && s.volumeTrend !== 'surging') return null;
  if ((s.amplification ?? 0) < 4) return null;

  const score = 34 + 30 * (s.volumeConfirmation ?? 0) + (s.turnoverLevel === 'extreme' ? 12 : 0);

  return {
    key: 'rising-activity',
    group: 'volume',
    title: 'Rising market activity',
    tone: 'neutral',
    score: round(score),
    explanation: `Volume is up ${formatPercent(asset.volumeChange24h)} while price only moved ${formatPercent(
      asset.percentChange24h
    )}. Interest in the asset is rising well ahead of any decisive move in either direction.`
  };
};

const rangeConsolidation: Candidate = (s, asset) => {
  if (asset.percentChange24h === null) return null;
  if (s.moveSize !== 'quiet') return null;
  if (s.volumeTrend === 'expanding' || s.volumeTrend === 'surging') return null;

  const score = 22 + (s.turnoverLevel === 'dormant' ? 12 : 0);

  return {
    key: 'range-consolidation',
    group: 'structure-drift',
    title: 'No material move',
    tone: 'neutral',
    score: round(score),
    explanation: `Price is ${formatPercent(asset.percentChange24h)} over 24 hours on flat volume. There is no meaningful move here to explain.`
  };
};

const trendContinuation: Candidate = (s, asset) => {
  const day = asset.percentChange24h;
  const week = asset.percentChange7d;
  if (day === null || week === null) return null;
  if (Math.sign(day) !== Math.sign(week)) return null;
  if (Math.abs(day) < THRESHOLDS.move.noise || Math.abs(week) < 10) return null;

  const score = 28 + 22 * s.momentumStrength + 14 * Math.abs(s.trendAlignment);

  return {
    key: 'trend-continuation',
    group: 'trend',
    title: day > 0 ? 'Multi-day trend' : 'Multi-day downtrend',
    tone: day > 0 ? 'positive' : 'negative',
    score: round(score),
    explanation: `This is not a one-day event: the asset is ${formatPercent(week)} over 7 days and ${formatPercent(
      day
    )} over 24 hours. The 24h move extends a move that was already in place.`
  };
};

const shortTermTurn: Candidate = (s, asset) => {
  if (!s.shortTermReversal) return null;

  const score = 26 + 18 * Math.min(1, Math.abs(asset.percentChange1h ?? 0) / 5);

  return {
    key: 'short-term-turn',
    group: 'trend',
    title: 'Last hour turning',
    tone: 'caution',
    score: round(score),
    explanation: `The last hour (${formatPercent(asset.percentChange1h)}) runs against the 24h move (${formatPercent(
      asset.percentChange24h
    )}). The most recent flow is pointing the other way.`
  };
};

const CANDIDATES: Candidate[] = [
  volumeExpansion,
  broadParticipation,
  thinLiquidityMomentum,
  sellingPressure,
  fadingInterest,
  speculativeActivity,
  risingActivity,
  rangeConsolidation,
  trendContinuation,
  shortTermTurn
];

function fallbackDriver(asset: AssetSnapshot): Driver {
  return {
    key: 'insufficient-signal',
    group: 'none',
    title: 'No clear driver in the data',
    tone: 'neutral',
    score: 0,
    explanation: `The available market data for ${asset.symbol} does not show a dominant pattern. Price, volume and market cap are not diverging enough to point at one likely driver.`
  };
}

/* ------------------------------------------------------------------ *
 * Market structure
 * ------------------------------------------------------------------ */

export function classifyStructure(s: Signals): MarketStructure {
  if (s.missing.includes('24h price change')) {
    return {
      title: 'Not enough data',
      tone: 'neutral',
      explanation: 'Core price and volume metrics are unavailable for this asset, so market structure cannot be described.'
    };
  }

  const confirmed = (s.volumeConfirmation ?? 0) >= 0.15 || s.turnoverLevel === 'elevated' || s.turnoverLevel === 'extreme';

  if (s.moveSize === 'extreme' && s.turnoverLevel === 'extreme') {
    return {
      title: 'Reflexive and fast',
      tone: 'caution',
      explanation: 'Large price swings and very high turnover. Structure like this moves quickly in both directions.'
    };
  }

  if (s.direction === 'up') {
    return confirmed
      ? {
          title: 'Healthy momentum',
          tone: 'positive',
          explanation: 'Price appreciation is accompanied by stronger trading activity, which is the more durable version of an up move.'
        }
      : {
          title: 'Unconfirmed momentum',
          tone: 'caution',
          explanation: 'Price is rising faster than participation. Without volume behind it, the move rests on a thin base.'
        };
  }

  if (s.direction === 'down') {
    return confirmed
      ? {
          title: 'Active distribution',
          tone: 'negative',
          explanation: 'The decline is happening on elevated volume, which usually means positions are actually changing hands.'
        }
      : {
          title: 'Quiet drawdown',
          tone: 'neutral',
          explanation: 'Price is slipping on ordinary volume. This looks more like absent demand than heavy selling.'
        };
  }

  return confirmed
    ? {
        title: 'Active range',
        tone: 'neutral',
        explanation: 'Plenty of trading, little net price change. Buyers and sellers are currently balanced.'
      }
    : {
        title: 'Quiet consolidation',
        tone: 'neutral',
        explanation: 'Low activity and little movement. Nothing in the current data is pushing price either way.'
      };
}

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

export function buildVerdict(primary: Driver, s: Signals, asset: AssetSnapshot): string {
  const name = asset.symbol;
  const price = formatPercent(asset.percentChange24h);
  const volume = formatPercent(asset.volumeChange24h);

  switch (primary.key) {
    case 'volume-expansion':
      return `${name}'s move appears to be supported by a genuine expansion in trading activity. Volume is up ${volume} against a ${price} price change, which suggests the move is being carried by participation rather than a thin repricing. Based on available market data, that is the strongest signal here.`;

    case 'broad-participation':
      return `${name} is seeing unusually broad participation: ${formatCompactUsd(
        asset.volume24h
      )} of volume against a ${formatCompactUsd(asset.marketCap)} market cap. The data indicates buying interest is spread across the book rather than concentrated in a single metric.`;

    case 'thin-liquidity-momentum':
      return `${name} is up ${price}, but trading volume did not expand proportionally (${volume}). This may indicate thin-liquidity momentum rather than broad market participation — moves like this can retrace as quickly as they appear.`;

    case 'selling-pressure':
      return `${name} is down ${price} with volume up ${volume}. The data suggests active selling into real liquidity rather than a quiet fade, which is the more decisive form of a drawdown.`;

    case 'fading-interest':
      return `${name} is down ${price} without a matching rise in volume. Based on available data this looks like demand stepping back rather than a concerted wave of selling.`;

    case 'speculative-activity':
      return `${name} has moved ${price} with turnover at ${formatRatio(
        s.turnover
      )} of its market cap. That combination is characteristic of short-horizon speculative flow, and the data cannot tell you which side it resolves on.`;

    case 'rising-activity':
      return `${name} has only moved ${price}, but volume is up ${volume}. The likely driver is a build in market activity ahead of price — attention is rising faster than the quote is.`;

    case 'trend-continuation':
      return `${name}'s 24h move (${price}) extends a ${formatPercent(
        asset.percentChange7d
      )} run over 7 days. The available data suggests continuation of an existing trend rather than a fresh catalyst today.`;

    case 'short-term-turn':
      return `${name} is ${price} over 24 hours, but the last hour (${formatPercent(
        asset.percentChange1h
      )}) has turned the other way. The most recent data points to the move losing its footing.`;

    case 'range-consolidation':
      return `${name} has not made a material move: ${price} over 24 hours on ordinary volume. There is nothing in the current market data that needs explaining.`;

    default:
      return `The available market data for ${name} does not point to a single likely driver. Price, volume and market cap are broadly in line with each other, so no one metric stands out as the explanation.`;
  }
}

/* ------------------------------------------------------------------ *
 * Transparency + confidence
 * ------------------------------------------------------------------ */

export function buildDataUsed(asset: AssetSnapshot, s: Signals): DataPoint[] {
  const points: DataPoint[] = [];
  const add = (label: string, value: string, note?: string) => {
    if (value !== '—') points.push({ label, value, note });
  };

  add('Price 24h', formatPercent(asset.percentChange24h));
  add('Volume 24h', formatPercent(asset.volumeChange24h));
  // CoinMarketCap does not report a market-cap change field. This figure is
  // inferred from price at constant supply, and must always carry the label.
  add(
    'Market cap 24h',
    formatPercent(asset.marketCapChange24h),
    asset.marketCapChangeIsDerived ? 'derived, not reported by CMC' : undefined
  );
  add('Volume / market cap', formatRatio(s.turnover), s.turnoverLevel === 'unknown' ? undefined : s.turnoverLevel);
  add('Price 7d', formatPercent(asset.percentChange7d));
  add('Price 1h', formatPercent(asset.percentChange1h));
  if (asset.numMarketPairs !== null) add('Market pairs', String(asset.numMarketPairs), s.liquidityBreadth);

  return points;
}

export function confidenceFrom(s: Signals): Confidence {
  if (s.missing.length === 0) return 'high';
  if (s.missing.length <= 2 && !s.missing.includes('24h price change')) return 'moderate';
  return 'limited';
}

function round(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}
