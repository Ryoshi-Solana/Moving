'use client';

/* eslint-disable @next/next/no-img-element */

import { useState } from 'react';

import { APP } from '@/lib/config';
import { biggestChange, collectChangeMetrics } from '@/analysis/questions/shared';
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
import { changeColor, FieldLabel, Metric, TONE_RULE, TONE_TEXT } from '@/components/ui';
import type { AnalyzeResponse, Driver, DriverTone } from '@/types';

/**
 * The diagnosis, ordered so it can be scanned in a few seconds:
 * identity → snapshot → primary driver (dominant) → supporting reads →
 * verdict (the conclusion) → the data behind it.
 */
export function AnalysisReport({ data }: { data: AnalyzeResponse }) {
  const { asset, analysis } = data;

  return (
    <article className="animate-fade-up space-y-5 sm:space-y-6" aria-live="polite">
      <AssetHeader data={data} />
      <MetricStrip data={data} />

      <section className="panel overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-5 py-3.5 sm:px-6">
          <h2 className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Why is it moving?</h2>
          <ConfidenceTag confidence={analysis.confidence} />
        </header>

        <div className="relative px-5 py-7 sm:px-8 sm:py-9">
          <span className={`absolute left-0 top-0 h-full w-[2px] ${TONE_RULE[analysis.primary.tone]}`} />
          <Marker tone={analysis.primary.tone} label="Primary driver" />
          <h3
            className={`mt-3.5 text-[27px] font-medium leading-[1.05] tracking-display sm:text-[38px] ${
              TONE_TEXT[analysis.primary.tone]
            }`}
          >
            {analysis.primary.title}
          </h3>
          <p className="mt-4 max-w-readable text-[14.5px] leading-relaxed text-muted sm:text-[15px]">
            {analysis.primary.explanation}
          </p>
        </div>

        <div className={`grid gap-px border-t border-edge bg-edge ${analysis.secondary ? 'sm:grid-cols-2' : ''}`}>
          {analysis.secondary ? <SupportingRead role="Secondary driver" driver={analysis.secondary} /> : null}
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

      <section className="relative overflow-hidden rounded-[3px] border border-mint/25 bg-mint/[0.04] px-5 py-6 sm:px-8 sm:py-7">
        <span className="absolute left-0 top-0 h-full w-[2px] bg-mint" />
        <FieldLabel>Verdict</FieldLabel>
        <p className="mt-3.5 max-w-readable text-[16px] leading-[1.6] text-ink sm:text-[17.5px] sm:leading-[1.62]">
          {analysis.verdict}
        </p>
      </section>

      <WhatChanged asset={asset} />

      <DataUsed data={data} />

      <div className="space-y-2 pt-1">
        <p className="max-w-readable text-[12px] leading-relaxed text-faint">{APP.disclaimer}</p>
        <p className="tnum text-[11.5px] text-faint">
          CoinMarketCap{asset.lastUpdated ? ` · updated ${relativeTime(asset.lastUpdated)}` : ''}
        </p>
      </div>
    </article>
  );
}

function Marker({ tone, label }: { tone: DriverTone; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden="true" className={`h-[6px] w-[6px] shrink-0 ${TONE_RULE[tone]}`} />
      <FieldLabel>{label}</FieldLabel>
    </div>
  );
}

