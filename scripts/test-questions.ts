/**
 * Tests for the V1 question engine: eligibility triggers, priority ranking,
 * selector diversification/exclusion behaviour, graceful degradation when
 * optional data is missing, and the six acceptance scenarios from the V1
 * spec (strong pump, strong drop, flat asset, missing optional data,
 * repeated investigation, invalid asset).
 */

import { analyze } from '@/analysis/engine';
import { QUESTIONS } from '@/analysis/questions/definitions';
import { answerQuestion, selectDiscovery, selectQuestions } from '@/analysis/questions/selector';
import { AppError } from '@/lib/errors';
import { resolveAsset } from '@/services/resolve-asset';
import type { AssetSnapshot, MarketContext, QuestionEngineContext } from '@/types';

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function asset(overrides: Partial<AssetSnapshot>): AssetSnapshot {
  const base: AssetSnapshot = {
    id: 24478,
    name: 'Pepe',
    symbol: 'PEPE',
    slug: 'pepe',
    rank: 28,
    logoUrl: null,
    category: 'token',
    chain: 'Ethereum',
    primaryContract: null,
    contracts: [],
    websiteUrl: null,
    price: 0.0000124,
    percentChange1h: 1.2,
    percentChange24h: 27.4,
    percentChange7d: 38.1,
    percentChange30d: 52.3,
    marketCap: 5_210_000_000,
    fullyDilutedMarketCap: null,
    marketCapDominance: null,
    marketCapChange24h: 27.4,
    marketCapChangeIsDerived: true,
    volume24h: 2_180_000_000,
    volumeChange24h: 184.6,
    volumeToMarketCap: 2_180_000_000 / 5_210_000_000,
    cexVolume24h: null,
    dexVolume24h: null,
    circulatingSupply: 420_690_000_000_000,
    totalSupply: 420_690_000_000_000,
    maxSupply: null,
    numMarketPairs: 412,
    currency: 'USD',
    lastUpdated: new Date().toISOString()
  };
  return { ...base, ...overrides };
}

function btc(overrides: Partial<AssetSnapshot> = {}): AssetSnapshot {
  return asset({
    id: 1,
    name: 'Bitcoin',
    symbol: 'BTC',
    slug: 'bitcoin',
    percentChange1h: 0.3,
    percentChange24h: 2.1,
    percentChange7d: 5,
    marketCap: 1_300_000_000_000,
    volumeChange24h: 10,
    ...overrides
  });
}

function ctxFor(
  a: AssetSnapshot,
  context: Partial<MarketContext> = {},
  answeredIds: string[] = []
): QuestionEngineContext {
  return {
    asset: a,
    analysis: analyze(a),
    context: { btc: null, global: null, movers: null, ...context },
    answeredIds
  };
}

const ALL_IDS = QUESTIONS.map((q) => q.id);
const EXPECTED_IDS = [
  'WHY_VOLUME_SPIKE',
  'TOP_DRIVER',
  'WHY_DROP',
  'CEX_VS_DEX',
  'PRICE_VOLUME_IMBALANCE',
  'MOMENTUM_STRENGTH',
  'VOLUME_CONFIRMATION',
  'MOMENTUM_DIRECTION',
  'ACTIVITY_INTENSITY',
  'WHAT_CHANGED',
  'FASTEST_CHANGE',
  'SHORT_VS_LONG',
  'MARKET_CONTEXT',
  'VS_BTC',
  'ISOLATED_OR_MARKETWIDE',
  'RELATIVE_STRENGTH',
  'DISCOVER_ANOTHER',
  'MARKET_MOVERS'
];

console.log('=== Library completeness ===');
assert('exactly 18 question templates are defined', QUESTIONS.length === 18, `got ${QUESTIONS.length}`);
assert('every expected question id is present', EXPECTED_IDS.every((id) => ALL_IDS.includes(id)));
assert('every id is unique', new Set(ALL_IDS).size === ALL_IDS.length);

console.log('\n=== Per-question eligibility ===');

{
  const pump = ctxFor(asset({}));
  const flat = ctxFor(asset({ percentChange24h: 0.3, volumeChange24h: 2, percentChange1h: 0.05, percentChange7d: -0.5 }));
  assert('WHY_VOLUME_SPIKE eligible when volume is expanding', find('WHY_VOLUME_SPIKE').isEligible(pump));
  assert('WHY_VOLUME_SPIKE ineligible on flat volume', !find('WHY_VOLUME_SPIKE').isEligible(flat));
}

