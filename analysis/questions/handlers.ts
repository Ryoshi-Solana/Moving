import { formatCompactUsd, formatPercent, formatRatio } from '@/lib/format';
import { biggestChange, collectChangeMetrics, fastestOf, readMomentumTrend, readTrendVsWeek } from '@/analysis/questions/shared';
import type { AssetSnapshot, DataPoint, MarketContext, QuestionAnswer, Signals } from '@/types';

/**
 * Each handler is a pure function: (asset, signals, context) → QuestionAnswer.
 * No React, no fetching — these run identically on the server or the client,
 * which is what lets Tier-1 questions (everything except CONTEXT/DISCOVERY)
 * answer instantly with data the browser already has.
 */

function dp(label: string, value: string, note?: string): DataPoint {
  return { label, value, note };
}

/* ------------------------------------------------------------------ *
 * A. WHY
 * ------------------------------------------------------------------ */

export function whyVolumeSpike(asset: AssetSnapshot, s: Signals): QuestionAnswer {
  const confirmation = s.volumeConfirmation ?? 0;
  const strength = confirmation >= 0.6 ? 'a large' : confirmation >= 0.25 ? 'a meaningful' : 'a modest';
  return {
    id: 'WHY_VOLUME_SPIKE',
    title: 'Why did the volume spike?',
    tone: 'positive',
    summary: `24h volume is up ${formatPercent(asset.volumeChange24h)}, ${strength} increase relative to the ${formatPercent(
      asset.percentChange24h
    )} price move. The data shows more trading activity alongside the price change, but it cannot say what specifically triggered it.`,
    dataUsed: [
      dp('Volume 24h', formatCompactUsd(asset.volume24h)),
      dp('Volume change 24h', formatPercent(asset.volumeChange24h)),
      dp('Price change 24h', formatPercent(asset.percentChange24h)),
      dp('Volume / market cap', formatRatio(s.turnover))
    ]
  };
}

export function topDriver(asset: AssetSnapshot, s: Signals, primaryTitle: string, primaryExplanation: string): QuestionAnswer {
  return {
    id: 'TOP_DRIVER',
    title: "What's driving the move the most?",
    tone: 'neutral',
    summary: `Based on the deterministic ranking, the strongest signal is "${primaryTitle}." ${primaryExplanation}`,
    dataUsed: [
      dp('Price 24h', formatPercent(asset.percentChange24h)),
      dp('Volume 24h', formatPercent(asset.volumeChange24h)),
      dp('Volume / market cap', formatRatio(s.turnover))
    ]
  };
}

export function whyDrop(asset: AssetSnapshot, s: Signals): QuestionAnswer {
  const confirmation = s.volumeConfirmation ?? 0;
  const read =
    confirmation >= 0.25
      ? 'Volume expanded alongside the decline, which reads as active selling into real liquidity.'
      : 'Volume did not expand much alongside the decline, which reads more like fading demand than aggressive selling.';
  return {
    id: 'WHY_DROP',
    title: 'Why is this coin dropping?',
    tone: 'negative',
    summary: `${asset.symbol} is down ${formatPercent(asset.percentChange24h)} over 24 hours (7d: ${formatPercent(
      asset.percentChange7d
    )}). ${read}`,
    dataUsed: [
      dp('Price 1h', formatPercent(asset.percentChange1h)),
      dp('Price 24h', formatPercent(asset.percentChange24h)),
      dp('Price 7d', formatPercent(asset.percentChange7d)),
      dp('Volume change 24h', formatPercent(asset.volumeChange24h))
    ]
  };
}

