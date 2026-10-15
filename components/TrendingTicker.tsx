'use client';

import { formatPercent, formatPrice } from '@/lib/format';
import { changeColor } from '@/components/ui';
import { useMarketFeeds } from '@/components/useMarketFeeds';
import type { AssetSnapshot } from '@/types';

/**
 * Slim market tape under the navbar: MOVING's "most active" ranking (24h move
 * plus turnover, see lib/market-feeds.ts) followed by the top 24h gainers.
 * Shares the page's single /api/trending request. Renders nothing when the
 * feed is unavailable, so it can never push the page around.
 */
export function TrendingTicker() {
  const { data } = useMarketFeeds();
  const trending = data?.trending ?? [];
  const gainers = data?.gainers ?? [];
  if (trending.length === 0 && gainers.length === 0) return null;

  const segments: Array<{ label: string; coins: AssetSnapshot[] }> = [];
  if (trending.length > 0) segments.push({ label: 'Most active', coins: trending });
  if (gainers.length > 0) segments.push({ label: 'Top gainers 24h', coins: gainers });

  const track = (
    <>
      {segments.map((segment) => (
        <span key={segment.label} className="flex shrink-0 items-center gap-6 pr-6">
          <span className="text-[12px] text-faint">{segment.label}</span>
          {segment.coins.map((coin) => (
            <span key={coin.id} className="tnum flex shrink-0 items-baseline gap-2 whitespace-nowrap text-[12.5px]">
              <a href={`/?q=${encodeURIComponent(coin.symbol)}`} className="ident text-ink hover:text-teal" tabIndex={-1}>
                {coin.symbol}
              </a>
              <span className="text-muted">{formatPrice(coin.price)}</span>
              <span className={changeColor(coin.percentChange24h)}>{formatPercent(coin.percentChange24h)}</span>
            </span>
          ))}
        </span>
      ))}
    </>
  );

  return (
    <div className="border-b border-edge bg-sunken/70" aria-label="Market tape" role="region">
      <div className="ticker-viewport overflow-hidden py-2">
        {/* Two identical copies scroll by exactly one copy-width for a seamless loop. */}
        <div className="ticker-track flex w-max items-center" aria-hidden="true">
          <div className="flex items-center pl-6">{track}</div>
          <div className="flex items-center pl-6">{track}</div>
        </div>
        <p className="sr-only">
          Most active: {trending.map((c) => `${c.symbol} ${formatPercent(c.percentChange24h)}`).join(', ')}.
        </p>
      </div>
    </div>
  );
}