assert('TOP_DRIVER is always eligible', find('TOP_DRIVER').isEligible(ctxFor(asset({}))));
assert('TOP_DRIVER is eligible even with almost no data', find('TOP_DRIVER').isEligible(ctxFor(asset({ percentChange24h: null, volumeChange24h: null, marketCap: null, volumeToMarketCap: null }))));

{
  const drop = ctxFor(asset({ percentChange24h: -14, percentChange7d: -9, volumeChange24h: 40 }));
  const pump = ctxFor(asset({}));
  assert('WHY_DROP eligible on a material decline', find('WHY_DROP').isEligible(drop));
  assert('WHY_DROP ineligible when price is up', !find('WHY_DROP').isEligible(pump));
}

{
  const noSplit = ctxFor(asset({ cexVolume24h: null, dexVolume24h: null }));
  const withSplit = ctxFor(asset({ cexVolume24h: 1_000_000, dexVolume24h: 500_000 }));
  assert('CEX_VS_DEX ineligible — Basic plan never populates the split', !find('CEX_VS_DEX').isEligible(noSplit));
  assert('CEX_VS_DEX would be eligible if the fields were ever populated', find('CEX_VS_DEX').isEligible(withSplit));
}

{
  const imbalance = ctxFor(asset({ percentChange24h: 18, volumeChange24h: 1 }));
  const confirmed = ctxFor(asset({ percentChange24h: 18, volumeChange24h: 200 }));
  assert('PRICE_VOLUME_IMBALANCE eligible on strong move + weak volume', find('PRICE_VOLUME_IMBALANCE').isEligible(imbalance));
  assert('PRICE_VOLUME_IMBALANCE ineligible when volume actually confirms the move', !find('PRICE_VOLUME_IMBALANCE').isEligible(confirmed));
}

{
  const moving = ctxFor(asset({}));
  const quiet = ctxFor(asset({ percentChange24h: 0.3, percentChange1h: 0.05 }));
  assert('MOMENTUM_STRENGTH eligible when there is a meaningful move', find('MOMENTUM_STRENGTH').isEligible(moving));
  assert('MOMENTUM_STRENGTH ineligible on a quiet asset', !find('MOMENTUM_STRENGTH').isEligible(quiet));
}

assert('VOLUME_CONFIRMATION eligible whenever volume data exists', find('VOLUME_CONFIRMATION').isEligible(ctxFor(asset({}))));
assert('VOLUME_CONFIRMATION ineligible when volume change is missing', !find('VOLUME_CONFIRMATION').isEligible(ctxFor(asset({ volumeChange24h: null }))));

assert('MOMENTUM_DIRECTION eligible with 24h + 7d present', find('MOMENTUM_DIRECTION').isEligible(ctxFor(asset({}))));
assert('MOMENTUM_DIRECTION ineligible without 7d data', !find('MOMENTUM_DIRECTION').isEligible(ctxFor(asset({ percentChange7d: null }))));

assert('ACTIVITY_INTENSITY eligible when turnover is computable', find('ACTIVITY_INTENSITY').isEligible(ctxFor(asset({}))));
assert('ACTIVITY_INTENSITY ineligible without market cap', !find('ACTIVITY_INTENSITY').isEligible(ctxFor(asset({ marketCap: null, volumeToMarketCap: null }))));

assert('WHAT_CHANGED eligible whenever any change metric exists', find('WHAT_CHANGED').isEligible(ctxFor(asset({}))));
assert(
  'WHAT_CHANGED ineligible with zero usable metrics',
  !find('WHAT_CHANGED').isEligible(
    ctxFor(asset({ percentChange24h: null, percentChange1h: null, percentChange7d: null, volumeChange24h: null }))
  )
);

assert('FASTEST_CHANGE eligible with 2+ comparable metrics', find('FASTEST_CHANGE').isEligible(ctxFor(asset({}))));
assert(
  'FASTEST_CHANGE ineligible with only one metric',
  !find('FASTEST_CHANGE').isEligible(
    ctxFor(asset({ percentChange1h: null, percentChange7d: null, volumeChange24h: null }))
  )
);

assert('SHORT_VS_LONG eligible with 1h/24h/7d all present', find('SHORT_VS_LONG').isEligible(ctxFor(asset({}))));
assert('SHORT_VS_LONG ineligible missing 1h', !find('SHORT_VS_LONG').isEligible(ctxFor(asset({ percentChange1h: null }))));

