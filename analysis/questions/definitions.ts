import * as handlers from '@/analysis/questions/handlers';
import { collectChangeMetrics } from '@/analysis/questions/shared';
import type { QuestionDefinition, QuestionEngineContext } from '@/types';

/**
 * The question library. Every entry is data-gated: `isEligible` must confirm
 * the required fields are actually present and valid before the question is
 * ever offered — see section 10 of the spec ("do not create unsupported
 * questions"). `priority` only runs on questions that already passed
 * eligibility, so it can assume the data it reads exists.
 *
 * Discovery questions (DISCOVER_ANOTHER, MARKET_MOVERS) are defined here for
 * completeness and unit testing, but the "What do you want to know next?"
 * selector (selector.ts) deliberately excludes the DISCOVERY category — that
 * category powers the separate "Done exploring?" footer instead (see
 * components/Investigation.tsx), matching the spec's treatment of it as a
 * distinct, independently-gated module rather than a competing next-question.
 */

function s(ctx: QuestionEngineContext) {
  return ctx.analysis.signals;
}

export const QUESTIONS: QuestionDefinition[] = [
  // ---------------- A. WHY ----------------
  {
    id: 'WHY_VOLUME_SPIKE',
    category: 'WHY',
    label: 'Why did the volume spike?',
    requires: ['base'],
    isEligible: (ctx) => {
      const sig = s(ctx);
      return sig.volumeTrend === 'expanding' || sig.volumeTrend === 'surging';
    },
    priority: (ctx) => 60 + (s(ctx).volumeConfirmation ?? 0) * 30 + s(ctx).momentumStrength * 10,
    answer: (ctx) => handlers.whyVolumeSpike(ctx.asset, s(ctx))
  },
  {
    id: 'TOP_DRIVER',
    category: 'WHY',
    label: "What's driving the move the most?",
    requires: ['base'],
    isEligible: () => true,
    // Low, flat priority: a reliable fallback, not a headline question — it
    // mostly surfaces when quieter assets leave little else to ask.
    priority: () => 28,
    answer: (ctx) => handlers.topDriver(ctx.asset, s(ctx), ctx.analysis.primary.title, ctx.analysis.primary.explanation)
  },
  {
    id: 'WHY_DROP',
    category: 'WHY',
    label: 'Why is this coin dropping?',
    requires: ['base'],
    isEligible: (ctx) => s(ctx).direction === 'down' && s(ctx).moveSize !== 'quiet',
    priority: (ctx) => 65 + s(ctx).momentumStrength * 25,
    answer: (ctx) => handlers.whyDrop(ctx.asset, s(ctx))
  },
  {
    id: 'CEX_VS_DEX',
    category: 'WHY',
    label: 'Is this mostly CEX or DEX activity?',
    requires: ['cexdex'],
    // The Basic-plan quotes endpoint this app uses never populates these
    // fields (see AssetSnapshot's comment on cexVolume24h/dexVolume24h), so
    // this stays permanently gated off rather than guessing a split.
    isEligible: (ctx) => ctx.asset.cexVolume24h !== null && ctx.asset.dexVolume24h !== null,
    priority: () => 50,
    answer: (ctx) => handlers.cexVsDex(ctx.asset)
  },
  {
    id: 'PRICE_VOLUME_IMBALANCE',
    category: 'WHY',
    label: 'Why is price moving more than volume?',
    requires: ['base'],
    isEligible: (ctx) => {
      const sig = s(ctx);
      return sig.moveSize !== 'quiet' && ctx.asset.volumeChange24h !== null && (sig.volumeConfirmation ?? 1) < 0.2;
    },
    priority: (ctx) => 55 + s(ctx).momentumStrength * 20,
    answer: (ctx) => handlers.priceVolumeImbalance(ctx.asset, s(ctx))
  },

  // ---------------- B. STRENGTH ----------------
  {
    id: 'MOMENTUM_STRENGTH',
    category: 'STRENGTH',
    label: 'Is this move getting stronger?',
    requires: ['base'],
    isEligible: (ctx) => s(ctx).moveSize !== 'quiet' && ctx.asset.percentChange1h !== null,
    priority: (ctx) => 50 + s(ctx).momentumStrength * 20,
    answer: (ctx) => handlers.momentumStrength(ctx.asset)
  },
  {
    id: 'VOLUME_CONFIRMATION',
    category: 'STRENGTH',
    label: 'Is volume confirming the move?',
    requires: ['base'],
    isEligible: (ctx) => ctx.asset.volumeChange24h !== null,
    priority: (ctx) => 40 + s(ctx).momentumStrength * 15,
    answer: (ctx) => handlers.volumeConfirmationAnswer(ctx.asset, s(ctx))
  },
  {
    id: 'MOMENTUM_DIRECTION',
    category: 'STRENGTH',
    label: 'Is momentum accelerating or fading?',
    requires: ['base'],
    isEligible: (ctx) => ctx.asset.percentChange24h !== null && ctx.asset.percentChange7d !== null,
    priority: (ctx) => 38 + s(ctx).momentumStrength * 12,
    answer: (ctx) => handlers.momentumDirection(ctx.asset)
  },
  {
    id: 'ACTIVITY_INTENSITY',
    category: 'STRENGTH',
    label: 'Is current activity unusually strong?',
    requires: ['base'],
    isEligible: (ctx) => s(ctx).turnover !== null,
    priority: (ctx) => 35 + (s(ctx).turnoverLevel === 'extreme' ? 20 : s(ctx).turnoverLevel === 'dormant' ? 15 : 0),
    answer: (ctx) => handlers.activityIntensity(ctx.asset, s(ctx))
  },

  // ---------------- C. CHANGE ----------------
  {
    id: 'WHAT_CHANGED',
    category: 'CHANGE',
    label: 'What changed recently?',
    requires: ['base'],
    isEligible: (ctx) => collectChangeMetrics(ctx.asset).length >= 1,
    priority: (ctx) => 25 + (s(ctx).moveSize === 'quiet' ? 15 : 0),
    answer: (ctx) => handlers.whatChanged(ctx.asset)
  },
  {
    id: 'FASTEST_CHANGE',
    category: 'CHANGE',
    label: "What's changing fastest?",
    requires: ['base'],
    isEligible: (ctx) => collectChangeMetrics(ctx.asset).length >= 2,
    priority: (ctx) => 22 + (s(ctx).amplification !== null && s(ctx).amplification! > 4 ? 20 : 0),
    answer: (ctx) => handlers.fastestChange(ctx.asset)
  },
  {
    id: 'SHORT_VS_LONG',
    category: 'CHANGE',
    label: "What's different from the broader trend?",
    requires: ['base'],
    isEligible: (ctx) =>
      ctx.asset.percentChange1h !== null && ctx.asset.percentChange24h !== null && ctx.asset.percentChange7d !== null,
    priority: (ctx) => 30 + (s(ctx).shortTermReversal ? 25 : 0),
    answer: (ctx) => handlers.shortVsLong(ctx.asset, s(ctx))
  },

  // ---------------- D. CONTEXT ----------------
  {
    id: 'MARKET_CONTEXT',
    category: 'CONTEXT',
    label: 'Is the whole market moving too?',
    requires: ['btc'],
    isEligible: (ctx) => btcReady(ctx),
    priority: (ctx) => 35 + s(ctx).momentumStrength * 8,
    answer: (ctx) => handlers.marketContext(ctx.asset, ctx.context)
  },
  {
    id: 'VS_BTC',
    category: 'CONTEXT',
    label: 'Is this coin outperforming BTC?',
    requires: ['btc'],
    isEligible: (ctx) => btcReady(ctx),
    priority: (ctx) => {
      const diff = Math.abs((ctx.asset.percentChange24h ?? 0) - (ctx.context.btc?.percentChange24h ?? 0));
      return 30 + Math.min(30, diff * 1.5);
    },
    answer: (ctx) => handlers.vsBtc(ctx.asset, ctx.context)
  },
  {
    id: 'ISOLATED_OR_MARKETWIDE',
    category: 'CONTEXT',
    label: 'Is this an isolated move or a market-wide move?',
    requires: ['btc'],
    isEligible: (ctx) => btcReady(ctx),
    priority: (ctx) => {
      const gap = Math.abs((ctx.asset.percentChange24h ?? 0) - (ctx.context.btc?.percentChange24h ?? 0));
      return 28 + (gap > 12 ? 22 : gap < 3 ? 12 : 6);
    },
    answer: (ctx) => handlers.isolatedOrMarketwide(ctx.asset, ctx.context)
  },
  {
    id: 'RELATIVE_STRENGTH',
    category: 'CONTEXT',
    label: 'Is this move stronger than the broader market?',
    requires: ['btc'],
    isEligible: (ctx) => btcReady(ctx),
    priority: (ctx) => {
      const extra = Math.abs(ctx.asset.percentChange24h ?? 0) - Math.abs(ctx.context.btc?.percentChange24h ?? 0);
      return 26 + (extra > 0 ? Math.min(28, extra * 1.2) : 0);
    },
    answer: (ctx) => handlers.relativeStrength(ctx.asset, ctx.context)
  },

  // ---------------- E. DISCOVERY (see file header — excluded from the main selector) ----------------
  {
    id: 'DISCOVER_ANOTHER',
    category: 'DISCOVERY',
    label: 'Show me another moving coin',
    requires: ['movers'],
    isEligible: (ctx) => moversReady(ctx),
    priority: () => 18,
    answer: (ctx) => handlers.discoverAnother(ctx.asset, ctx.context)
  },
  {
    id: 'MARKET_MOVERS',
    category: 'DISCOVERY',
    label: "Show me what's moving right now",
    requires: ['movers'],
    isEligible: (ctx) => moversReady(ctx),
    priority: () => 20,
    answer: (ctx) => handlers.marketMovers(ctx.asset, ctx.context)
  }
];

function btcReady(ctx: QuestionEngineContext): boolean {
  const btc = ctx.context.btc;
  if (!btc || btc.percentChange24h === null || ctx.asset.percentChange24h === null) return false;
  // Comparing BTC to itself is a trivial, uninteresting question — searching
  // BTC itself simply doesn't offer the CONTEXT category.
  return btc.id !== ctx.asset.id;
}

function moversReady(ctx: QuestionEngineContext): boolean {
  const movers = ctx.context.movers;
  return movers !== null && movers.some((m) => m.id !== ctx.asset.id);
}