export function cexVsDex(asset: AssetSnapshot): QuestionAnswer {
  const cex = asset.cexVolume24h ?? 0;
  const dex = asset.dexVolume24h ?? 0;
  const total = cex + dex;
  const cexShare = total > 0 ? (cex / total) * 100 : null;
  const larger = cex >= dex ? 'centralized exchanges' : 'decentralized exchanges';
  return {
    id: 'CEX_VS_DEX',
    title: 'Is this mostly CEX or DEX activity?',
    tone: 'neutral',
    summary:
      cexShare === null
        ? 'CEX/DEX volume data is not available for this asset.'
        : `Of the reported 24h volume, ${larger} represent the larger share (${formatPercent(cexShare, { signed: false })} CEX).`,
    dataUsed: [dp('CEX volume 24h', formatCompactUsd(asset.cexVolume24h)), dp('DEX volume 24h', formatCompactUsd(asset.dexVolume24h))]
  };
}

export function priceVolumeImbalance(asset: AssetSnapshot, s: Signals): QuestionAnswer {
  return {
    id: 'PRICE_VOLUME_IMBALANCE',
    title: 'Why is price moving more than volume?',
    tone: 'caution',
    summary: `Price moved ${formatPercent(asset.percentChange24h)} while volume changed only ${formatPercent(
      asset.volumeChange24h
    )} over the same window. The price move is not being matched by a proportional rise in trading activity, which the data suggests is worth treating cautiously.`,
    dataUsed: [
      dp('Price 24h', formatPercent(asset.percentChange24h)),
      dp('Volume change 24h', formatPercent(asset.volumeChange24h)),
      dp('Volume / market cap', formatRatio(s.turnover))
    ]
  };
}

/* ------------------------------------------------------------------ *
 * B. STRENGTH
 * ------------------------------------------------------------------ */

export function momentumStrength(asset: AssetSnapshot): QuestionAnswer {
  const read = readMomentumTrend(asset);
  const copy: Record<typeof read, string> = {
    accelerating: 'The last hour is pacing well ahead of the 24h average, which suggests the move is accelerating.',
    fading: 'The last hour is pacing well behind the 24h average, which suggests the move is losing steam.',
    steady:
      'The last hour is pacing roughly in line with the 24h average — the move looks stable rather than speeding up or slowing down.',
    mixed: 'The last hour is pointing against the 24h direction, so the short-term picture is mixed.',
    unknown: 'There is not enough short-term data to say whether the move is strengthening or fading.'
  };
  return {
    id: 'MOMENTUM_STRENGTH',
    title: 'Is this move getting stronger?',
    tone: read === 'accelerating' ? 'positive' : read === 'fading' ? 'caution' : 'neutral',
    summary: copy[read],
    dataUsed: [dp('Price 1h', formatPercent(asset.percentChange1h)), dp('Price 24h', formatPercent(asset.percentChange24h))]
  };
}

export function volumeConfirmationAnswer(asset: AssetSnapshot, s: Signals): QuestionAnswer {
  const confirmation = s.volumeConfirmation;
  const confirmed = (confirmation ?? 0) >= 0.15 || s.turnoverLevel === 'elevated' || s.turnoverLevel === 'extreme';
  return {
    id: 'VOLUME_CONFIRMATION',
    title: 'Is volume confirming the move?',
    tone: confirmed ? 'positive' : 'caution',
    summary:
      asset.volumeChange24h === null
        ? 'Volume change data is not available for this asset, so confirmation cannot be assessed.'
        : confirmed
          ? `Yes — volume is up ${formatPercent(asset.volumeChange24h)}, which supports the ${
              asset.percentChange24h && asset.percentChange24h > 0 ? 'upward' : 'downward'
            } price move.`
          : `Not strongly — volume changed only ${formatPercent(asset.volumeChange24h)}, which does not clearly back the price move.`,
    dataUsed: [
      dp('Volume change 24h', formatPercent(asset.volumeChange24h)),
      dp('Volume / market cap', formatRatio(s.turnover)),
      dp('Price 24h', formatPercent(asset.percentChange24h))
    ]
  };
}

