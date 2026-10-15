'use client';

import { forwardRef, useEffect, useId, useRef, useState } from 'react';

import { CloseIcon, ReturnIcon, SearchIcon, SpinnerIcon } from '@/components/icons';
import type { AssetSuggestion } from '@/types';

const EXAMPLES = ['BTC', 'SOL', 'PEPE', 'BONK'];
const SUGGEST_DEBOUNCE_MS = 160;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (query: string) => void;
  loading: boolean;
  recent: string[];
  onClearRecent: () => void;
}

/**
 * The research command bar: free text, tickers and contract addresses, with
 * autocomplete from the cached asset directory. It is a WAI-ARIA combobox —
 * ↑/↓ move through suggestions, Enter investigates, Esc closes the list.
 * Picking a suggestion submits that suggestion's resolver-safe query, so the
 * same asset that was shown is the one that gets analysed.
 */
export const CommandSearch = forwardRef<HTMLInputElement, Props>(function CommandSearch(
  { value, onChange, onSubmit, loading, recent, onClearRecent },
  inputRef
) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<AssetSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const skipNextFetch = useRef(false);

  useEffect(() => {
    const q = value.trim();
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    // Addresses and very long input go straight to the resolver.
    if (q.length === 0 || q.length >= 30) {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((r) => r.json() as Promise<{ suggestions?: AssetSuggestion[] }>)
        .then((body) => {
          setSuggestions(Array.isArray(body.suggestions) ? body.suggestions : []);
          setActive(-1);
        })
        .catch(() => {
          /* Autocomplete is optional — search still works without it. */
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  function submit(query: string) {
    const q = query.trim();
    if (!q || loading) return;
    skipNextFetch.current = true;
    onChange(q);
    setOpen(false);
    setSuggestions([]);
    onSubmit(q);
  }

  const showList = open && suggestions.length > 0 && value.trim().length > 0;
  const showRecent = open && value.trim().length === 0 && recent.length > 0;

  return (
    <div className="relative">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (showList && active >= 0) submit(suggestions[active].query);
          else submit(value);
        }}
      >
        <div className="command flex items-center gap-2 p-1.5 pl-4">
          <SearchIcon className="h-[18px] w-[18px] shrink-0 text-faint" />
          <label htmlFor="coin-search" className="sr-only">
            Ticker, coin name or contract address
          </label>
          <input
            ref={inputRef}
            id="coin-search"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
                return;
              }
              if (!showList) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((i) => (i + 1) % suggestions.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
              }
            }}
            placeholder="Ticker, name or contract address"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={64}
            className="h-12 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-faint sm:h-14 sm:text-[17px]"
          />
          {value ? (
            <button
              type="button"
              onClick={() => {
                onChange('');
                (inputRef as React.RefObject<HTMLInputElement>)?.current?.focus();
              }}
              className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-[6px] text-faint transition-colors hover:text-ink sm:inline-flex"
              aria-label="Clear search"
            >
              <CloseIcon />
            </button>
          ) : null}
          <button
            type="submit"
            disabled={loading || value.trim().length === 0}
            className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-[7px] bg-teal px-4 text-[14px] font-semibold text-void transition-[filter,background-color] duration-150 hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint sm:h-14 sm:px-6"
          >
            {loading ? <SpinnerIcon className="h-4 w-4" /> : <ReturnIcon className="hidden h-4 w-4 sm:block" />}
            {loading ? 'Investigating' : 'Investigate'}
          </button>
        </div>
      </form>

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching assets"
          className="absolute inset-x-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-[8px] border border-edge-strong bg-raised py-1 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]"
        >
          {suggestions.map((s, index) => (
            <li
              key={s.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                submit(s.query);
              }}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 ${index === active ? 'bg-teal/10' : ''}`}
            >
              <span className="ident w-16 shrink-0 truncate text-[13px] text-ink">{s.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-[14px] text-muted">{s.name}</span>
              <span className="tnum shrink-0 text-[12px] text-faint">{s.rank ? `Rank ${s.rank}` : 'Unranked'}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {showRecent || (recent.length > 0 && !value) ? (
          <>
            <span className="mr-1 text-[12.5px] text-faint">Recent</span>
            {recent.map((q) => (
              <button key={q} type="button" className="chip ident" onClick={() => submit(q)}>
                {q}
              </button>
            ))}
            <button type="button" onClick={onClearRecent} className="ml-1 text-[12px] text-faint underline-offset-4 hover:text-ink hover:underline">
              Clear
            </button>
          </>
        ) : (
          <>
            <span className="mr-1 text-[12.5px] text-faint">Try</span>
            {EXAMPLES.map((q) => (
              <button key={q} type="button" className="chip ident" onClick={() => submit(q)}>
                {q}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
});
