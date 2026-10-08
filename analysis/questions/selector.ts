import { QUESTIONS } from '@/analysis/questions/definitions';
import type { QuestionAnswer, QuestionCategory, QuestionDefinition, QuestionEngineContext } from '@/types';

/**
 * DISCOVERY is excluded by default — see the header comment in definitions.ts
 * for why it powers a separate "Done exploring?" footer instead of competing
 * for one of the main "next question" slots.
 */
const DEFAULT_CATEGORIES: QuestionCategory[] = ['WHY', 'STRENGTH', 'CHANGE', 'CONTEXT'];

/**
 * Picks the next 2–3 questions to offer.
 *
 * Ranking, in order: (1) hard-exclude anything already answered — a question
 * is never re-offered; (2) hard-exclude anything ineligible, i.e. missing or
 * invalid required data; (3) among what remains, greedily take the
 * highest-priority question from each not-yet-used category, so the result
 * spans categories instead of piling up three WHY questions; (4) only once
 * categories run out does it fall back to pure priority with repeats allowed,
 * so `count` is still met when the data only supports one or two categories.
 */
export function selectQuestions(
  ctx: QuestionEngineContext,
  count = 3,
  categories: QuestionCategory[] = DEFAULT_CATEGORIES
): QuestionDefinition[] {
  const answered = new Set(ctx.answeredIds);

  const eligible = QUESTIONS.filter(
    (q) => categories.includes(q.category) && !answered.has(q.id) && safeEligible(q, ctx)
  );

  const scored = eligible
    .map((q) => ({ q, score: safePriority(q, ctx) }))
    .sort((a, b) => b.score - a.score);

  const selected: QuestionDefinition[] = [];
  const usedCategories = new Set<QuestionCategory>();

  for (const { q } of scored) {
    if (selected.length >= count) break;
    if (usedCategories.has(q.category)) continue;
    selected.push(q);
    usedCategories.add(q.category);
  }

  if (selected.length < count) {
    for (const { q } of scored) {
      if (selected.length >= count) break;
      if (selected.includes(q)) continue;
      selected.push(q);
    }
  }

  return selected;
}

/** Answers one question by id. Returns null if the id is unknown or the
 * question is not currently eligible (defensive — the UI should never call
 * this for a question selectQuestions did not offer). */
export function answerQuestion(id: string, ctx: QuestionEngineContext): QuestionAnswer | null {
  const definition = QUESTIONS.find((q) => q.id === id);
  if (!definition) return null;
  if (!safeEligible(definition, ctx)) return null;
  return definition.answer(ctx);
}

/** Discovery lives outside the main selector (see file header) — this is the
 * dedicated accessor the "Done exploring?" footer uses instead. */
export function selectDiscovery(ctx: QuestionEngineContext): QuestionDefinition[] {
  return QUESTIONS.filter((q) => q.category === 'DISCOVERY' && safeEligible(q, ctx)).sort(
    (a, b) => safePriority(b, ctx) - safePriority(a, ctx)
  );
}

// A misbehaving isEligible/priority (e.g. a future question with a bug) should
// degrade that one question out of the running rather than break the whole
// investigation loop.
function safeEligible(q: QuestionDefinition, ctx: QuestionEngineContext): boolean {
  try {
    return q.isEligible(ctx);
  } catch {
    return false;
  }
}

function safePriority(q: QuestionDefinition, ctx: QuestionEngineContext): number {
  try {
    return q.priority(ctx);
  } catch {
    return 0;
  }
}
