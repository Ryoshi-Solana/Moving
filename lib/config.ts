import { verifiedPublicUrl } from '@/lib/public-links';

/**
 * Public brand configuration. Generic homepages must never masquerade as
 * official project destinations. Public URLs may be overridden in Vercel.
 */
export const PUMPFUN_URL = verifiedPublicUrl(
  process.env.NEXT_PUBLIC_PUMPFUN_URL,
  ['pump.fun', 'www.pump.fun']
);

export const SOCIAL_LINKS = {
  x: verifiedPublicUrl(
    process.env.NEXT_PUBLIC_X_URL || 'https://x.com/why_moving',
    ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']
  )
} as const;

export const APP = {
  name: 'Why is this coin moving?',
  short: 'MOVING',
  tagline: 'Turn crypto market data into an explanation, not just another chart.',
  disclaimer:
    'This analysis is generated from available market data and is not financial advice. Market movements can have multiple causes that may not be captured by the available data.'
} as const;