function AssetHeader({ data }: { data: AnalyzeResponse }) {
  const { asset } = data;
  const [logoFailed, setLogoFailed] = useState(false);
  const contract = asset.primaryContract;

  return (
    <header className="flex items-start gap-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-edge bg-raised">
        {asset.logoUrl && !logoFailed ? (
          <img
            src={asset.logoUrl}
            alt=""
            width={44}
            height={44}
            className="h-11 w-11 object-cover"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span className="tnum text-[12px] font-semibold text-muted">{asset.symbol.slice(0, 3)}</span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h1 className="text-[22px] font-medium leading-tight tracking-display text-ink sm:text-[26px]">
            {asset.name}
          </h1>
          <span className="tnum rounded-[2px] border border-edge px-1.5 py-0.5 text-[11.5px] text-muted">
            {asset.symbol}
          </span>
          {asset.rank ? <span className="tnum text-[11.5px] text-faint">#{asset.rank}</span> : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
          {asset.chain ? <span className="text-muted">{asset.chain}</span> : null}
          {contract ? (
            contract.explorerUrl ? (
              <a
                href={contract.explorerUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="tnum inline-flex items-center gap-1.5 text-faint transition-colors duration-150 hover:text-mint"
              >
                {truncateMiddle(contract.address, 6, 4)}
                <LinkIcon className="h-3 w-3" />
              </a>
            ) : (
              <span className="tnum text-faint">{truncateMiddle(contract.address, 6, 4)}</span>
            )
          ) : null}
          {asset.websiteUrl ? (
            <a
              href={asset.websiteUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-faint transition-colors duration-150 hover:text-mint"
            >
              Website
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function MetricStrip({ data }: { data: AnalyzeResponse }) {
  const { asset } = data;
  const delta = impliedPriceDelta(asset.price, asset.percentChange24h);
  const turnover = data.analysis.signals.turnoverLevel;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-edge bg-edge sm:grid-cols-3 lg:grid-cols-5">
      <Metric
        className="bg-panel"
        label="Price"
        value={formatPrice(asset.price)}
        sub={delta !== null ? signedPrice(delta) : null}
        subClass={changeColor(asset.percentChange24h)}
      />
      <Metric
        className="bg-panel"
        label="24h change"
        value={formatPercent(asset.percentChange24h)}
        sub={asset.percentChange1h !== null ? `${formatPercent(asset.percentChange1h)} 1h` : null}
        subClass={changeColor(asset.percentChange1h)}
      />
      <Metric className="bg-panel" label="Market cap" value={formatCompactUsd(asset.marketCap)} sub={null} />
      <Metric
        className="bg-panel"
        label="24h volume"
        value={formatCompactUsd(asset.volume24h)}
        sub={asset.volumeChange24h !== null ? `${formatPercent(asset.volumeChange24h)} 24h` : null}
        subClass={changeColor(asset.volumeChange24h)}
      />
      <Metric
        className="col-span-2 bg-panel sm:col-span-2 lg:col-span-1"
        label="Volume / market cap"
        value={formatRatio(asset.volumeToMarketCap)}
        sub={turnover === 'unknown' ? null : turnover}
      />
    </div>
  );
}

function SupportingRead({ role, driver }: { role: string; driver: Driver }) {
  return (
    <div className="bg-panel px-5 py-5 sm:px-6 sm:py-6">
      <Marker tone={driver.tone} label={role} />
      <h3 className={`mt-3 text-[16.5px] font-medium tracking-tight ${TONE_TEXT[driver.tone]}`}>{driver.title}</h3>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{driver.explanation}</p>
    </div>
  );
}

function ConfidenceTag({ confidence }: { confidence: AnalyzeResponse['analysis']['confidence'] }) {
  const copy: Record<typeof confidence, string> = {
    high: 'Full data',
    moderate: 'Partial data',
    limited: 'Limited data'
  };
  const tone = confidence === 'high' ? 'text-faint' : 'text-amber';
  return <span className={`text-[11px] uppercase tracking-[0.1em] ${tone}`}>{copy[confidence]}</span>;
}

/**
 * MOVING's signature module (spec section 16): the headline deltas at a
 * glance, plus which one moved the most. Distinct from Data Used below it —
 * this is the narrative "what changed" read; Data Used is the full transparency
 * table. Nothing here is an official CMC field beyond what AssetHeader/
 * MetricStrip already show as real; the callout is a plain comparison of
 * already-displayed percentages, not a new derived metric, so it needs no
 * "derived" label of its own.
 */
function WhatChanged({ asset }: { asset: AnalyzeResponse['asset'] }) {
  const metrics = collectChangeMetrics(asset);
  const biggest = biggestChange(asset);
  if (metrics.length === 0) return null;

  return (
    <section className="panel px-5 py-5 sm:px-6">
      <FieldLabel>What changed</FieldLabel>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label} className="flex flex-col gap-1">
            <dt className="text-[11px] uppercase tracking-[0.08em] text-faint">{m.label}</dt>
            <dd className={`tnum text-[15px] font-medium ${changeColor(m.value)}`}>{m.formatted}</dd>
          </div>
        ))}
      </dl>
      {biggest ? (
        <p className="mt-4 border-t border-edge-soft pt-3 text-[12.5px] text-muted">
          <span className="text-faint">Biggest measurable change — </span>
          <span className="text-ink">{biggest.label}</span>
        </p>
      ) : null}
    </section>
  );
}

function DataUsed({ data }: { data: AnalyzeResponse }) {
  const { analysis, asset } = data;

  return (
    <section className="panel px-5 py-5 sm:px-6">
      <FieldLabel>Data used</FieldLabel>
      <dl className="mt-4 grid grid-cols-1 gap-x-10 sm:grid-cols-2">
        {analysis.dataUsed.map((point) => (
          <Row key={point.label} label={point.label} note={point.note} value={point.value} />
        ))}
        {asset.circulatingSupply !== null ? (
          <Row label="Circulating supply" value={`${formatCompactNumber(asset.circulatingSupply)} ${asset.symbol}`} />
        ) : null}
      </dl>

      {analysis.missing.length > 0 ? (
        <p className="mt-5 border-t border-edge-soft pt-4 text-[12px] leading-relaxed text-amber/80">
          Some market metrics are unavailable for this asset: {analysis.missing.join(', ')}. The diagnosis is based on
          what remains.
        </p>
      ) : null}
    </section>
  );
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-edge-soft py-2.5 last:border-b-0">
      <dt className="text-[13px] text-muted">
        {label}
        {note ? <span className="ml-1.5 text-[11px] text-faint">({note})</span> : null}
      </dt>
      <dd className="tnum shrink-0 text-[13px] text-ink">{value}</dd>
    </div>
  );
}
