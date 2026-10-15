'use client';

import { useEffect, useState } from 'react';

import { AlertIcon } from '@/components/icons';
import type { ApiErrorBody } from '@/types';

const STEPS = ['Resolving the asset', 'Reading price and volume', 'Comparing the signals', 'Writing the diagnosis'];

/**
 * Loading state for an investigation. The steps describe what the server is
 * actually doing; the trace line is the only animation and stops under
 * reduced motion.
 */
export function AnalyzingState({ query }: { query: string }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s < STEPS.length - 1 ? s + 1 : s)), 650);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="surface animate-fade-in overflow-hidden" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-4 border-b border-edge px-5 py-3 sm:px-7">
        <span className="text-[14px] text-muted">
          Investigating <span className="ident text-ink">{query}</span>
        </span>
        <span aria-hidden="true" className="h-[7px] w-[7px] shrink-0 animate-breathe rounded-full bg-lime" />
      </div>
      <div className="grid gap-6 px-5 py-6 sm:grid-cols-[1fr_260px] sm:px-7">
        <ol className="space-y-3">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={`flex items-center gap-3 text-[14px] transition-colors duration-300 ${
                index < step ? 'text-muted' : index === step ? 'text-ink' : 'text-faint/60'
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-[6px] w-[6px] shrink-0 rounded-full transition-colors duration-300 ${
                  index < step ? 'bg-teal/50' : index === step ? 'bg-teal' : 'bg-faint/30'
                }`}
              />
              {label}
              {index === step ? <span className="sr-only">(in progress)</span> : null}
            </li>
          ))}
        </ol>
        <svg viewBox="0 0 260 90" className="hidden h-[90px] w-full sm:block" aria-hidden="true">
          <path d="M0 45 H260" stroke="rgba(158,204,196,0.14)" />
          <path
            d="M0 60 L30 58 L52 64 L78 48 L96 52 L120 30 L140 38 L164 22 L186 34 L206 18 L232 26 L260 12"
            fill="none"
            stroke="#2EE6D6"
            strokeWidth="1.6"
            strokeLinejoin="round"
            pathLength={1}
            className="trace-path"
          />
        </svg>
      </div>
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: ApiErrorBody['error']; onRetry?: () => void }) {
  const retryable = error.code === 'UPSTREAM_ERROR' || error.code === 'RATE_LIMITED';

  return (
    <div className="animate-fade-in rounded-[6px] border border-amber/30 bg-amber/[0.04] px-5 py-5 sm:px-7" role="alert">
      <div className="flex items-start gap-3">
        <AlertIcon className="mt-[3px] h-[16px] w-[16px] shrink-0 text-amber" />
        <div className="min-w-0">
          <p className="text-[16px] font-medium leading-snug text-ink">{error.message}</p>
          {error.hint ? <p className="mt-2 max-w-readable text-[14px] leading-relaxed text-muted">{error.hint}</p> : null}
          {onRetry && retryable ? (
            <button type="button" onClick={onRetry} className="chip mt-4">
              Try again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
