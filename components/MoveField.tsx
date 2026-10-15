'use client';

import { useMemo, useRef, useState } from 'react';

import { formatPercent } from '@/lib/format';
import type { FieldPoint } from '@/types';

const W = 640;
const H = 440;
const PAD = { top: 18, right: 18, bottom: 40, left: 52 };
const X_LIMIT = 40; // percent
const Y_LIMIT = 500; // percent

/** Signed square-root scale: keeps outliers on the chart without hiding small moves. */
function sroot(v: number, limit: number): number {
  const clamped = Math.max(-limit, Math.min(limit, v));
  return Math.sign(clamped) * Math.sqrt(Math.abs(clamped)) / Math.sqrt(limit);
}

function xPos(v: number): number {
  const inner = W - PAD.left - PAD.right;
  return PAD.left + ((sroot(v, X_LIMIT) + 1) / 2) * inner;
}

/** Volume axis is asymmetric (it can fall at most 100%), so scale each side on its own. */
function yPos(v: number): number {
  const inner = H - PAD.top - PAD.bottom;
  const zero = PAD.top + inner * 0.62;
  if (v >= 0) return zero - (Math.sqrt(Math.min(v, Y_LIMIT)) / Math.sqrt(Y_LIMIT)) * (zero - PAD.top);
  return zero + (Math.sqrt(Math.min(-v, 100)) / 10) * (PAD.top + inner - zero);
}

const X_TICKS = [-20, -5, 0, 5, 20];
const Y_TICKS = [-50, 0, 100, 400];

interface Props {
  points: FieldPoint[];
  asOf: string | null;
  activeId?: number | null;
  onPick: (symbol: string) => void;
}

/**
 * The move field: every eligible top-100 asset placed by what its price did
 * (x) against what its trading volume did (y) over 24 hours. The quadrants are
 * the same distinction the analysis engine draws — a move with volume behind
 * it reads differently from a move without. Clicking a dot investigates it.
 */