for (const id of ['MARKET_CONTEXT', 'VS_BTC', 'ISOLATED_OR_MARKETWIDE', 'RELATIVE_STRENGTH']) {
  const withBtc = ctxFor(asset({}), { btc: btc() });
  const withoutBtc = ctxFor(asset({}), { btc: null });
  const btcSearchingItself = ctxFor(btc(), { btc: btc() });
  assert(`${id} eligible when BTC context is available`, find(id).isEligible(withBtc));
  assert(`${id} ineligible when BTC context failed to load`, !find(id).isEligible(withoutBtc));
  assert(`${id} ineligible when the asset being searched IS BTC`, !find(id).isEligible(btcSearchingItself));
}

for (const id of ['DISCOVER_ANOTHER', 'MARKET_MOVERS']) {
  const withMovers = ctxFor(asset({}), { movers: [btc(), asset({ id: 5994, symbol: 'SHIB' })] });
  const withoutMovers = ctxFor(asset({}), { movers: null });
  const onlySelf = ctxFor(asset({}), { movers: [asset({})] });
  assert(`${id} eligible when movers loaded and include another asset`, find(id).isEligible(withMovers));
  assert(`${id} ineligible when discovery endpoint failed (movers: null)`, !find(id).isEligible(withoutMovers));
  assert(`${id} ineligible when the only mover IS the current asset`, !find(id).isEligible(onlySelf));
}

console.log('\n=== Selector: diversification, exclusion, ranking ===');

{
  const ctx = ctxFor(asset({}), { btc: btc(), movers: [btc()] });
  const picks = selectQuestions(ctx, 3);
  assert('selector returns at most 3 questions', picks.length <= 3);
  const categories = new Set(picks.map((p) => p.category));
  assert('selector spans distinct categories when possible', categories.size === picks.length, `categories: ${[...categories]}`);
  assert('DISCOVERY is excluded from the main next-question pool by default', !picks.some((p) => p.category === 'DISCOVERY'));
}

{
  const ctx = ctxFor(asset({}));
  const first = selectQuestions(ctx, 3);
  const answeredIds = first.map((q) => q.id);
  const ctx2 = ctxFor(asset({}), {}, answeredIds);
  const second = selectQuestions(ctx2, 3);
  assert('already-answered questions are hard-excluded from the next batch', !second.some((q) => answeredIds.includes(q.id)));
}

{
  // Everything answered — selector must degrade to an empty list, never throw.
  const ctx = ctxFor(asset({}), {}, ALL_IDS);
  const picks = selectQuestions(ctx, 3);
  assert('selector returns empty (not a crash) once every question is answered', picks.length === 0);
}

{
  const strongPump = ctxFor(asset({ volumeChange24h: 400 }));
  const priorities = QUESTIONS.filter((q) => q.id === 'WHY_VOLUME_SPIKE')[0].priority(strongPump);
  const weakPump = ctxFor(asset({ volumeChange24h: 30 }));
  const weakPriority = QUESTIONS.filter((q) => q.id === 'WHY_VOLUME_SPIKE')[0].priority(weakPump);
  assert('WHY_VOLUME_SPIKE ranks higher with stronger volume confirmation', priorities > weakPriority);
}

{
  const bugged = {
    ...find('TOP_DRIVER'),
    id: 'BUGGY_TEST_ONLY',
    isEligible: () => {
      throw new Error('boom');
    }
  };
  QUESTIONS.push(bugged as (typeof QUESTIONS)[number]);
  let threw = false;
  try {
    selectQuestions(ctxFor(asset({})), 3);
  } catch {
    threw = true;
  }
  QUESTIONS.pop();
  assert('a throwing isEligible degrades that question out, does not crash the selector', !threw);
}

console.log('\n=== answerQuestion() ===');
{
  const ctx = ctxFor(asset({}));
  const result = answerQuestion('WHY_VOLUME_SPIKE', ctx);
  assert('answerQuestion returns a populated answer for an eligible id', result !== null && result.summary.length > 0);
  assert('answerQuestion returns null for an unknown id', answerQuestion('NOT_A_REAL_ID', ctx) === null);
  assert('answerQuestion returns null when the question is not eligible', answerQuestion('WHY_DROP', ctx) === null);
}

console.log('\n=== selectDiscovery() ===');
{
  const ctx = ctxFor(asset({}), { movers: [btc(), asset({ id: 5994, symbol: 'SHIB' })] });
  const discovery = selectDiscovery(ctx);
  assert('selectDiscovery returns only DISCOVERY-category questions', discovery.every((q) => q.category === 'DISCOVERY'));
  assert('selectDiscovery finds both discovery questions when movers are loaded', discovery.length === 2);
}
{
  const ctx = ctxFor(asset({}), { movers: null });
  assert('selectDiscovery is empty when movers failed to load', selectDiscovery(ctx).length === 0);
}

