'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AnalysisReport } from '@/components/AnalysisReport';
import { CommandSearch } from '@/components/CommandSearch';
import { DiscoveryBoards } from '@/components/DiscoveryBoards';
import { Investigation } from '@/components/Investigation';
import { MoveField } from '@/components/MoveField';
import { AnalyzingState, ErrorNotice } from '@/components/States';
import { useMarketFeeds } from '@/components/useMarketFeeds';
import type { AnalyzeResponse, ApiErrorBody } from '@/types';

type Status = 'idle' | 'loading' | 'done' | 'error';

const RECENT_KEY = 'moving:recent-investigations';
const RECENT_MAX = 6;

/** Recent investigations live only in this browser (localStorage) — nothing is sent anywhere. */
function readRecent(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v.length <= 64).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: recents are a convenience only */
  }
}

/**
 * The whole interactive surface: hero search, move field, investigation
 * dossier and discovery screens. Owns the search → analyze → result flow; the
 * analysis request and response contract are unchanged from the original
 * AnalyzePanel.
 */
export function Workspace() {
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<ApiErrorBody['error'] | null>(null);
  const [pendingQuery, setPendingQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const feeds = useMarketFeeds();

  useEffect(() => {
    setRecent(readRecent());
  }, []);

  const run = useCallback(async (rawQuery: string) => {
    const query = rawQuery.trim();
    if (query.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('loading');
    setPendingQuery(query);
    setError(null);
    setResult(null);

    const url = new URL(window.location.href);
    url.searchParams.set('q', query);
    window.history.replaceState(null, '', url);

    try {
      const response = await fetch(`/api/analyze?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      const body = (await response.json()) as AnalyzeResponse | ApiErrorBody;

      if (!response.ok || 'error' in body) {
        setError('error' in body ? body.error : { code: 'UPSTREAM_ERROR', message: 'Market data is temporarily unavailable. Please try again.' });
        setStatus('error');
        return;
      }

      setResult(body);
      setStatus('done');
      const label = body.asset.dataSource === 'DexScreener' ? query : body.asset.symbol;
      setRecent((prev) => {
        const next = [label, ...prev.filter((q) => q.toUpperCase() !== label.toUpperCase())].slice(0, RECENT_MAX);
        writeRecent(next);
        return next;
      });
    } catch {
      if (controller.signal.aborted) return;
      setError({
        code: 'UPSTREAM_ERROR',
        message: 'Market data is temporarily unavailable. Please try again.',
        hint: 'Check your connection and try once more.'
      });
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('q');
    if (initial) {
      setInput(initial);
      void run(initial);
    }
  }, [run]);

  useEffect(() => {
    if (status === 'loading') resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [status]);

  useEffect(() => {
    const onJump = () => inputRef.current?.focus();
    window.addEventListener('moving:focus-search', onJump);
    return () => window.removeEventListener('moving:focus-search', onJump);
  }, []);

  const pick = useCallback(
    (symbol: string) => {
      setInput(symbol);
      void run(symbol);
    },
    [run]
  );

  const field = feeds.data?.field ?? null;

  return (
    <>
      <section className="mx-auto grid max-w-shell gap-10 px-5 pb-14 pt-12 sm:px-8 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)] lg:items-center lg:gap-14 lg:pb-20">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-lime" />
            Market data from CoinMarketCap and DexScreener
          </p>
          <h1 className="wide mt-5 text-[44px] font-bold leading-[0.95] tracking-tightest text-ink sm:text-[64px] xl:text-[76px]">
            Why is this coin moving?
          </h1>
          <p className="mt-6 max-w-[46ch] text-[17px] leading-relaxed text-muted sm:text-[18px]">
            Search any coin. MOVING reads its price, volume and liquidity, explains what the data shows, and says plainly what
            it can&apos;t see.
          </p>
          <div className="mt-8">
            <CommandSearch
              ref={inputRef}
              value={input}
              onChange={setInput}
              onSubmit={(q) => void run(q)}
              loading={status === 'loading'}
              recent={recent}
              onClearRecent={() => {
                setRecent([]);
                writeRecent([]);
              }}
            />
          </div>
        </div>

        <div className="surface min-w-0 p-4 sm:p-5">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-ink">Today&apos;s market, by price and volume</h2>
            <span className="hidden text-[12px] text-faint sm:inline">Click any dot to investigate</span>
          </div>
          {feeds.status === 'loading' ? (
            <div className="skeleton aspect-[640/440] w-full" aria-label="Loading market field" />
          ) : field && field.length > 0 ? (
            <MoveField points={field} asOf={feeds.data?.asOf ?? null} activeId={result?.asset.id ?? null} onPick={pick} />
          ) : (
            <div className="flex aspect-[640/440] w-full items-center justify-center rounded-[4px] border border-dashed border-edge px-6 text-center text-[14px] text-muted">
              The market overview is unavailable right now. Search still works.
            </div>
          )}
        </div>
      </section>

      <div id="investigation" ref={resultRef} className="mx-auto max-w-shell scroll-mt-20 px-5 sm:px-8">
        {status === 'loading' ? <AnalyzingState query={pendingQuery} /> : null}
        {status === 'error' && error ? <ErrorNotice error={error} onRetry={() => void run(pendingQuery)} /> : null}
        {status === 'done' && result ? (
          <div className="pb-6">
            <AnalysisReport data={result} />
            {/* key={result.asset.id} remounts on every new coin so follow-up state never leaks between searches. */}
            <Investigation key={result.asset.id} asset={result.asset} analysis={result.analysis} />
          </div>
        ) : null}
      </div>

      <section className="mx-auto max-w-shell px-5 py-16 sm:px-8 sm:py-20" aria-labelledby="screens">
        <div className="max-w-[60ch]">
          <h2 id="screens" className="wide text-[28px] font-semibold tracking-display text-ink sm:text-[34px]">
            Worth a closer look
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            Four screens over the top 100 assets by market cap. Each one states its rule, and each row says why it qualified.
            Nothing here is a recommendation.
          </p>
        </div>
        <div className="mt-8">
          <DiscoveryBoards boards={feeds.data?.boards ?? null} status={feeds.status} onPick={pick} />
        </div>
      </section>
    </>
  );
}