export function momentumDirection(asset: AssetSnapshot): QuestionAnswer {
  const read = readTrendVsWeek(asset);
  const copy: Record<typeof read, string> = {
    accelerating: `The 24h move (${formatPercent(
      asset.percentChange24h
    )}) is running well ahead of the 7d daily pace, suggesting momentum is building.`,
    fading: `The 24h move (${formatPercent(
      asset.percentChange24h
    )}) is running behind the 7d daily pace, suggesting momentum is fading relative to the recent trend.`,
    steady: `The 24h move is roughly in line with the 7d pace — momentum looks steady rather than shifting.`,
    mixed: `The 24h direction is running against the 7d trend, so the medium-term picture is mixed.`,
    unknown: 'There is not enough 7-day data to compare against the 24h move.'
  };
  return {
    id: 'MOMENTUM_DIRECTION',
    title: 'Is momentum accelerating or fading?',
    tone: read === 'accelerating' ? 'positive' : read === 'fading' || read === 'mixed' ? 'caution' : 'neutral',
    summary: copy[read],
    dataUsed: [dp('Price 24h', formatPercent(asset.percentChange24h)), dp('Price 7d', formatPercent(asset.percentChange7d))]
  };
}

export function activityIntensity(asset: AssetSnapshot, s: Signals): QuestionAnswer {
  const level = s.turnoverLevel;
  const copy: Record<typeof level, string> = {
    extreme: 'Turnover relative to market cap is very high — activity here is elevated well beyond typical levels.',
    elevated: 'Turnover relative to market cap is elevated — more of the asset is changing hands than usual.',
    normal: 'Turnover relative to market cap is in a normal range — nothing unusual about current activity levels.',
    dormant: 'Turnover relative to market cap is low — trading activity is muted right now.',
    unknown: 'Not enough data to assess how unusual current activity is.'
  };
  return {
    id: 'ACTIVITY_INTENSITY',
    title: 'Is current activity unusually strong?',
    tone: level === 'extreme' || level === 'elevated' ? 'positive' : level === 'dormant' ? 'caution' : 'neutral',
    summary: copy[level],
    dataUsed: [
      dp('Volume / market cap', formatRatio(s.turnover), level === 'unknown' ? undefined : level),
      dp('Volume change 24h', formatPercent(asset.volumeChange24h))
    ]
  };
}

/* ------------------------------------------------------------------ *
 * C. CHANGE
 * ------------------------------------------------------------------ */

export function whatChanged(asset: AssetSnapshot): QuestionAnswer {
  const metrics = collectChangeMetrics(asset);
  const biggest = biggestChange(asset);
  return {
    id: 'WHAT_CHANGED',
    title: 'What changed recently?',
    tone: 'neutral',
    summary: biggest
      ? `Across the metrics available, ${biggest.label.toLowerCase()} moved the most (${biggest.formatted}).`
      : 'Not enough data is available to summarize recent change.',
    dataUsed: metrics.map((m) => dp(m.label, m.formatted))
  };
}

export function fastestChange(asset: AssetSnapshot): QuestionAnswer {
  const metrics = collectChangeMetrics(asset);
  const sorted = metrics.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const first = fastestOf(metrics);
  const second = sorted[1];
  return {
    id: 'FASTEST_CHANGE',
    title: "What's changing fastest?",
    tone: 'neutral',
    summary: first
      ? second
        ? `${first.label} is changing fastest (${first.formatted}), ahead of ${second.label.toLowerCase()} (${second.formatted}).`
        : `${first.label} is the only measurable change available (${first.formatted}).`
      : 'Not enough comparable metrics are available.',
    dataUsed: metrics.map((m) => dp(m.label, m.formatted))
  };
}

