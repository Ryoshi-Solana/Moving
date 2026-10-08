import { formatCompactUsd, formatPercent, formatPrice, formatRatio } from '@/lib/format';
import { sampleAnalysis } from '@/lib/sample';
import { changeColor, FieldLabel, TONE_RULE, TONE_TEXT } from '@/components/ui';

/** Static preview shown before the user searches. Sample numbers, real engine. */
export function ExampleAnalysis() {
  const { asset, analysis } = sampleAnalysis();

  const supporting = [
    ...(analysis.secondary ? [{ role: 'Secondary driver', ...analysis.secondary }] : []),
    { role: 'Market structure', ...analysis.structure }
  ];

  return (
    <section className="panel overflow-hidden" aria-label="Example analysis">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-5 py-3.5">
        <div className="flex items-baseline gap-3">
          <span className="tnum text-[13.5px] font-semibold tracking-wide text-ink">{asset.symbol}</span>
          <span className="tnum text-[13px] text-muted">{formatPrice(asset.price)}</span>
          <span className={`tnum text-[13px] ${changeColor(asset.percentChange24h)}`}>
            {formatPercent(asset.percentChange24h)}
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.16em] text-faint">Example · sample data</span>
      </header>

      <dl className="grid grid-cols-3 gap-px border-b border-edge bg-edge">
        <Cell label="Volume 24h" value={formatPercent(asset.volumeChange24h)} valueClass="text-mint" />
        <Cell label="Market cap" value={formatCompactUsd(asset.marketCap)} />
        <Cell label="Vol / cap" value={formatRatio(asset.volumeToMarketCap)} />
      </dl>

      <div className="relative px-5 py-6">
        <span className={`absolute left-0 top-0 h-full w-[2px] ${TONE_RULE[analysis.primary.tone]}`} />
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className={`h-[6px] w-[6px] shrink-0 ${TONE_RULE[analysis.primary.tone]}`} />
          <FieldLabel>Primary driver</FieldLabel>
        </div>
        <p className={`mt-3 text-[23px] font-medium leading-tight tracking-display ${TONE_TEXT[analysis.primary.tone]}`}>
          {analysis.primary.title}
        </p>
        <p className="mt-2.5 max-w-readable text-[13.5px] leading-relaxed text-muted">{analysis.primary.explanation}</p>
      </div>

      <div className="grid gap-px border-t border-edge bg-edge sm:grid-cols-2">
        {supporting.map((item) => (
          <div key={item.role} className="bg-panel px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span aria-hidden="true" className={`h-[6px] w-[6px] shrink-0 ${TONE_RULE[item.tone]}`} />
              <FieldLabel>{item.role}</FieldLabel>
            </div>
            <p className={`mt-2.5 text-[15px] font-medium tracking-tight ${TONE_TEXT[item.tone]}`}>{item.title}</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{item.explanation}</p>
          </div>
        ))}
      </div>

      <div className="relative border-t border-edge bg-mint/[0.04] px-5 py-5">
        <span className="absolute left-0 top-0 h-full w-[2px] bg-mint" />
        <FieldLabel>Verdict</FieldLabel>
        <p className="mt-3 max-w-readable text-[14.5px] leading-[1.6] text-ink">{analysis.verdict}</p>
      </div>
    </section>
  );
}

function Cell({ label, value, valueClass = 'text-ink' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <FieldLabel>{label}</FieldLabel>
      <dd className={`tnum mt-2 text-[14px] leading-none ${valueClass}`}>{value}</dd>
    </div>
  );
}
