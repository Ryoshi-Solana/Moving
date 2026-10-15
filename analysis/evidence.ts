import { THRESHOLDS } from '@/analysis/signals';
import { formatCompactUsd, formatPercent, formatRatio } from '@/lib/format';
import type { Analysis, AssetSnapshot, DriverTone, EvidenceFact, EvidenceReport } from '@/types';

/**
 * Evidence ledger: a presentation layer over the existing deterministic
 * analysis. It adds no scoring and never changes the primary driver, the
 * verdict, or confidence. It sorts what the data already shows into:
 *
 *   observed     — numbers reported by the data provider
 *   supporting   — observations consistent with the engine's reading
 *   opposing     — observations that cut against it
 *   invalidation — what would weaken the reading (interpretive guidance)
 *   watchNext    — metrics worth re-checking
 *   outsideData  — causes market data cannot see at all
 */
export function buildEvidence(asset: AssetSnapshot, analysis: Analysis): EvidenceReport {
  return {
    observed: observedFacts(asset, analysis),
    ...weighSignals(asset, analysis),
    invalidation: INVALIDATION[analysis.primary.key] ?? DEFAULT_INVALIDATION,
    watchNext: watchList(asset, analysis),
    outsideData: outsideData(asset)
  };
}

function toneOf(value: number | null): DriverTone {
  if (value === null || value === 0) return 'neutral';
  return value > 0 ? 'positive' : 'negative';
}

function observedFacts(asset: AssetSnapshot, analysis: Analysis): EvidenceFact[] {
  const facts: EvidenceFact[] = [];
  const add = (label: string, value: string, tone: DriverTone) => {
    if (value !== '—') facts.push({ label, value, tone });
  };

  add('Price, 1h', formatPercent(asset.percentChange1h), toneOf(asset.percentChange1h));
  add('Price, 24h', formatPercent(asset.percentChange24h), toneOf(asset.percentChange24h));
  add('Price, 7d', formatPercent(asset.percentChange7d), toneOf(asset.percentChange7d));
  add('Volume vs prior 24h', formatPercent(asset.volumeChange24h), toneOf(asset.volumeChange24h));
  add('24h volume', formatCompactUsd(asset.volume24h), 'neutral');
  add('Volume / market cap', formatRatio(analysis.signals.turnover), 'neutral');
  if (asset.numMarketPairs !== null) add('Market pairs', asset.numMarketPairs.toLocaleString('en-US'), 'neutral');

  const dex = asset.dex;
  if (dex) {
    add('Pool liquidity', formatCompactUsd(dex.liquidityUsd), 'neutral');
    const day = dex.txns.h24;
    if (day && day.buys + day.sells > 0) {
      add('Buys / sells, 24h', `${day.buys.toLocaleString('en-US')} / ${day.sells.toLocaleString('en-US')}`, day.buys >= day.sells ? 'positive' : 'negative');
    }
    add('Price, 5m', formatPercent(dex.priceChange.m5), toneOf(dex.priceChange.m5));
    add('Price, 6h', formatPercent(dex.priceChange.h6), toneOf(dex.priceChange.h6));
  }
  return facts;
}

