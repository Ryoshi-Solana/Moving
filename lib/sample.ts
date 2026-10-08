import { analyze } from '@/analysis/engine';
import type { AnalyzeResponse, AssetSnapshot } from '@/types';

/**
 * Sample data for the landing-page example only.
 *
 * The numbers are illustrative, but they are fed through the same engine the
 * live search uses — so the example can never drift from real behaviour.
 * Nothing else in the app reads this file.
 */
const SAMPLE_ASSET: AssetSnapshot = {
  id: 24478,
  name: 'Pepe',
  symbol: 'PEPE',
  slug: 'pepe',
  rank: 28,
  logoUrl: null,
  category: 'token',
  chain: 'Ethereum',
  primaryContract: null,
  contracts: [],
  websiteUrl: null,

  price: 0.0000124,
  percentChange1h: 1.2,
  percentChange24h: 27.4,
  percentChange7d: 38.1,
  percentChange30d: 52.3,

  marketCap: 5_210_000_000,
  fullyDilutedMarketCap: 5_210_000_000,
  marketCapDominance: 0.18,
  marketCapChange24h: 27.4,
  marketCapChangeIsDerived: true,

  volume24h: 2_180_000_000,
  volumeChange24h: 184.6,
  volumeToMarketCap: 2_180_000_000 / 5_210_000_000,

  cexVolume24h: null,
  dexVolume24h: null,

  circulatingSupply: 420_690_000_000_000,
  totalSupply: 420_690_000_000_000,
  maxSupply: null,
  numMarketPairs: 412,

  currency: 'USD',
  lastUpdated: null
};

export function sampleAnalysis(): AnalyzeResponse {
  return {
    asset: SAMPLE_ASSET,
    analysis: analyze(SAMPLE_ASSET),
    generatedAt: '1970-01-01T00:00:00.000Z'
  };
}
