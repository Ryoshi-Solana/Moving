'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { selectQuestions } from '@/analysis/questions/selector';
import { pickDiscoveryCards } from '@/lib/discovery-pick';
import { formatPercent } from '@/lib/format';
import { AlertIcon, ArrowUpIcon, ChevronIcon, SpinnerIcon } from '@/components/icons';
import { FieldLabel, TONE_RULE, TONE_TEXT, changeColor } from '@/components/ui';
import type {
  Analysis,
  AssetSnapshot,
  MarketContext,
  QuestionAnswer,
  QuestionEngineContext
} from '@/types';

interface ContextPayload {
  btc: AssetSnapshot | null;
  global: MarketContext['global'];
}

interface DiscoverPayload {
  movers: AssetSnapshot[] | null;
}

interface AnsweredEntry {
  id: string;
  answer: QuestionAnswer;
}

const ANSWER_DELAY_MS = 550;

/**
 * The guided investigation loop that follows the main diagnosis: contextual
 * follow-up cards, inline answers, and an optional "explore another coin"
 * footer. Fully client-side and ephemeral — nothing here is persisted, and a
 * fresh `key={asset.id}` remount (see AnalyzePanel) resets it on every new
 * search.
 *
 * Tier-1 questions (WHY/STRENGTH/CHANGE) answer instantly from props alone —
 * no network call. CONTEXT questions need BTC + global data, and the
 * "Done exploring?" footer needs the top-100-by-market-cap discovery pool;
 * both are fetched once on mount and reused for every question that needs
 * them, never re-fetched per click.
 */
