'use client';

/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from 'react';

import { buildEvidence } from '@/analysis/evidence';
import { APP } from '@/lib/config';
import { classifyFreshness, FRESHNESS_COPY, type Freshness } from '@/lib/freshness';
import {
  formatCompactNumber,
  formatCompactUsd,
  formatPercent,
  formatPrice,
  formatRatio,
  impliedPriceDelta,
  relativeTime,
  signedPrice,
  truncateMiddle
} from '@/lib/format';
import { LinkIcon } from '@/components/icons';
import { PriceChart } from '@/components/PriceChart';
import { MoveProfile, SignalGauges } from '@/components/Signals';
import { changeColor, Metric, TONE_RULE, TONE_TEXT } from '@/components/ui';
import { useMarketContext } from '@/components/useMarketFeeds';
import type { AnalyzeResponse, Driver, DriverTone, EvidenceReport } from '@/types';

/**
 * The investigation dossier. Reading order: who → what the market says right
 * now → the diagnosis (the answer) → the evidence behind it → what it cannot
 * know. Every number is a reported or explicitly derived value; anything the
 * provider did not report says so instead of showing a zero.
 */
export function AnalysisReport({ data }: { data: AnalyzeResponse }) {
  const { asset, analysis } = data;
  const evidence = useMemo(() => buildEvidence(asset, analysis), [asset, analysis]);

  return (
    <article className="animate-fade-up" aria-labelledby="dossier-title">
      <DossierHeader data={data} />
      <SnapshotStrip data={data} />

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <Diagnosis data={data} />
          <PriceChart source={data.history ?? null} refPrice={asset.price} symbol={asset.symbol} />
          <EvidenceLedger evidence={evidence} />
        </div>

        <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start" aria-label="Supporting readings">
          <MoveProfile asset={asset} />
          <MarketContextPanel data={data} />
          <SignalGauges signals={analysis.signals} />
          <DataUsed data={data} />
        </aside>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */

function DossierHeader({ data }: { data: AnalyzeResponse }) {
  const { asset } = data;
  const [logoFailed, setLogoFailed] = useState(false);
  const contract = asset.primaryContract;
  const freshness = classifyFreshness(asset.lastUpdated);
  const source = asset.dataSource ?? 'CoinMarketCap';

  return (
    <header className="flex flex-col gap-4 border-b border-edge pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-edge bg-raised">
          {asset.logoUrl && !logoFailed ? (
            <img src={asset.logoUrl} alt="" width={48} height={48} className="h-12 w-12 object-cover" onError={() => setLogoFailed(true)} />
          ) : (
            <span className="ident text-[12px] text-muted">{asset.symbol.slice(0, 3)}</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="dossier-title" className="wide truncate text-[26px] font-semibold leading-tight tracking-display text-ink sm:text-[32px]">
              {asset.name}
            </h2>
            <span className="ident text-[14px] text-muted">{asset.symbol}</span>
            {asset.rank ? <span className="tnum text-[13px] text-faint">Rank {asset.rank}</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
            {asset.chain ? <span className="text-muted">{asset.chain}</span> : null}
            {contract ? (
              contract.explorerUrl ? (
                <a
                  href={contract.explorerUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ident inline-flex items-center gap-1.5 text-[12.5px] text-faint transition-colors hover:text-teal"
                  title={contract.address}
                >
                  {truncateMiddle(contract.address, 6, 4)}
                  <LinkIcon className="h-3 w-3" />
                </a>
              ) : (
                <span className="ident text-[12.5px] text-faint" title={contract.address}>
                  {truncateMiddle(contract.address, 6, 4)}
                </span>
              )
            ) : null}
            {asset.websiteUrl ? (
              <a href={asset.websiteUrl} target="_blank" rel="noreferrer noopener" className="text-faint transition-colors hover:text-teal">
                Website
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
        <FreshnessBadge freshness={freshness} />
        <span className="text-[12.5px] text-faint">
          {source}
          {asset.lastUpdated ? `, quoted ${relativeTime(asset.lastUpdated)}` : ''}
        </span>
      </div>
    </header>
  );
}

const FRESHNESS_DOT: Record<Freshness, string> = {
  fresh: 'bg-lime',
  delayed: 'bg-amber',
  stale: 'bg-rose',
  unknown: 'bg-faint'
};

function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-edge px-3 py-1 text-[12.5px] text-muted">
      <span aria-hidden="true" className={`h-[7px] w-[7px] rounded-full ${FRESHNESS_DOT[freshness]} ${freshness === 'fresh' ? 'animate-breathe' : ''}`} />
      {FRESHNESS_COPY[freshness]}
    </span>
  );
}

function SnapshotStrip({ data }: { data: AnalyzeResponse }) {
  const { asset } = data;
  const delta = impliedPriceDelta(asset.price, asset.percentChange24h);
  const turnover = data.analysis.signals.turnoverLevel;
  const dex = asset.dex;

  return (
    <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-edge bg-edge sm:grid-cols-3 lg:grid-cols-5">
      <Metric
        className="bg-panel"
        label="Price"
        value={formatPrice(asset.price)}
        sub={delta !== null ? `${signedPrice(delta)} 24h` : null}
        subClass={changeColor(asset.percentChange24h)}
      />
      <Metric
        className="bg-panel"
        label="24h change"
        value={formatPercent(asset.percentChange24h)}
        sub={asset.percentChange1h !== null ? `${formatPercent(asset.percentChange1h)} in 1h` : null}
        subClass={changeColor(asset.percentChange1h)}
      />
      <Metric
        className="bg-panel"
        label="Market cap"
        value={formatCompactUsd(asset.marketCap)}
        sub={asset.fullyDilutedMarketCap !== null ? `${formatCompactUsd(asset.fullyDilutedMarketCap)} fully diluted` : null}
      />
      <Metric
        className="bg-panel"
        label="24h volume"
        value={formatCompactUsd(asset.volume24h)}
        sub={asset.volumeChange24h !== null ? `${formatPercent(asset.volumeChange24h)} vs prior 24h` : null}
        subClass={changeColor(asset.volumeChange24h)}
      />
      {dex ? (
        <Metric
          className="col-span-2 bg-panel sm:col-span-2 lg:col-span-1"
          label="Pool liquidity"
          value={formatCompactUsd(dex.liquidityUsd)}
          sub={dex.quoteSymbol ? `${asset.symbol}/${dex.quoteSymbol} pool` : null}
        />
      ) : (
        <Metric
          className="col-span-2 bg-panel sm:col-span-2 lg:col-span-1"
          label="Volume / market cap"
          value={formatRatio(asset.volumeToMarketCap)}
          sub={turnover === 'unknown' ? null : `${turnover} turnover`}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

const CONFIDENCE_COPY = {
  high: { text: 'All core metrics reported', className: 'text-muted' },
  moderate: { text: 'Some metrics missing', className: 'text-amber' },
  limited: { text: 'Limited data — read with care', className: 'text-amber' }
} as const;

function Diagnosis({ data }: { data: AnalyzeResponse }) {
  const { analysis } = data;
  const confidence = CONFIDENCE_COPY[analysis.confidence];

  return (
    <section className="surface overflow-hidden" aria-labelledby="why-moving">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-5 py-3 sm:px-7">
        <h2 id="why-moving" className="text-[15px] font-semibold text-ink">
          Why is it moving?
        </h2>
        <span className={`text-[12.5px] ${confidence.className}`}>{confidence.text}</span>
      </header>

      <div className="relative px-5 py-7 sm:px-7 sm:py-8">
        <span className={`absolute left-0 top-0 h-full w-[3px] ${TONE_RULE[analysis.primary.tone]}`} aria-hidden="true" />
        <p className="text-[12.5px] text-faint">Primary reading from the data</p>
        <h3 className={`wide mt-2 text-[28px] font-semibold leading-[1.05] tracking-display sm:text-[40px] ${TONE_TEXT[analysis.primary.tone]}`}>
          {analysis.primary.title}
        </h3>
        <p className="mt-5 max-w-[62ch] text-[17px] leading-[1.6] text-ink sm:text-[18px]">{analysis.verdict}</p>
        <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-muted">{analysis.primary.explanation}</p>
      </div>

      <div className={`grid gap-px border-t border-edge bg-edge ${analysis.secondary ? 'sm:grid-cols-2' : ''}`}>
        {analysis.secondary ? <SupportingRead role="Also in the data" driver={analysis.secondary} /> : null}
        <SupportingRead
          role="Market structure"
          driver={{
            key: 'structure',
            group: 'structure',
            score: 0,
            title: analysis.structure.title,
            explanation: analysis.structure.explanation,
            tone: analysis.structure.tone
          }}
        />
      </div>
    </section>
  );
}

function SupportingRead({ role, driver }: { role: string; driver: Driver }) {
  return (
    <div className="bg-panel px-5 py-5 sm:px-7">
      <div className="flex items-center gap-2">
        <Dot tone={driver.tone} />
        <span className="text-[12.5px] text-faint">{role}</span>
      </div>
      <h4 className={`mt-2 text-[16.5px] font-semibold tracking-tight ${TONE_TEXT[driver.tone]}`}>{driver.title}</h4>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{driver.explanation}</p>
    </div>
  );
}

function Dot({ tone }: { tone: DriverTone }) {
  return <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${TONE_RULE[tone]}`} />;
}

/* ------------------------------------------------------------------ */

function EvidenceLedger({ evidence }: { evidence: EvidenceReport }) {
  return (
    <section className="surface overflow-hidden" aria-labelledby="evidence">
      <header className="border-b border-edge px-5 py-3 sm:px-7">
        <h2 id="evidence" className="text-[15px] font-semibold text-ink">
          Evidence
        </h2>
      </header>

      <div className="px-5 py-5 sm:px-7">
        <h3 className="text-[13.5px] font-medium text-ink">Observed</h3>
        <p className="mt-0.5 text-[12.5px] text-faint">Reported by the data provider. No interpretation.</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {evidence.observed.map((fact) => (
            <div key={fact.label} className="min-w-0">
              <dt className="truncate text-[12px] text-faint">{fact.label}</dt>
              <dd className={`tnum mt-0.5 text-[15px] ${fact.tone === 'neutral' ? 'text-ink' : TONE_TEXT[fact.tone]}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="grid gap-px border-t border-edge bg-edge md:grid-cols-2">
        <ReasonList title="Consistent with the reading" items={evidence.supporting} empty="No observation strongly backs the reading." tone="positive" />
        <ReasonList title="Cuts against it" items={evidence.opposing} empty="Nothing in the data contradicts the reading." tone="negative" />
      </div>

      <div className="grid gap-px border-t border-edge bg-edge md:grid-cols-2">
        <div className="bg-panel px-5 py-5 sm:px-7">
          <h3 className="text-[13.5px] font-medium text-ink">What would change this reading</h3>
          <p className="mt-0.5 text-[12.5px] text-faint">Interpretation, not a forecast.</p>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-muted">{evidence.invalidation}</p>
          <h3 className="mt-5 text-[13.5px] font-medium text-ink">Worth re-checking</h3>
          <ul className="mt-2 space-y-1.5">
            {evidence.watchNext.map((item) => (
              <li key={item} className="text-[13.5px] leading-relaxed text-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-sunken px-5 py-5 sm:px-7">
          <h3 className="text-[13.5px] font-medium text-ink">Outside the data</h3>
          <p className="mt-0.5 text-[12.5px] text-faint">
            Market data cannot show these. If one of them is the real cause, this analysis will not see it.
          </p>
          <ul className="mt-2.5 space-y-1.5">
            {evidence.outsideData.map((item) => (
              <li key={item} className="flex gap-2.5 text-[13.5px] leading-relaxed text-muted">
                <span aria-hidden="true" className="mt-[9px] h-px w-3 shrink-0 bg-faint" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ReasonList({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone: DriverTone }) {
  return (
    <div className="bg-panel px-5 py-5 sm:px-7">
      <div className="flex items-center gap-2">
        <Dot tone={tone} />
        <h3 className="text-[13.5px] font-medium text-ink">{title}</h3>
      </div>
      {items.length === 0 ? (
        <p className="mt-2.5 text-[13.5px] text-faint">{empty}</p>
      ) : (
        <ul className="mt-2.5 space-y-2.5">
          {items.map((item) => (
            <li key={item} className="text-[13.5px] leading-relaxed text-muted">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function MarketContextPanel({ data }: { data: AnalyzeResponse }) {
  const context = useMarketContext();
  const { asset } = data;
  const btc = context?.btc ?? null;
  const global = context?.global ?? null;
  const isBtc = btc !== null && btc.id === asset.id;
  const relative =
    !isBtc && btc?.percentChange24h != null && asset.percentChange24h !== null ? asset.percentChange24h - btc.percentChange24h : null;

  return (
    <section className="surface px-5 py-5 sm:px-6" aria-labelledby="market-context">
      <h2 id="market-context" className="text-[15px] font-semibold text-ink">
        Market context
      </h2>
      {context === null ? (
        <div className="mt-4 space-y-2" aria-label="Loading market context">
          <div className="skeleton h-5" />
          <div className="skeleton h-5" />
        </div>
      ) : !btc && !global ? (
        <p className="mt-3 text-[13px] text-muted">Market-wide data is unavailable right now.</p>
      ) : (
        <dl className="mt-3 space-y-2.5">
          {btc && !isBtc ? <Row label="Bitcoin, 24h" value={formatPercent(btc.percentChange24h)} className={changeColor(btc.percentChange24h)} /> : null}
          {global?.marketCapChange24h != null ? (
            <Row label="Total crypto market cap, 24h" value={formatPercent(global.marketCapChange24h)} className={changeColor(global.marketCapChange24h)} />
          ) : null}
          {relative !== null ? (
            <Row
              label={`${asset.symbol} relative to BTC`}
              value={`${relative > 0 ? '+' : ''}${relative.toFixed(Math.abs(relative) >= 10 ? 1 : 2)} pts`}
              className={changeColor(relative)}
            />
          ) : null}
          {global?.btcDominance != null ? <Row label="BTC dominance" value={`${global.btcDominance.toFixed(1)}%`} /> : null}
        </dl>
      )}
    </section>
  );
}

function DataUsed({ data }: { data: AnalyzeResponse }) {
  const { analysis, asset } = data;
  const sourceLink =
    asset.dataSourceUrl ??
    (asset.dataSource !== 'DexScreener' && /^[a-z0-9-]+$/.test(asset.slug) ? `https://coinmarketcap.com/currencies/${asset.slug}/` : null);

  return (
    <section className="surface px-5 py-5 sm:px-6" aria-labelledby="data-used">
      <h2 id="data-used" className="text-[15px] font-semibold text-ink">
        Data used
      </h2>
      <dl className="mt-3">
        {analysis.dataUsed.map((point) => (
          <Row key={point.label} label={point.label} value={point.value} note={point.note} />
        ))}
        {asset.circulatingSupply !== null ? (
          <Row label="Circulating supply" value={`${formatCompactNumber(asset.circulatingSupply)} ${asset.symbol}`} />
        ) : null}
      </dl>
      {analysis.missing.length > 0 ? (
        <p className="mt-4 border-t border-edge-soft pt-3 text-[12.5px] leading-relaxed text-amber/90">
          Not reported for this asset: {analysis.missing.join(', ')}. The reading uses what remains.
        </p>
      ) : null}
      <div className="mt-4 space-y-1.5 border-t border-edge-soft pt-3 text-[12px] leading-relaxed text-faint">
        <p>
          Source: {asset.dataSource ?? 'CoinMarketCap'}
          {asset.lastUpdated ? `, quote time ${new Date(asset.lastUpdated).toLocaleString()}` : ', quote time not reported'}.
          {asset.dataSource === 'DexScreener' ? ' Figures describe the single most liquid matching pool.' : ''}
        </p>
        {sourceLink ? (
          <a href={sourceLink} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-muted hover:text-teal">
            View on {asset.dataSource === 'DexScreener' ? 'DexScreener' : 'CoinMarketCap'}
            <LinkIcon className="h-3 w-3" />
          </a>
        ) : null}
        <p>{APP.disclaimer}</p>
      </div>
    </section>
  );
}

function Row({ label, value, note, className = 'text-ink' }: { label: string; value: string; note?: string; className?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-edge-soft py-2 last:border-b-0">
      <dt className="text-[13px] text-muted">
        {label}
        {note ? <span className="block text-[11.5px] text-faint">{note}</span> : null}
      </dt>
      <dd className={`tnum shrink-0 text-[13px] ${className}`}>{value}</dd>
    </div>
  );
}
