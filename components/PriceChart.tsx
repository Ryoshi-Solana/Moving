'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { HISTORY_RANGES, historyQuery, summarizeCandles } from '@/lib/history';
import { formatCompactUsd, formatPercent, formatPrice } from '@/lib/format';
import { changeColor } from '@/components/ui';
import type { HistoryRange, HistoryResponse, HistorySource } from '@/types';

const W = 760;
const H = 300;
const PRICE_H = 214;
const PAD = { top: 12, right: 96, bottom: 24, left: 8 };

type State = { status: 'loading' } | { status: 'done'; data: HistoryResponse } | { status: 'error' };

/**
 * Verified price history. Candles are only drawn when the server confirmed
 * the venue's latest close agrees with MOVING's quote; every other outcome
 * gets an explicit, specific empty state instead of a chart.
 */
export function PriceChart({ source, refPrice, symbol }: { source: HistorySource | null; refPrice: number | null; symbol: string }) {
  const [range, setRange] = useState<HistoryRange>('7D');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [cursor, setCursor] = useState<number | null>(null);
  const [k, setK] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);
  const hasChart = state.status === 'done' && state.data.status === 'verified';

  // Axis text is in viewBox units; keep it legible when the chart is narrow.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0) setK(Math.min(2, Math.max(1, W / width)));
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [hasChart]);

  useEffect(() => {
    if (!source || refPrice === null) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    setCursor(null);
    fetch(`/api/history?${historyQuery(source, range, refPrice)}`, { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<HistoryResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => setState({ status: 'done', data }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [source, refPrice, range]);

  const data = state.status === 'done' ? state.data : null;
  const candles = useMemo(() => data?.candles ?? [], [data]);
  const summary = useMemo(() => summarizeCandles(candles), [candles]);

  const geometry = useMemo(() => {
    if (candles.length < 2 || !summary) return null;
    const priceSpan = summary.high - summary.low || summary.high * 0.01 || 1;
    const lo = summary.low - priceSpan * 0.06;
    const hi = summary.high + priceSpan * 0.06;
    const innerW = W - PAD.left - PAD.right;
    // Position by time, not by index: young DEX pools only report intervals
    // that had trades, and gaps must stay visible as gaps.
    const t0 = candles[0].t;
    const span = Math.max(1, candles[candles.length - 1].t - t0);
    const x = (i: number) => PAD.left + ((candles[i].t - t0) / span) * innerW;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (PRICE_H - PAD.top);
    const maxVol = Math.max(0, ...candles.map((c) => c.v ?? 0));
    const volTop = PRICE_H + 14;
    const volH = H - PAD.bottom - volTop;
    const line = candles.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(c.c).toFixed(1)}`).join('');
    const area = `${line}L${x(candles.length - 1).toFixed(1)},${PRICE_H}L${x(0).toFixed(1)},${PRICE_H}Z`;
    const ticks = [hi - (hi - lo) * 0.1, (hi + lo) / 2, lo + (hi - lo) * 0.1];
    const barW = Math.min(14, Math.max(1, (innerW * (candles.length > 1 ? Math.min(...candles.slice(1).map((c, i) => c.t - candles[i].t)) : span)) / span - 1));
    return { x, y, line, area, maxVol, volTop, volH, ticks, barW, t0, span, innerW };
  }, [candles, summary]);

  const up = summary ? summary.last >= summary.first : true;
  const stroke = up ? '#22F0A0' : '#FF6B7D';
  const active = cursor !== null ? candles[cursor] : null;

  function moveTo(clientX: number) {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !geometry) return;
    const sx = ((clientX - box.left) / box.width) * W;
    const t = geometry.t0 + ((sx - PAD.left) / geometry.innerW) * geometry.span;
    let best = 0;
    for (let i = 1; i < candles.length; i++) if (Math.abs(candles[i].t - t) < Math.abs(candles[best].t - t)) best = i;
    setCursor(best);
  }

  return (
    <section className="surface overflow-hidden" aria-labelledby="price-history">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-5 py-3 sm:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 id="price-history" className="text-[15px] font-semibold text-ink">
            Price history
          </h2>
          {summary && data?.status === 'verified' ? (
            <span className={`tnum text-[13px] ${changeColor(summary.changePct)}`}>
              {formatPercent(summary.changePct)} {coverageLabel(candles, data.interval, range)}
            </span>
          ) : null}
        </div>
        <div role="tablist" aria-label="Chart range" className="flex rounded-[6px] border border-edge p-0.5">
          {HISTORY_RANGES.map((r) => (
            <button
              key={r}
              role="tab"
              type="button"
              aria-selected={r === range}
              disabled={!source}
              onClick={() => setRange(r)}
              className={`tnum min-h-[30px] rounded-[4px] px-3 text-[12px] transition-colors ${
                r === range ? 'bg-raised text-ink' : 'text-faint hover:text-ink'
              } disabled:cursor-not-allowed`}
            >
              {r}
            </button>
          ))}
        </div>
      </header>

      <div className="px-2 pb-3 pt-2 sm:px-3">
        {!source || refPrice === null ? (
          <Empty title="No verified history source for this asset">
            MOVING&apos;s current data plan has no historical candles, and no free venue could be matched to this asset. The
            analysis below uses the reported interval changes instead.
          </Empty>
        ) : state.status === 'loading' ? (
          <div className="skeleton m-3 h-[240px]" aria-label="Loading price history" />
        ) : state.status === 'error' || !data ? (
          <Empty title="Price history is unavailable right now">The analysis below does not depend on it.</Empty>
        ) : data.status === 'mismatch' ? (
          <Empty title="History withheld — the venue may list a different asset">
            {data.venue}&apos;s latest price differs from the {symbol} quote MOVING analysed by{' '}
            {data.priceGap !== null ? `${(data.priceGap * 100).toFixed(1)}%` : 'too much'}. Rather than risk drawing another
            asset&apos;s chart, none is shown.
          </Empty>
        ) : data.status === 'stale' ? (
          <Empty title="History withheld — the venue's data is out of date">
            The newest candle from {data.venue} is too old to describe the current move.
          </Empty>
        ) : data.status !== 'verified' || !geometry ? (
          <Empty title="No verified price history for this asset">
            {data.venue} has no usable candles for {symbol} in this range.
          </Empty>
        ) : (
          <>
            <div className="relative">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${W} ${H}`}
                className="h-auto w-full touch-pan-y outline-none"
                role="img"
                aria-label={`${symbol} price over ${range}: from ${formatPrice(summary!.first)} to ${formatPrice(summary!.last)}, high ${formatPrice(summary!.high)}, low ${formatPrice(summary!.low)}.`}
                tabIndex={0}
                onPointerMove={(e) => moveTo(e.clientX)}
                onPointerLeave={() => setCursor(null)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, (c ?? candles.length) - 1));
                  if (e.key === 'ArrowRight') setCursor((c) => Math.min(candles.length - 1, (c ?? -1) + 1));
                  if (e.key === 'Escape') setCursor(null);
                }}
              >
                <defs>
                  <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={stroke} stopOpacity="0.18" />
                    <stop offset="1" stopColor={stroke} stopOpacity="0" />
                  </linearGradient>
                </defs>
                {geometry.ticks.map((t) => (
                  <g key={t}>
                    <line x1={PAD.left} x2={W - PAD.right} y1={geometry.y(t)} y2={geometry.y(t)} stroke="rgba(158,204,196,0.07)" />
                    <text x={W - PAD.right + 8} y={geometry.y(t) + 4} className="fill-faint tnum" style={{ fontSize: 11 * k }}>
                      {formatPrice(t)}
                    </text>
                  </g>
                ))}
                <path d={geometry.area} fill="url(#price-fill)" />
                <path d={geometry.line} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" pathLength={1} className="animate-draw" style={{ strokeDasharray: 1 }} />
                {geometry.maxVol > 0
                  ? candles.map((c, i) =>
                      c.v ? (
                        <rect
                          key={c.t}
                          x={geometry.x(i) - geometry.barW / 2}
                          y={geometry.volTop + geometry.volH * (1 - c.v / geometry.maxVol)}
                          width={geometry.barW}
                          height={(geometry.volH * c.v) / geometry.maxVol}
                          fill={i === cursor ? '#2EE6D6' : 'rgba(158,204,196,0.22)'}
                        />
                      ) : null
                    )
                  : null}
                {cursor !== null && active ? (
                  <g>
                    <line x1={geometry.x(cursor)} x2={geometry.x(cursor)} y1={PAD.top} y2={H - PAD.bottom} stroke="rgba(232,240,238,0.35)" strokeDasharray="3 3" />
                    <circle cx={geometry.x(cursor)} cy={geometry.y(active.c)} r={4} fill="#080C0D" stroke={stroke} strokeWidth={2} />
                  </g>
                ) : null}
                <text x={PAD.left} y={H - 4} className="fill-faint tnum" style={{ fontSize: 11 * k }}>
                  {formatTime(candles[0].t, range)}
                </text>
                <text x={W - PAD.right} y={H - 4} textAnchor="end" className="fill-faint tnum" style={{ fontSize: 11 * k }}>
                  {formatTime(candles[candles.length - 1].t, range)}
                </text>
              </svg>

              {active && cursor !== null ? (
                <div
                  className="pointer-events-none absolute top-2 z-10 rounded-[6px] border border-edge-strong bg-raised/95 px-3 py-2 text-[12px] shadow-lg backdrop-blur"
                  style={geometry.x(cursor) / W > 0.6 ? { left: '1rem' } : { right: '5rem' }}
                  aria-live="polite"
                >
                  <div className="tnum text-faint">{formatTime(active.t, range, true)}</div>
                  <div className="tnum mt-1 text-[14px] text-ink">{formatPrice(active.c)}</div>
                  <div className="tnum mt-1 grid grid-cols-[auto_auto] gap-x-3 text-[11.5px]">
                    <span className="text-faint">High</span>
                    <span className="text-muted">{formatPrice(active.h)}</span>
                    <span className="text-faint">Low</span>
                    <span className="text-muted">{formatPrice(active.l)}</span>
                    {active.v !== null ? (
                      <>
                        <span className="text-faint">Volume</span>
                        <span className="text-muted">{formatCompactUsd(active.v)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            <p className="px-3 pt-1 text-[12px] leading-relaxed text-faint">
              {data.venue} candles, {intervalLabel(data.interval)}. Volume bars show this venue only, not the market-wide
              figure used in the analysis. Price matches MOVING&apos;s
              quote within {data.priceGap !== null ? `${(data.priceGap * 100).toFixed(1)}%` : '6%'}.{' '}
              {data.sourceUrl ? (
                <a href={data.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-muted underline-offset-4 hover:text-teal hover:underline">
                  Open venue
                </a>
              ) : null}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="m-3 flex min-h-[180px] flex-col justify-center rounded-[4px] border border-dashed border-edge px-5 py-6">
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

const RANGE_SECONDS: Record<HistoryRange, number> = { '1D': 86_400, '7D': 604_800, '30D': 2_592_000 };

/** "over 7D", or the real span when the venue has less history than the range (new pools). */
function coverageLabel(candles: { t: number }[], interval: number, range: HistoryRange): string {
  if (candles.length === 0) return `over ${range}`;
  const covered = candles[candles.length - 1].t - candles[0].t + interval;
  if (covered >= RANGE_SECONDS[range] * 0.8) return `over ${range}`;
  const hours = covered / 3600;
  return `over the ${hours < 48 ? `${Math.max(1, Math.round(hours))}h` : `${Math.round(hours / 24)}d`} of history available`;
}

function intervalLabel(seconds: number): string {
  if (seconds < 3600) return `${seconds / 60}-minute intervals`;
  if (seconds < 86_400) return seconds === 3600 ? 'hourly' : `${seconds / 3600}-hour intervals`;
  return 'daily';
}

function formatTime(t: number, range: HistoryRange, long = false): string {
  const d = new Date(t * 1000);
  if (range === '1D' && !long) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', ...(long || range !== '30D' ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