export function Investigation({ asset, analysis }: { asset: AssetSnapshot; analysis: Analysis }) {
  const [context, setContext] = useState<ContextPayload>({ btc: null, global: null });
  const [movers, setMovers] = useState<AssetSnapshot[] | null>(null);
  const [answered, setAnswered] = useState<AnsweredEntry[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [trailExpanded, setTrailExpanded] = useState(true);

  const topRef = useRef<HTMLDivElement>(null);

  // Fetched once per search, reused by every CONTEXT/DISCOVERY question the
  // user clicks afterward — never refetched per click.
  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/context', { signal: controller.signal })
      .then((r) => r.json())
      .then((body: ContextPayload) => setContext(body))
      .catch(() => {
        /* CONTEXT questions simply stay unavailable — the core page is unaffected. */
      });

    fetch('/api/discover', { signal: controller.signal })
      .then((r) => r.json())
      .then((body: DiscoverPayload) => setMovers(body.movers))
      .catch(() => {
        /* The footer stays hidden — see the render guard below. */
      });

    return () => controller.abort();
  }, [asset.id]);

  const engineContext: QuestionEngineContext = useMemo(
    () => ({
      asset,
      analysis,
      context: { btc: context.btc, global: context.global, movers },
      answeredIds: answered.map((entry) => entry.id)
    }),
    [asset, analysis, context, movers, answered]
  );

  const nextQuestions = useMemo(() => selectQuestions(engineContext, 3), [engineContext]);

  function handleAsk(id: string) {
    setErrorId(null);
    setPendingId(id);
    // A short, deliberate pause — consistent with the main search's staged
    // loading state — rather than an instant swap, even though answering
    // itself needs no network round-trip.
    window.setTimeout(() => {
      try {
        const definition = nextQuestions.find((q) => q.id === id);
        const result = definition?.answer(engineContext) ?? null;
        if (!result) {
          setErrorId(id);
        } else {
          setAnswered((prev) => [...prev, { id, answer: result }]);
        }
      } catch {
        setErrorId(id);
      } finally {
        setPendingId(null);
      }
    }, ANSWER_DELAY_MS);
  }

  const hasHistory = answered.length > 0;

  return (
    <div ref={topRef} className="mt-8 space-y-5 scroll-mt-20 sm:mt-10">
      {hasHistory ? (
        <div className="flex items-center justify-between">
          <FieldLabel>Investigation</FieldLabel>
          {trailExpanded ? (
            <button
              type="button"
              onClick={() => {
                setTrailExpanded(false);
                topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className="inline-flex items-center gap-1.5 text-[11.5px] text-muted transition-colors duration-150 hover:text-mint"
            >
              <ArrowUpIcon className="h-3 w-3" />
              Back to overview
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setTrailExpanded(true)}
              className="text-[11.5px] text-mint transition-colors duration-150 hover:brightness-110"
            >
              {answered.length} question{answered.length === 1 ? '' : 's'} explored — Resume
            </button>
          )}
        </div>
      ) : null}

      {trailExpanded && hasHistory ? (
        <div className="space-y-3">
          {answered.map((entry) => (
            <AnsweredCard key={entry.id} answer={entry.answer} />
          ))}
        </div>
      ) : null}

      {errorId ? (
        <div className="rounded-[3px] border border-amber/25 bg-amber/[0.03] px-5 py-4" role="alert">
          <div className="flex items-start gap-3">
            <span className="mt-[2px] shrink-0 text-amber">
              <AlertIcon className="h-[14px] w-[14px]" />
            </span>
            <div className="min-w-0">
              <p className="text-[13.5px] text-ink">We couldn&apos;t complete that analysis right now.</p>
              <button
                type="button"
                onClick={() => handleAsk(errorId)}
                className="mt-2.5 rounded-[2px] border border-edge px-2.5 py-1 text-[12px] text-muted transition-colors duration-150 hover:border-mint/50 hover:text-mint"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {(trailExpanded || !hasHistory) && (nextQuestions.length > 0 || pendingId) ? (
        <div className="space-y-3">
          <FieldLabel>What do you want to know next?</FieldLabel>
          <div className="grid gap-2.5 sm:grid-cols-3">
            {nextQuestions.map((q) => (
              <button
                key={q.id}
                type="button"
                disabled={pendingId !== null}
                onClick={() => handleAsk(q.id)}
                className="group flex min-h-[64px] items-center justify-between gap-2 rounded-[3px] border border-edge bg-panel px-4 py-3.5 text-left text-[13px] text-ink transition-colors duration-150 hover:border-mint/40 hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{q.label}</span>
                {pendingId === q.id ? (
                  <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-mint" />
                ) : (
                  <ChevronIcon className="h-3.5 w-3.5 shrink-0 -rotate-90 text-faint transition-colors duration-150 group-hover:text-mint" />
                )}
              </button>
            ))}
          </div>
          {pendingId ? (
            <p className="tnum text-[11.5px] uppercase tracking-[0.12em] text-faint">Analyzing…</p>
          ) : null}
        </div>
      ) : null}

      <DiscoveryFooter pool={movers} currentAssetId={asset.id} />
    </div>
  );
}

function AnsweredCard({ answer }: { answer: QuestionAnswer }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="panel animate-fade-in overflow-hidden">
      <div className="relative px-5 py-4 sm:px-6">
        <span className={`absolute left-0 top-0 h-full w-[2px] ${TONE_RULE[answer.tone]}`} />
        <h4 className={`text-[15px] font-medium tracking-tight ${TONE_TEXT[answer.tone]}`}>{answer.title}</h4>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{answer.summary}</p>

        {answer.dataUsed.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-faint transition-colors duration-150 hover:text-mint"
          >
            <ChevronIcon className={`h-3 w-3 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
            {expanded ? 'Hide the numbers' : 'Go deeper'}
          </button>
        ) : null}

        {expanded ? (
          <dl className="mt-3 space-y-1.5 border-t border-edge-soft pt-3">
            {answer.dataUsed.map((point) => (
              <div key={point.label} className="flex items-baseline justify-between gap-4">
                <dt className="text-[12px] text-muted">{point.label}</dt>
                <dd className="tnum text-[12px] text-ink">{point.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

const DISCOVERY_COUNT = 3;
const RECENT_CLICKS_KEY = 'moving:recent-discovery';
const RECENT_CLICKS_MAX = 8;

/** sessionStorage-backed, so "recently clicked" survives the full-page
 * navigation a discovery click causes, but naturally clears when the tab
 * closes — exactly the "current session" scope the spec asks for. Every
 * access is try/caught: private-browsing or storage-disabled contexts simply
 * fall back to no repeat-avoidance rather than breaking the footer. */
function readRecentDiscoveryClicks(): string[] {
  try {
    const raw = window.sessionStorage.getItem(RECENT_CLICKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function recordDiscoveryClick(symbol: string): void {
  try {
    const next = [symbol, ...readRecentDiscoveryClicks().filter((s) => s !== symbol)].slice(0, RECENT_CLICKS_MAX);
    window.sessionStorage.setItem(RECENT_CLICKS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the click still navigates normally either way. */
  }
}

function DiscoveryFooter({ pool, currentAssetId }: { pool: AssetSnapshot[] | null; currentAssetId: number }) {
  // Randomized once per mount (i.e. once per search — Investigation remounts
  // via key={asset.id}) rather than on every re-render, so the three cards
  // stay stable while the user answers other questions on the same page.
  const candidates = useMemo(() => {
    if (!pool || pool.length === 0) return [];
    return pickDiscoveryCards(pool, currentAssetId, DISCOVERY_COUNT, readRecentDiscoveryClicks());
  }, [pool, currentAssetId]);

  // No dead button: the whole footer is omitted when discovery data never
  // loaded or has nothing usable.
  if (candidates.length === 0) return null;

  return (
    <section className="border-t border-edge-soft pt-6">
      <FieldLabel>Done exploring?</FieldLabel>
      <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
        {candidates.map((coin) => (
          <a
            key={coin.id}
            href={`/?q=${encodeURIComponent(coin.symbol)}`}
            onClick={() => recordDiscoveryClick(coin.symbol)}
            className="flex flex-col gap-1 rounded-[3px] border border-edge bg-panel px-4 py-3.5 transition-colors duration-150 hover:border-mint/40"
          >
            <span className="tnum text-[13px] font-medium text-ink">{coin.symbol}</span>
            <span className={`tnum text-[12px] ${changeColor(coin.percentChange24h)}`}>
              {formatPercent(coin.percentChange24h)}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
