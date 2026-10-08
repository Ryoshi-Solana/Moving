'use client';

import { useEffect, useState } from 'react';

import { formatPercent, formatPrice } from '@/lib/format';
import { changeColor } from '@/components/ui';
import type { AssetSnapshot } from '@/types';

interface TrendingResponsePayload {
  trending: AssetSnapshot[] | null;
  gainers: AssetSnapshot[] | null;
}

/**
 * Two thin, continuously-scrolling market-feed strips: "Trending Coins" (MOVING's
 * own locally-computed activity ranking — see lib/market-feeds.ts) and "Top
 * Gainers 24h". Purely additive context — if /api/trending has nothing for
 * either feed, that row (or the whole component) renders nothing, so it can
 * never push the page around or show a broken/empty section.
 */
export function TrendingTicker() {
  const [feeds, setFeeds] = useState<TrendingResponsePayload | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/trending', { signal: controller.signal })
      .then((r) => r.json())
      .then((body: TrendingResponsePayload) => setFeeds(body))
      .catch(() => {
        /* Stay hidden — see the render guard below. */
      });
    return () => controller.abort();
  }, []);

  const trending = feeds?.trending ?? null;
  const gainers = feeds?.gainers ?? null;
  const hasTrending = trending !== null && trending.length > 0;
  const hasGainers = gainers !== null && gainers.length > 0;

  if (!hasTrending && !hasGainers) return null;

  return (
    <div className="border-b border-edge bg-void/60">
      <div className="mx-auto max-w-5xl px-5 py-2 sm:px-6 sm:py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          {/* A static dot, not a pulsing "live" indicator — this is cached,
              periodically-refreshed data, not a real-time feed. */}
          <span aria-hidden="true" className="h-[5px] w-[5px] rounded-full bg-mint/40" />
          <span className="text-[9.5px] font-medium uppercase tracking-[0.16em] text-faint">Market data</span>
        </div>

        <div className="space-y-1.5">
          {hasTrending ? <TickerRow label="Trending coins" coins={trending} direction="forward" showPrice /> : null}
          {hasGainers ? <TickerRow label="Top gainers 24h" coins={gainers} direction="reverse" /> : null}
        </div>
      </div>
    </div>
  );
}

function TickerRow({
  label,
  coins,
  direction,
  showPrice = false
}: {
  label: string;
  coins: AssetSnapshot[];
  direction: 'forward' | 'reverse';
  showPrice?: boolean;
}) {
  // Two identical copies placed side by side let the CSS animation translate
  // by exactly -50% (or 0 → -50% in reverse) for a seamless loop, with no
  // need to measure pixel widths.
  const items = [...coins, ...coins];
  const trackClass = direction === 'reverse' ? 'ticker-track-reverse' : 'ticker-track';

  return (
    <div className="flex items-center gap-3">
      <span className="w-[86px] shrink-0 text-[9.5px] font-medium uppercase tracking-[0.14em] text-faint sm:w-[100px]">
        {label}
      </span>
      <div className="ticker-viewport min-w-0 flex-1 overflow-hidden">
        <div className={`${trackClass} flex w-max items-center gap-7`} aria-hidden="true">
          {items.map((coin, index) => (
            <TickerItem key={`${coin.id}-${index}`} coin={coin} showPrice={showPrice} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TickerItem({ coin, showPrice }: { coin: AssetSnapshot; showPrice: boolean }) {
  return (
    <span className="tnum flex shrink-0 items-baseline gap-2 text-[12px] whitespace-nowrap">
      <span className="font-medium text-ink">{coin.symbol}</span>
      {showPrice ? <span className="text-muted">{formatPrice(coin.price)}</span> : null}
      <span className={changeColor(coin.percentChange24h)}>{formatPercent(coin.percentChange24h)}</span>
      {showPrice && coin.rank !== null ? <span className="text-faint">#{coin.rank}</span> : null}
    </span>
  );
}