export function shortVsLong(asset: AssetSnapshot, s: Signals): QuestionAnswer {
  const alignment = s.trendAlignment;
  const read: 'consistent' | 'diverging' | 'reversing' =
    alignment >= 0.66 ? 'consistent' : alignment <= -0.34 ? 'reversing' : 'diverging';
  const copy: Record<'consistent' | 'diverging' | 'reversing', string> = {
    consistent: 'The 1h, 24h and 7d readings all point the same way — the short and long-term pictures agree.',
    diverging: 'The 1h, 24h and 7d readings do not all agree — the short and long-term pictures are diverging.',
    reversing:
      'The short-term reading is running opposite to the longer-term trend, which looks like a possible reversal in progress.'
  };
  return {
    id: 'SHORT_VS_LONG',
    title: "What's different from the broader trend?",
    tone: read === 'reversing' ? 'caution' : 'neutral',
    summary: copy[read],
    dataUsed: [
      dp('Price 1h', formatPercent(asset.percentChange1h)),
      dp('Price 24h', formatPercent(asset.percentChange24h)),
      dp('Price 7d', formatPercent(asset.percentChange7d))
    ]
  };
}

/* ------------------------------------------------------------------ *
 * D. CONTEXT — all require ctx.context.btc
 * ------------------------------------------------------------------ */

export function marketContext(asset: AssetSnapshot, context: MarketContext): QuestionAnswer {
  const btc = context.btc;
  if (!btc || btc.percentChange24h === null || asset.percentChange24h === null) {
    return {
      id: 'MARKET_CONTEXT',
      title: 'Is the whole market moving too?',
      tone: 'neutral',
      summary: 'Market-wide data is not available right now.',
      dataUsed: []
    };
  }
  const sameDirection = Math.sign(btc.percentChange24h) === Math.sign(asset.percentChange24h);
  const globalLine = context.global?.totalMarketCap
    ? ` Total crypto market cap is ${formatCompactUsd(context.global.totalMarketCap)}.`
    : '';
  return {
    id: 'MARKET_CONTEXT',
    title: 'Is the whole market moving too?',
    tone: 'neutral',
    summary: sameDirection
      ? `BTC is ${formatPercent(
          btc.percentChange24h
        )} over the same 24h window, the same direction as ${asset.symbol}. The move does not look isolated.${globalLine}`
      : `BTC is ${formatPercent(
          btc.percentChange24h
        )} over 24h, the opposite direction from ${asset.symbol}. This move looks specific to ${asset.symbol} rather than market-wide.${globalLine}`,
    dataUsed: [
      dp(`${asset.symbol} 24h`, formatPercent(asset.percentChange24h)),
      dp('BTC 24h', formatPercent(btc.percentChange24h)),
      ...(context.global?.totalMarketCap ? [dp('Total market cap', formatCompactUsd(context.global.totalMarketCap))] : [])
    ]
  };
}

export function vsBtc(asset: AssetSnapshot, context: MarketContext): QuestionAnswer {
  const btc = context.btc;
  if (!btc || btc.percentChange24h === null || asset.percentChange24h === null) {
    return {
      id: 'VS_BTC',
      title: 'Is this coin outperforming BTC?',
      tone: 'neutral',
      summary: 'BTC comparison data is not available right now.',
      dataUsed: []
    };
  }
  const diff = asset.percentChange24h - btc.percentChange24h;
  const outperforming = diff > 0;
  return {
    id: 'VS_BTC',
    title: 'Is this coin outperforming BTC?',
    tone: outperforming ? 'positive' : 'caution',
    summary: `${asset.symbol} is ${formatPercent(asset.percentChange24h)} over 24h vs BTC's ${formatPercent(
      btc.percentChange24h
    )} — that's ${formatPercent(Math.abs(diff), { signed: false })} ${outperforming ? 'ahead of' : 'behind'} BTC over the same window.`,
    dataUsed: [dp(`${asset.symbol} 24h`, formatPercent(asset.percentChange24h)), dp('BTC 24h', formatPercent(btc.percentChange24h))]
  };
}

