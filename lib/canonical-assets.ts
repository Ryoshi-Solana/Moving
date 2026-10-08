/**
 * CoinMarketCap ids of the assets people mean by a bare ticker.
 *
 * Symbols are not unique on CMC: "BTC" or "SOL" also name unrelated tokens. For
 * the handful of tickers where that matters most we pin the intended asset by
 * its stable CMC id, which also lets the request go straight to a single
 * quote-by-id call with no directory or symbol lookup. Every other ticker
 * resolves through the cached /v1/cryptocurrency/map (highest-ranked active
 * match) — see services/resolve-asset.ts.
 */
export const CANONICAL_ASSET_IDS: Readonly<Record<string, number>> = {
  BTC: 1, // Bitcoin
  ETH: 1027, // Ethereum
  SOL: 5426 // Solana
};

export function canonicalIdFor(symbol: string): number | undefined {
  return CANONICAL_ASSET_IDS[symbol.replace(/^\$/, '').toUpperCase()];
}