export function MoveField({ points, asOf, activeId, onPick }: Props) {
  const [hover, setHover] = useState<FieldPoint | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const placed = useMemo(() => {
    const caps = points.map((p) => p.marketCap ?? 0).filter((c) => c > 0);
    const maxCap = Math.max(1, ...caps);
    return points.map((p) => ({
      p,
      x: xPos(p.priceChange24h),
      y: yPos(p.volumeChange24h),
      r: 2.6 + 7 * Math.sqrt((p.marketCap ?? 0) / maxCap)
    }));
  }, [points]);

  const labelled = useMemo(
    () =>
      new Set(
        [...points]
          .sort((a, b) => Math.abs(b.priceChange24h) + Math.abs(b.volumeChange24h) / 10 - (Math.abs(a.priceChange24h) + Math.abs(a.volumeChange24h) / 10))
          .slice(0, 6)
          .map((p) => p.id)
      ),
    [points]
  );

  function nearest(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const sx = ((clientX - box.left) / box.width) * W;
    const sy = ((clientY - box.top) / box.height) * H;
    let best: (typeof placed)[number] | null = null;
    let bestD = 22 * 22;
    for (const item of placed) {
      const d = (item.x - sx) ** 2 + (item.y - sy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    return best;
  }

  const zeroX = xPos(0);
  const zeroY = yPos(0);
  const hovered = hover ? placed.find((item) => item.p.id === hover.id) : null;
  const up = points.filter((p) => p.priceChange24h > 0).length;
  const time = asOf ? new Date(asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <figure className="relative">
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full cursor-crosshair touch-manipulation select-none"
          role="img"
          aria-label={`Scatter of ${points.length} large-cap assets by 24 hour price change and volume change. ${up} are up on the day.`}
          onPointerMove={(e) => setHover(nearest(e.clientX, e.clientY)?.p ?? null)}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const hit = nearest(e.clientX, e.clientY);
            if (hit) onPick(hit.p.symbol);
          }}
        >
          {/* Quadrant tint: only the "with volume" half is lit. */}
          <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={zeroY - PAD.top} fill="rgba(46,230,214,0.025)" />

          {X_TICKS.map((t) => (
            <g key={`x${t}`}>
              <line x1={xPos(t)} x2={xPos(t)} y1={PAD.top} y2={H - PAD.bottom} stroke="rgba(158,204,196,0.07)" />
              <text x={xPos(t)} y={H - PAD.bottom + 18} textAnchor="middle" className="fill-faint text-[11px] tnum">
                {t > 0 ? `+${t}%` : `${t}%`}
              </text>
            </g>
          ))}
          {Y_TICKS.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.left} x2={W - PAD.right} y1={yPos(t)} y2={yPos(t)} stroke="rgba(158,204,196,0.07)" />
              <text x={PAD.left - 8} y={yPos(t) + 4} textAnchor="end" className="fill-faint text-[11px] tnum">
                {t > 0 ? `+${t}%` : `${t}%`}
              </text>
            </g>
          ))}
          <line x1={zeroX} x2={zeroX} y1={PAD.top} y2={H - PAD.bottom} stroke="rgba(158,204,196,0.28)" />
          <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke="rgba(158,204,196,0.28)" />

          <g className="fill-muted text-[12px]">
            <text x={W - PAD.right - 8} y={PAD.top + 18} textAnchor="end">Rising with volume</text>
            <text x={PAD.left + 8} y={PAD.top + 18}>Falling with volume</text>
            <text x={W - PAD.right - 8} y={H - PAD.bottom - 10} textAnchor="end">Rising on thinner flow</text>
            <text x={PAD.left + 8} y={H - PAD.bottom - 10}>Drifting lower</text>
          </g>

          {placed.map(({ p, x, y, r }) => {
            const color = p.priceChange24h > 0 ? '#22F0A0' : p.priceChange24h < 0 ? '#FF6B7D' : '#90A29E';
            const isActive = p.id === activeId;
            return (
              <g key={p.id}>
                <circle cx={x} cy={y} r={r} fill={color} fillOpacity={hover && hover.id !== p.id ? 0.22 : 0.55} stroke={color} strokeOpacity={0.9} strokeWidth={0.8} />
                {isActive ? <circle cx={x} cy={y} r={r + 5} fill="none" stroke="#D4FF3A" strokeWidth={1.4} /> : null}
                {labelled.has(p.id) || isActive ? (
                  <text x={x + r + 4} y={y + 4} className="fill-ink text-[11px] ident">
                    {p.symbol}
                  </text>
                ) : null}
              </g>
            );
          })}

          <text x={W - PAD.right} y={H - 6} textAnchor="end" className="fill-faint text-[11px]">
            24h price change
          </text>
          <text transform={`translate(12 ${PAD.top + 4}) rotate(90)`} className="fill-faint text-[11px]">
            24h volume change
          </text>
        </svg>

        {hovered ? (
          <div
            className="pointer-events-none absolute z-10 min-w-[150px] -translate-x-1/2 rounded-[6px] border border-edge-strong bg-raised/95 px-3 py-2 text-[12.5px] shadow-lg backdrop-blur"
            style={{ left: `${(hovered.x / W) * 100}%`, top: `calc(${(hovered.y / H) * 100}% + 14px)` }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="ident text-[13px] text-ink">{hovered.p.symbol}</span>
              <span className="text-[11px] text-faint">{hovered.p.rank ? `Rank ${hovered.p.rank}` : ''}</span>
            </div>
            <div className="mt-1 grid grid-cols-[auto_auto] gap-x-3 tnum">
              <span className="text-faint">Price</span>
              <span className={hovered.p.priceChange24h >= 0 ? 'text-mint' : 'text-rose'}>{formatPercent(hovered.p.priceChange24h)}</span>
              <span className="text-faint">Volume</span>
              <span className="text-ink">{formatPercent(hovered.p.volumeChange24h)}</span>
            </div>
            <div className="mt-1.5 text-[11px] text-teal">Click to investigate</div>
          </div>
        ) : null}
      </div>
      <figcaption className="mt-3 text-[12px] leading-relaxed text-faint">
        {points.length} of the top 100 assets by market cap, stablecoins and wrapped tokens excluded. Axes are square-root
        scaled so outliers stay visible. CoinMarketCap{time ? `, quotes as of ${time}` : ''}.
      </figcaption>
    </figure>
  );
}
