'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AnalysisReport } from '@/components/AnalysisReport';
import { Investigation } from '@/components/Investigation';
import { AnalyzingState, ErrorNotice } from '@/components/States';
import { SearchIcon, SpinnerIcon } from '@/components/icons';
import type { AnalyzeResponse, ApiErrorBody } from '@/types';

type Status = 'idle' | 'loading' | 'done' | 'error';

const SUGGESTIONS = ['BTC', 'SOL', 'PEPE', 'BONK'];

/**
 * Owns the entire search → analyze → result flow.
 * No analysis is shown until the user requests a specific coin.
 */
export function AnalyzePanel() {
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<ApiErrorBody['error'] | null>(null);
  const [pendingQuery, setPendingQuery] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('q', query);
      window.history.replaceState(null, '', url);
    }

    try {
      const response = await fetch(`/api/analyze?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      const body = (await response.json()) as AnalyzeResponse | ApiErrorBody;

      if (!response.ok || 'error' in body) {
        setError(
          'error' in body
            ? body.error
            : { code: 'UPSTREAM_ERROR', message: 'Market data is temporarily unavailable. Please try again.' }
        );
        setStatus('error');
        return;
      }

      setResult(body);
      setStatus('done');
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
    if (status === 'done' || status === 'error') {
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [status]);

  useEffect(() => {
    const onJump = () => inputRef.current?.focus();
    window.addEventListener('moving:focus-search', onJump);
    return () => window.removeEventListener('moving:focus-search', onJump);
  }, []);

  const loading = status === 'loading';
  const empty = input.trim().length === 0;

  return (
    <div className="w-full">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(input);
        }}
      >
        <div className="field group flex flex-col gap-1.5 p-1.5 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-3 pl-3 sm:pl-4">
            <span className="shrink-0 text-faint transition-colors duration-200 group-focus-within:text-mint">
              <SearchIcon className="h-[18px] w-[18px]" />
            </span>
            <input
              ref={inputRef}
              id="coin-search"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search coin or paste contract address..."
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
              aria-label="Coin ticker, name or contract address"
              className="h-[50px] w-full bg-transparent text-[16px] text-ink outline-none placeholder:text-faint sm:h-[58px] sm:text-[17px]"
            />
          </div>

          <button
            type="submit"
            disabled={loading || empty}
            className="inline-flex h-[50px] shrink-0 items-center justify-center gap-2 rounded-[2px] bg-mint px-7 text-[13px] font-semibold uppercase tracking-[0.12em] text-void transition-all duration-150 hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:bg-edge-strong disabled:text-faint sm:h-[58px]"
          >
            {loading ? <SpinnerIcon className="h-4 w-4" /> : null}
            {loading ? 'Analyzing' : 'Analyze'}
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        <span className="text-[12px] text-faint">Try</span>
        {SUGGESTIONS.map((symbol) => (
          <button
            key={symbol}
            type="button"
            onClick={() => {
              setInput(symbol);
              void run(symbol);
            }}
            className="tnum rounded-[2px] border border-edge px-2.5 py-1 text-[12px] text-muted transition-colors duration-150 hover:border-mint/50 hover:text-mint"
          >
            {symbol}
          </button>
        ))}
      </div>

      <div ref={resultRef} className="mt-12 scroll-mt-20 sm:mt-14">
        {status === 'loading' ? <AnalyzingState query={pendingQuery} /> : null}
        {status === 'error' && error ? <ErrorNotice error={error} onRetry={() => void run(pendingQuery)} /> : null}
        {status === 'done' && result ? (
          <>
            <AnalysisReport data={result} />
            {/* key={result.asset.id} forces a full remount on every new coin, so
                investigation state (answered questions, expanded trail) never
                bleeds from one search into the next. */}
            <Investigation key={result.asset.id} asset={result.asset} analysis={result.analysis} />
          </>
        ) : null}
        {status === 'idle' ? (
          <p className="max-w-readable text-[12.5px] leading-relaxed text-faint">
            Your analysis will appear here after you search for a coin.
          </p>
        ) : null}
      </div>
    </div>
  );
}
