import type { DriverTone } from '@/types';

/**
 * Tone mapping.
 *
 * Only three colours ever carry meaning: mint (positive), amber (caution),
 * rose (negative). A "neutral" diagnosis is exactly that — plain text and a
 * grey rule, not a fourth hue.
 */
export const TONE_TEXT: Record<DriverTone, string> = {
  positive: 'text-mint',
  caution: 'text-amber',
  negative: 'text-rose',
  neutral: 'text-ink'
};

export const TONE_RULE: Record<DriverTone, string> = {
  positive: 'bg-mint',
  caution: 'bg-amber',
  negative: 'bg-rose',
  neutral: 'bg-muted'
};

export function changeColor(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'text-faint';
  if (value > 0) return 'text-mint';
  if (value < 0) return 'text-rose';
  return 'text-ink';
}

/** Sentence-case section label. */
export function FieldLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`label ${className}`}>{children}</span>;
}

/** Placeholder for a metric the provider did not report — never shown as zero. */
export const NOT_REPORTED = 'Not reported';

export function Metric({
  label,
  value,
  sub,
  subClass = 'text-muted',
  className = '',
  hint
}: {
  label: string;
  value: string;
  sub?: string | null;
  subClass?: string;
  className?: string;
  hint?: string;
}) {
  const missing = value === '—';
  return (
    <div className={`flex min-w-0 flex-col gap-2 px-4 py-4 sm:px-5 ${className}`} title={hint}>
      <span className="label">{label}</span>
      {missing ? (
        <span className="text-[13px] leading-[21px] text-faint">{NOT_REPORTED}</span>
      ) : (
        // 17px on mobile: a sub-cent price like $0.0000124 must fit a two-column cell at 320px.
        <span className="tnum truncate text-[17px] font-medium leading-none tracking-tight text-ink sm:text-[21px]">{value}</span>
      )}
      <span className={`tnum text-[12.5px] leading-none ${sub ? subClass : 'text-transparent'}`}>{sub ?? ' '}</span>
    </div>
  );
}