function weighSignals(asset: AssetSnapshot, analysis: Analysis): Pick<EvidenceReport, 'supporting' | 'opposing'> {
  const s = analysis.signals;
  const supporting: string[] = [];
  const opposing: string[] = [];
  const price = formatPercent(asset.percentChange24h);
  const volume = formatPercent(asset.volumeChange24h);
  const volumeUp = s.volumeTrend === 'expanding' || s.volumeTrend === 'surging';
  const volumeDown = s.volumeTrend === 'contracting' || s.volumeTrend === 'flat';

  if (s.direction === 'flat') {
    supporting.push(`Price is within the ±${THRESHOLDS.move.noise}% noise band (${price}), so there is no large move to explain.`);
    if (volumeUp) opposing.push(`Volume is up ${volume} even though price is flat — activity is building without a direction yet.`);
  } else {
    const side = s.direction === 'up' ? 'rise' : 'decline';
    if (volumeUp) supporting.push(`Volume rose ${volume} alongside the ${price} ${side}, so more trading backs the move.`);
    else if (volumeDown) opposing.push(`Volume changed ${volume} — the ${side} is not backed by expanding activity.`);

    if (s.trendAlignment >= 0.6) supporting.push('The 1h, 24h and 7d changes all point the same way.');
    else if (s.trendAlignment <= -0.3) opposing.push('The 1h, 24h and 7d changes disagree on direction.');

    if (s.shortTermReversal) opposing.push(`The last hour (${formatPercent(asset.percentChange1h)}) runs against the 24h move.`);
  }

  if (s.turnoverLevel === 'elevated' || s.turnoverLevel === 'extreme') {
    supporting.push(`Turnover of ${formatRatio(s.turnover)} of market cap shows the asset is actively traded for its size.`);
  } else if (s.turnoverLevel === 'dormant') {
    opposing.push(`Turnover is only ${formatRatio(s.turnover)} of market cap — little of the supply is changing hands.`);
  }

  if (s.liquidityBreadth === 'deep') supporting.push(`It trades on ${asset.numMarketPairs?.toLocaleString('en-US')} market pairs, so one venue is unlikely to dominate the quote.`);
  if (s.liquidityBreadth === 'thin') opposing.push(`Only ${asset.numMarketPairs} market pairs — a few venues can move the quote.`);

  const dex = asset.dex;
  if (dex?.txns.h24) {
    const { buys, sells } = dex.txns.h24;
    const total = buys + sells;
    if (total >= 20) {
      const share = buys / total;
      const note = `${Math.round(share * 100)}% of ${total.toLocaleString('en-US')} pool transactions in 24h were buys.`;
      if ((s.direction === 'up' && share >= 0.55) || (s.direction === 'down' && share <= 0.45)) supporting.push(note);
      else if ((s.direction === 'up' && share <= 0.45) || (s.direction === 'down' && share >= 0.55)) opposing.push(note);
    }
  }
  if (dex && dex.liquidityUsd !== null && asset.volume24h !== null && dex.liquidityUsd > 0) {
    const ratio = asset.volume24h / dex.liquidityUsd;
    if (ratio >= 10) opposing.push(`24h volume is ${ratio.toFixed(0)}× the pool's liquidity — a shallow pool relative to the flow through it.`);
  }

  if (analysis.missing.length > 0) {
    opposing.push(`Not reported for this asset: ${analysis.missing.join(', ')}. The reading uses what remains.`);
  }

  return { supporting, opposing };
}

const DEFAULT_INVALIDATION =
  'A decisive move in either direction with a clear change in volume would replace this reading.';

/** Interpretive, per-driver: what observation would weaken the current reading. */
const INVALIDATION: Record<string, string> = {
  'volume-expansion': 'Volume falling back toward its prior level while price holds would mean the move is no longer carried by new participation.',
  'broad-participation': 'Turnover dropping back to normal levels would mean the unusual participation has faded.',
  'thin-liquidity-momentum': 'Volume catching up with price would turn this into a confirmed move; price giving back the gain on low volume would confirm the thin-liquidity reading.',
  'selling-pressure': 'Volume drying up while price stabilises would suggest the selling has been absorbed.',
  'fading-interest': 'A pickup in volume — in either direction — would mean demand is no longer simply stepping back.',
  'speculative-activity': 'Turnover normalising would mean the short-horizon flow has left; until then, direction can flip quickly.',
  'rising-activity': 'Volume reverting without any price follow-through would mean the activity was noise rather than a build-up.',
  'range-consolidation': 'A move beyond the noise band on expanding volume would end the quiet reading.',
  'trend-continuation': 'A 24h move against the 7d direction would mean the existing trend has stalled.',
  'short-term-turn': 'The next hours moving back in the 24h direction would show the hourly turn was only a pause.'
};

function watchList(asset: AssetSnapshot, analysis: Analysis): string[] {
  const s = analysis.signals;
  const list: string[] = [];
  if (asset.volumeChange24h !== null) list.push('24h volume change — does participation keep up with price?');
  else list.push('24h volume — the provider did not report its change, so compare it against a later check.');
  if (asset.percentChange1h !== null) list.push('The 1h change against the 24h direction — the earliest sign of a turn.');
  if (s.turnover !== null) list.push('Volume / market cap — whether trading stays unusually heavy for the asset’s size.');
  if (asset.dex) list.push('Pool liquidity and buy/sell counts on the DexScreener pair page.');
  return list.slice(0, 4);
}

function outsideData(asset: AssetSnapshot): string[] {
  const list = [
    'News, announcements and exchange listings',
    'Social-media attention and influencer activity',
    'Individual wallet flows, including large holders',
    'Token unlocks and supply schedules'
  ];
  if (asset.dataSource === 'DexScreener') list.push('Activity in other pools for this token — figures describe one pool');
  return list;
}
