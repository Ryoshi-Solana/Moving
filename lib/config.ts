/**
 * Single place to edit brand + social links.
 * Replace the placeholder handles before launch.
 */

export const SOCIAL_LINKS = {
  telegram: 'https://t.me/YOUR_TELEGRAM',
  x: 'https://x.com/YOUR_X_HANDLE'
} as const;

export const APP = {
  name: 'Why is this coin moving?',
  short: 'MOVING',
  tagline: 'Turn crypto market data into an explanation — not just another chart.',
  disclaimer:
    'This analysis is generated from available market data and is not financial advice. Market movements can have multiple causes that may not be captured by the available data.'
} as const;
