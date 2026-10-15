import { THRESHOLDS } from '@/analysis/signals';
import { formatPercent, formatRatio } from '@/lib/format';
import { changeColor } from '@/components/ui';
import type { AssetSnapshot, Signals } from '@/types';

/**
 * Move profile: the reported change over each look-back window. These are
 * independent "change since N ago" figures from the provider, drawn as bars —
 * deliberately not joined into a line, because they are not a price path.
 */
export function MoveProfile({ asset }: { asset: AssetSnapshot }) {
  const windows =
    asset.dataSource === 'DexScreener' && asset.dex
      ? [
          { label: '5m', value: asset.dex.priceChange.m5 },
          { label: '1h', value: asset.dex.priceChange.h1 },
          { label: '6h', value: asset.dex.priceChange.h6 },
          { label: '24h', value: asset.dex.priceChange.h24 }
        ]
      : [
          { label: '1h', value: asset.percentChange1h },
          { label: '24h', value: asset.percentChange24h },
          { label: '7d', value: asset.percentChange7d },
          { label: '30d', value: asset.percentChange30d }
        ];
  const max = Math.max(1, ...windows.map((w) => Math.abs(w.value ?? 0)));

  return (
    <section className="surface px-5 py-5 sm:px-6" aria-labelledby="move-profile">
      <h2 id="move-profile" className="text-[15px] font-semibold text-ink">
        Move profile
      </h2>
      <p className="mt-1 text-[12.5px] text-faint">Price change over each window, measured back from the latest quote.</p>
      <dl className="mt-5 space-y-3">
        {windows.map((w) => {
          const pct = w.value === null ? 0 : (Math.abs(w.value) / max) * 50;
          return (
            <div key={w.label} className="grid grid-cols-[40px_1fr_72px] items-center gap-3">
              <dt className="tnum text-[12.5px] text-muted">{w.label}</dt>
              <dd className="relative h-[14px]" aria-hidden="true">
                <span className="absolute inset-y-0 left-1/2 w-px bg-edge-strong" />
                {w.value !== null ? (
                  <span
                    className={`absolute inset-y-[2px] rounded-[2px] ${w.value >= 0 ? 'bg-mint/70' : 'bg-rose/70'}`}
                    style={w.value >= 0 ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
                  />
                ) : (
                  <span className="absolute inset-y-[6px] left-[20%] right-[20%] border-t border-dashed border-edge-strong" />
                )}
              </dd>
              <dd className={`tnum text-right text-[13px] ${w.value === null ? 'text-faint' : changeColor(w.value)}`}>
                {w.value === null ? 'n/a' : formatPercent(w.value)}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * The three readings the engine leans on most, each on a scale marked with
 * the engine's own thresholds, so the user can see how close a call was.
 */
export function SignalGauges({ signals }: { signals: Signals }) {
  const turnoverMax = THRESHOLDS.turnover.elevated * 2;
  return (
    <section className="surface px-5 py-5 sm:px-6" aria-labelledby="signal-gauges">
      <h2 id="signal-gauges" className="text-[15px] font-semibold text-ink">
        Signal readings
      </h2>
      <div className="mt-5 space-y-6">
        <Gauge
          label="Volume confirmation"
          note="How strongly the 24h volume change backs the price move (0 to 1)."
          value={signals.volumeConfirmation}
          min={0}
          max={1}
          display={signals.volumeConfirmation === null ? 'n/a' : signals.volumeConfirmation.toFixed(2)}
          marks={[{ at: 0.15, label: 'confirms' }]}
        />
        <Gauge
          label="Turnover"
          note="24h volume as a share of market cap."
          value={signals.turnover === null ? null : Math.min(signals.turnover, turnoverMax)}
          min={0}
          max={turnoverMax}
          display={signals.turnover === null ? 'n/a' : `${formatRatio(signals.turnover)} · ${signals.turnoverLevel}`}
          marks={[
            { at: THRESHOLDS.turnover.normal, label: 'normal' },
            { at: THRESHOLDS.turnover.elevated, label: 'elevated' }
          ]}
        />
        <Gauge
          label="Trend alignment"
          note="Agreement between the 1h, 24h and 7d directions (−1 to +1)."
          value={signals.trendAlignment}
          min={-1}
          max={1}
          display={signals.trendAlignment.toFixed(2)}
          marks={[{ at: 0, label: '' }]}
        />
      </div>
    </section>
  );
}

function Gauge({
  label,
  note,
  value,
  min,
  max,
  display,
  marks
}: {
  label: string;
  note: string;
  value: number | null;
  min: number;
  max: number;
  display: string;
  marks: Array<{ at: number; label: string }>;
}) {
  const pos = (v: number) => ((v - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13.5px] text-ink">{label}</span>
        <span className={`tnum text-[13px] ${value === null ? 'text-faint' : 'text-ink'}`}>{display}</span>
      </div>
      <div className="relative mt-2.5 h-[6px] rounded-full bg-raised" role="presentation">
        {value !== null ? (
          <span className="absolute inset-y-0 left-0 rounded-full bg-teal/70" style={{ width: `${Math.max(1.5, pos(value))}%` }} />
        ) : null}
        {marks.map((m) => (
          <span key={m.at} className="absolute -top-[3px] h-[12px] w-px bg-muted/70" style={{ left: `${pos(m.at)}%` }} />
        ))}
      </div>
      <div className="relative mt-1 h-4">
        {marks
          .filter((m) => m.label)
          .map((m) => (
            <span key={m.at} className="absolute -translate-x-1/2 text-[10.5px] text-faint" style={{ left: `${pos(m.at)}%` }}>
              {m.label}
            </span>
          ))}
      </div>
      <p className="text-[12px] leading-relaxed text-faint">{note}</p>
    </div>
  );
}
