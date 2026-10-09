import type { ApiErrorCode } from '@/types';

/**
 * Every failure path in the app funnels through AppError so that raw upstream
 * messages never reach the browser. `message` is the copy the user sees.
 */
export class AppError extends Error {
  code: ApiErrorCode;
  status: number;
  hint?: string;
  /** Kept server-side only, for logs. */
  detail?: string;

  constructor(code: ApiErrorCode, opts: { message?: string; hint?: string; detail?: string; status?: number } = {}) {
    const preset = ERROR_COPY[code];
    super(opts.message ?? preset.message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? preset.status;
    this.hint = opts.hint ?? preset.hint;
    this.detail = opts.detail;
  }
}

export const ERROR_COPY: Record<ApiErrorCode, { message: string; hint?: string; status: number }> = {
  NOT_FOUND: {
    message: "We couldn't find this asset.",
    hint: 'Try a ticker, coin name, or a supported contract address.',
    status: 404
  },
  INVALID_INPUT: {
    message: 'That search looks empty or too long.',
    hint: 'Enter a ticker like BTC, a name like Solana, or a contract address.',
    status: 400
  },
  INVALID_CONTRACT: {
    message: "That doesn't appear to be a valid supported asset or contract address.",
    hint: 'Try a token listed on CoinMarketCap or a contract with a searchable DexScreener market pair.',
    status: 404
  },
  RATE_LIMITED: {
    message: 'Too many requests right now. Please try again shortly.',
    status: 429
  },
  UPSTREAM_ERROR: {
    message: 'Market data is temporarily unavailable. Please try again.',
    status: 502
  },
  MISSING_DATA: {
    message: 'Some market metrics are unavailable for this asset.',
    hint: 'There is not enough data here to build a reliable diagnosis.',
    status: 422
  },
  CONFIG_ERROR: {
    message: 'Market data is temporarily unavailable. Please try again.',
    hint: 'Server is not configured with a valid market data key.',
    status: 503
  }
};

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new AppError('UPSTREAM_ERROR', { detail });
}
