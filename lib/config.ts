/**
 * Public brand configuration.
 * Set SOCIAL_LINKS.x to the project's official profile URL when available.
 * Replace PUMPFUN_URL with the token's exact Pump.fun page after launch.
 */
export const PUMPFUN_URL = 'https://pump.fun/';

export const SOCIAL_LINKS = {
  x: 'https://x.com/'
} as const;

export const APP = {
  name: 'Why is this coin moving?',
  short: 'MOVING',
  tagline: 'Turn crypto market data into an explanation, not just another chart.',
  disclaimer:
    'This analysis is generated from available market data and is not financial advice. Market movements can have multiple causes that may not be captured by the available data.'
} as const;
