import type { DriverTone } from '@/types';

/**
 * Tone mapping.
 *
 * Only three colours ever carry meaning: mint (positive), amber (caution),
 * rose (negative). A "neutral" diagnosis is exactly that — it gets plain text
 * and a grey rule, not a fourth hue. That is what keeps the interface from
 * turning into a rainbow.
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
  if (value === null || value === undefined) return 'text-muted';
  if (value > 0) return 'text-mint';
  if (value < 0) return 'text-rose';
  return 'text-ink';
}

/** Small uppercase key for a data field. */
export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{children}</span>
  );
}

/**
 * One cell of the market snapshot. The value is the point of the cell, so it
 * gets the mono face and the size; label and delta sit quietly around it.
 */
export function Metric({
  label,
  value,
  sub,
  subClass = 'text-muted',
  className = ''
}: {
  label: string;
  value: string;
  sub?: string | null;
  subClass?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 px-4 py-4 sm:px-5 sm:py-5 ${className}`}>
      <FieldLabel>{label}</FieldLabel>
      {/* 17px on mobile: a sub-cent price like $0.0000124 overflows a two-column
          cell at 19px on a 320px-wide phone. */}
      <span className="tnum text-[17px] font-medium leading-none tracking-tight text-ink sm:text-[21px]">
        {value}
      </span>
      <span className={`tnum text-[12.5px] leading-none ${sub ? subClass : 'text-transparent'}`}>
        {sub ?? '\u00A0'}
      </span>
    </div>
  );
}