export function isolatedOrMarketwide(asset: AssetSnapshot, context: MarketContext): QuestionAnswer {
  const btc = context.btc;
  if (!btc || btc.percentChange24h === null || asset.percentChange24h === null) {
    return {
      id: 'ISOLATED_OR_MARKETWIDE',
      title: 'Is this an isolated move or a market-wide move?',
      tone: 'neutral',
      summary: 'Not enough market data to classify this move.',
      dataUsed: []
    };
  }
  const gap = Math.abs(asset.percentChange24h - btc.percentChange24h);
  const classification = gap < 3 ? 'broadly aligned' : gap < 12 ? 'moderately divergent' : 'strongly divergent';
  return {
    id: 'ISOLATED_OR_MARKETWIDE',
    title: 'Is this an isolated move or a market-wide move?',
    tone: classification === 'strongly divergent' ? 'caution' : 'neutral',
    summary: `${asset.symbol}'s 24h move is ${classification} with BTC's (a ${formatPercent(gap, {
      signed: false
    })} gap). ${
      classification === 'broadly aligned'
        ? 'This looks like part of a wider market move.'
        : 'This looks specific to this asset rather than the market as a whole.'
    }`,
    dataUsed: [dp(`${asset.symbol} 24h`, formatPercent(asset.percentChange24h)), dp('BTC 24h', formatPercent(btc.percentChange24h))]
  };
}

export function relativeStrength(asset: AssetSnapshot, context: MarketContext): QuestionAnswer {
  const btc = context.btc;
  if (!btc || btc.percentChange24h === null || asset.percentChange24h === null) {
    return {
      id: 'RELATIVE_STRENGTH',
      title: 'Is this move stronger than the broader market?',
      tone: 'neutral',
      summary: 'Not enough market data for this comparison.',
      dataUsed: []
    };
  }
  const stronger = Math.abs(asset.percentChange24h) > Math.abs(btc.percentChange24h);
  return {
    id: 'RELATIVE_STRENGTH',
    title: 'Is this move stronger than the broader market?',
    tone: stronger ? 'positive' : 'neutral',
    summary: `${asset.symbol} moved ${formatPercent(asset.percentChange24h, {
      signed: false
    })} in magnitude over 24h, ${stronger ? 'more than' : 'less than'} BTC's ${formatPercent(btc.percentChange24h, {
      signed: false
    })}.`,
    dataUsed: [dp(`${asset.symbol} 24h`, formatPercent(asset.percentChange24h)), dp('BTC 24h', formatPercent(btc.percentChange24h))]
  };
}

/* ------------------------------------------------------------------ *
 * E. DISCOVERY — both require ctx.context.movers
 * ------------------------------------------------------------------ */

export function discoverAnother(asset: AssetSnapshot, context: MarketContext): QuestionAnswer {
  const movers = context.movers ?? [];
  const next = movers.find((m) => m.id !== asset.id) ?? null;
  return {
    id: 'DISCOVER_ANOTHER',
    title: 'Show me another moving coin',
    tone: 'neutral',
    summary: next
      ? `${next.symbol} is currently ${formatPercent(next.percentChange24h)} over 24h — one of the more active movers right now.`
      : 'No other movers are available right now.',
    dataUsed: next ? [dp(next.symbol, formatPercent(next.percentChange24h))] : []
  };
}

export function marketMovers(asset: AssetSnapshot, context: MarketContext): QuestionAnswer {
  const movers = (context.movers ?? []).filter((m) => m.id !== asset.id).slice(0, 3);
  return {
    id: 'MARKET_MOVERS',
    title: "Show me what's moving right now",
    tone: 'neutral',
    summary:
      movers.length > 0
        ? `Top movers right now: ${movers.map((m) => `${m.symbol} (${formatPercent(m.percentChange24h)})`).join(', ')}.`
        : 'No mover data is available right now.',
    dataUsed: movers.map((m) => dp(m.symbol, formatPercent(m.percentChange24h)))
  };
}
