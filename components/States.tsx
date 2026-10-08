'use client';

import { useEffect, useState } from 'react';

import { AlertIcon } from '@/components/icons';
import type { ApiErrorBody } from '@/types';

const STEPS = ['Analyzing market data', 'Looking at price action', 'Comparing volume', 'Building diagnosis'];

export function AnalyzingState({ query }: { query: string }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setStep((current) => (current < STEPS.length - 1 ? current + 1 : current));
    }, 650);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="panel animate-fade-in px-5 py-6 sm:px-6" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-4">
        <span className="tnum truncate text-[12px] uppercase tracking-[0.14em] text-muted">{query}</span>
        <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 animate-breathe bg-mint" />
      </div>

      <ol className="mt-5 space-y-3">
        {STEPS.map((label, index) => (
          <li
            key={label}
            className={`flex items-center gap-3 text-[13.5px] transition-colors duration-300 ${
              index < step ? 'text-muted' : index === step ? 'text-ink' : 'text-faint/50'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-[5px] w-[5px] shrink-0 transition-colors duration-300 ${
                index < step ? 'bg-mint/40' : index === step ? 'bg-mint' : 'bg-faint/30'
              }`}
            />
            {label}
            {index === step ? <span className="sr-only">in progress</span> : null}
          </li>
        ))}
      </ol>

      <div className="skeleton-sweep relative mt-6 h-px overflow-hidden bg-edge" />
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: ApiErrorBody['error']; onRetry?: () => void }) {
  const retryable = error.code === 'UPSTREAM_ERROR' || error.code === 'RATE_LIMITED';

  return (
    <div className="animate-fade-in rounded-[3px] border border-amber/25 bg-amber/[0.03] px-5 py-5 sm:px-6" role="alert">
      <div className="flex items-start gap-3">
        <span className="mt-[3px] shrink-0 text-amber">
          <AlertIcon className="h-[15px] w-[15px]" />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-medium leading-snug text-ink">{error.message}</p>
          {error.hint ? <p className="mt-2 max-w-readable text-[13px] leading-relaxed text-muted">{error.hint}</p> : null}
          {onRetry && retryable ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-4 rounded-[2px] border border-edge px-3 py-1.5 text-[12.5px] text-muted transition-colors duration-150 hover:border-mint/50 hover:text-mint"
            >
              Try again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