/* ------------------------------------------------------------------ *
 * Spec acceptance scenarios (section 33)
 * ------------------------------------------------------------------ */

console.log('\n=== Acceptance Case 1 — Strong pump ===');
{
  const ctx = ctxFor(asset({}), { btc: btc(), global: { totalMarketCap: 2.5e12, totalVolume24h: 9e10, btcDominance: 54, marketCapChange24h: 1.2 } });
  const picks = selectQuestions(ctx, 3);
  const cats = picks.map((p) => p.category);
  assert('pump: at least one question relates to volume/momentum/context', cats.some((c) => c === 'WHY' || c === 'STRENGTH' || c === 'CONTEXT'));
  assert('pump: 2-3 questions are offered', picks.length >= 2 && picks.length <= 3);
}

console.log('\n=== Acceptance Case 2 — Strong drop ===');
{
  const dropping = asset({ percentChange1h: -1.8, percentChange24h: -22, percentChange7d: -15, volumeChange24h: 145 });
  const ctx = ctxFor(dropping, { btc: btc() });
  const picks = selectQuestions(ctx, 3);
  const ids = picks.map((p) => p.id);
  assert('drop: WHY_DROP is offered', ids.includes('WHY_DROP'));
  assert(
    'drop: selling-pressure/momentum/volume-confirmation/context themes are represented',
    ids.some((id) => ['WHY_DROP', 'VOLUME_CONFIRMATION', 'MOMENTUM_DIRECTION', 'MOMENTUM_STRENGTH', 'MARKET_CONTEXT'].includes(id))
  );
}

console.log('\n=== Acceptance Case 3 — Flat asset ===');
{
  const flat = asset({ percentChange1h: 0.05, percentChange24h: 0.4, percentChange7d: -0.8, volumeChange24h: 3 });
  const ctx = ctxFor(flat, { btc: btc() });
  const picks = selectQuestions(ctx, 3);
  const ids = picks.map((p) => p.id);
  assert(
    'flat: what-changed/activity/context themes are represented',
    ids.some((id) => ['WHAT_CHANGED', 'ACTIVITY_INTENSITY', 'TOP_DRIVER', 'MARKET_CONTEXT'].includes(id))
  );
  assert('flat: momentum-strength (requires real movement) is correctly excluded', !ids.includes('MOMENTUM_STRENGTH'));
}

console.log('\n=== Acceptance Case 4 — Missing optional data ===');
{
  const noBtc = ctxFor(asset({}), { btc: null, movers: null });
  const picks = selectQuestions(noBtc, 3);
  assert('missing BTC: no CONTEXT question appears', !picks.some((p) => p.category === 'CONTEXT'));
  assert('missing movers: DISCOVERY never appears (excluded from main pool anyway)', !picks.some((p) => p.category === 'DISCOVERY'));
  assert('missing CEX/DEX: CEX_VS_DEX never appears', !picks.some((p) => p.id === 'CEX_VS_DEX'));
  assert('core analysis still produced despite missing optional context', noBtc.analysis.primary.key.length > 0);
}

console.log('\n=== Acceptance Case 5 — Repeated investigation ===');
{
  const ctx = ctxFor(asset({}));
  const round1 = selectQuestions(ctx, 3);
  const askedId = round1[0].id;
  const ctx2 = ctxFor(asset({}), {}, [askedId]);
  const round2 = selectQuestions(ctx2, 3);
  const ctx3 = ctxFor(asset({}), {}, [askedId, ...round2.map((q) => q.id)]);
  const round3 = selectQuestions(ctx3, 3);
  const everAnswered = [askedId, ...round2.map((q) => q.id)];
  assert('a question already answered never reappears across multiple rounds', !round3.some((q) => everAnswered.includes(q.id)));
}

console.log('\n=== Acceptance Case 6 — Invalid asset ===');
{
  process.env.CMC_API_KEY = 'test-key';
  (globalThis as any).fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ status: { error_code: 400, error_message: 'no results' } })
  });
  try {
    await resolveAsset('zzz-definitely-not-a-coin-zzz');
    assert('invalid asset throws', false);
  } catch (err) {
    assert(
      'invalid asset still produces the existing clean error message',
      err instanceof AppError && err.message === "We couldn't find this asset." && err.hint === 'Try a ticker, coin name, or a supported contract address.'
    );
  }
}

function find(id: string) {
  const def = QUESTIONS.find((q) => q.id === id);
  if (!def) throw new Error(`Question ${id} not found in QUESTIONS`);
  return def;
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
