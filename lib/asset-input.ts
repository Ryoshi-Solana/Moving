import { AppError } from '@/lib/errors';

/**
 * Everything that decides *what the user typed*, kept free of network code so
 * it can be tested on its own.
 */

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export type InputKind = 'address' | 'text';

export function classifyInput(raw: string): InputKind {
  const value = raw.trim();
  if (EVM_ADDRESS.test(value) || TRON_ADDRESS.test(value) || SOLANA_ADDRESS.test(value)) return 'address';
  return 'text';
}

/**
 * Rejects anything that is not plausibly a ticker, name or address before it
 * reaches the upstream API. Throws AppError('INVALID_INPUT') on failure.
 */
export function sanitizeQuery(raw: unknown): string {
  if (typeof raw !== 'string') throw new AppError('INVALID_INPUT');
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length === 0 || value.length > 64) throw new AppError('INVALID_INPUT');
  if (!/^[\w\s.$@+\-']+$/u.test(value)) throw new AppError('INVALID_INPUT');
  return value;
}

/** Ticker-shaped input is worth a direct symbol lookup. */
export function looksLikeSymbol(value: string): boolean {
  return /^[A-Za-z0-9$]{1,12}$/.test(value);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
