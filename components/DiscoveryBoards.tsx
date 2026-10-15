'use client';

import { formatPercent } from '@/lib/format';
import { changeColor } from '@/components/ui';
import type { DiscoveryBoard } from '@/types';

/**
 * Four transparent screens over the top-100 pool. Each states its rule up
 * front, and each row says, with a number, why it qualified. An empty screen
 * stays visible with an honest message rather than being padded.
 */
export function DiscoveryBoards({
  boards,
  status,
  onPick
}: {
  boards: DiscoveryBoard[] | null;
  status: 'loading' | 'ready' | 'error';
  onPick: (symbol: string) => void;
}) {
  if (status === 'error' || (status === 'ready' && !boards)) {
    return (
      <p className="surface px-5 py-6 text-[14px] text-muted">
        Market screens are unavailable right now. Search for any coin above — the investigation does not depend on them.
      </p>
    );
  }

  return (
    <div className="grid gap-px overflow-hidden rounded-[6px] border border-edge bg-edge md:grid-cols-2">
      {(boards ?? PLACEHOLDER).map((board) => (
        <section key={board.key} className="flex flex-col bg-panel px-5 py-5 sm:px-6" aria-labelledby={`board-${board.key}`}>
          <h3 id={`board-${board.key}`} className="text-[17px] font-semibold tracking-tight text-ink">
            {board.title}
          </h3>
          <p className="mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-faint">{board.criterion}</p>

          {status === 'loading' ? (
            <div className="mt-4 space-y-2" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-9" />
              ))}
            </div>
          ) : board.entries.length === 0 ? (
            <p className="mt-4 rounded-[4px] border border-dashed border-edge px-4 py-4 text-[13px] text-muted">
              Nothing in the top 100 meets this rule right now.
            </p>
          ) : (
            <ol className="mt-3 divide-y divide-edge-soft">
              {board.entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onPick(entry.symbol)}
                    className="group grid w-full grid-cols-[64px_1fr_auto] items-center gap-3 py-2.5 text-left"
                  >
                    <span className="ident truncate text-[13px] text-ink group-hover:text-teal">{entry.symbol}</span>
                    <span className="min-w-0 truncate text-[13px] text-muted">{entry.reason}</span>
                    <span className={`tnum text-[13px] ${changeColor(entry.priceChange24h)}`}>{formatPercent(entry.priceChange24h)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}

const PLACEHOLDER: DiscoveryBoard[] = [
  { key: 'biggest-moves', title: 'Largest moves', criterion: 'Loading the screening rule…', entries: [] },
  { key: 'volume-surge', title: 'Volume surging', criterion: 'Loading the screening rule…', entries: [] },
  { key: 'unconfirmed-moves', title: 'Moving without volume', criterion: 'Loading the screening rule…', entries: [] },
  { key: 'heavy-turnover', title: 'Heavy turnover', criterion: 'Loading the screening rule…', entries: [] }
];
