/**
 * Shared types.
 *
 * `types/cmc.*` mirror the raw CoinMarketCap payloads we read.
 * `AssetSnapshot` is the normalized shape the rest of the app uses — nothing
 * downstream of `services/coinmarketcap.ts` should touch a raw CMC object.
 */

/* ------------------------------------------------------------------ *
 * CoinMarketCap raw payloads (only the fields we actually consume)
 * ------------------------------------------------------------------ */

export interface CmcStatus {
  timestamp: string;
  error_code: number;
  error_message: string | null;
  credit_count?: number;
}

export interface CmcQuote {
  price: number | null;
  volume_24h: number | null;
  volume_change_24h: number | null;
  percent_change_1h: number | null;
  percent_change_24h: number | null;
  percent_change_7d: number | null;
  percent_change_30d: number | null;
  market_cap: number | null;
  market_cap_dominance: number | null;
  fully_diluted_market_cap: number | null;
  last_updated: string | null;
}

export interface CmcPlatform {
  id?: number;
  name: string | null;
  symbol: string | null;
  slug?: string | null;
  token_address: string | null;
}

export interface CmcQuoteItem {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  cmc_rank: number | null;
  num_market_pairs: number | null;
  circulating_supply: number | null;
  total_supply: number | null;
  max_supply: number | null;
  infinite_supply?: boolean;
  is_active?: number;
  platform: CmcPlatform | null;
  last_updated: string | null;
  quote: Record<string, CmcQuote>;
}

export interface CmcInfoItem {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  category?: string;
  description?: string | null;
  logo?: string | null;
  platform: CmcPlatform | null;
  contract_address?: Array<{
    contract_address: string;
    platform?: { name?: string; coin?: { id?: string; name?: string; symbol?: string; slug?: string } };
  }>;
  urls?: Record<string, string[]>;
}

export interface CmcMapItem {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  rank: number | null;
  is_active: number;
  platform: CmcPlatform | null;
}

/* ------------------------------------------------------------------ *
 * Normalized application shapes
 * ------------------------------------------------------------------ */

export interface ContractRef {
  address: string;
  platform: string | null;
  explorerUrl: string | null;
}

export interface AssetSnapshot {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  rank: number | null;
  logoUrl: string | null;
  category: string | null;

  /** Chain the token lives on, when it is a token rather than a native coin. */
  chain: string | null;
  primaryContract: ContractRef | null;
  contracts: ContractRef[];
  websiteUrl: string | null;

  price: number | null;
  percentChange1h: number | null;
  percentChange24h: number | null;
  percentChange7d: number | null;
  percentChange30d: number | null;

  marketCap: number | null;
  fullyDilutedMarketCap: number | null;
  marketCapDominance: number | null;
  /** Derived, not reported by CMC. See `deriveMarketCapChange24h`. */
  marketCapChange24h: number | null;
  marketCapChangeIsDerived: boolean;

  volume24h: number | null;
  volumeChange24h: number | null;
  volumeToMarketCap: number | null;

  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  numMarketPairs: number | null;

  currency: string;
  lastUpdated: string | null;
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

export type Direction = 'up' | 'down' | 'flat';
export type MoveSize = 'quiet' | 'modest' | 'strong' | 'extreme';
export type VolumeTrend = 'contracting' | 'flat' | 'expanding' | 'surging' | 'unknown';
export type TurnoverLevel = 'dormant' | 'normal' | 'elevated' | 'extreme' | 'unknown';
export type Confidence = 'limited' | 'moderate' | 'high';
export type DriverTone = 'positive' | 'caution' | 'negative' | 'neutral';

export interface Signals {
  direction: Direction;
  moveSize: MoveSize;
  /** 0–1. How big the 24h move is relative to a 25% reference move. */
  momentumStrength: number;
  volumeTrend: VolumeTrend;
  /** 0–1. How strongly volume growth backs the price move. Null when unknown. */
  volumeConfirmation: number | null;
  /** volume_24h / market_cap. */
  turnover: number | null;
  turnoverLevel: TurnoverLevel;
  /** |volumeChange| / |priceChange|. How much louder volume is than price. */
  amplification: number | null;
  /** -1..1. Agreement between 1h, 24h and 7d direction. */
  trendAlignment: number;
  /** True when the last hour points against the 24h move. */
  shortTermReversal: boolean;
  liquidityBreadth: 'thin' | 'moderate' | 'deep' | 'unknown';
  missing: string[];
}

export interface Driver {
  key: string;
  /** Drivers in the same group never fill both primary and secondary. */
  group: string;
  title: string;
  explanation: string;
  tone: DriverTone;
  score: number;
}

export interface MarketStructure {
  title: string;
  explanation: string;
  tone: DriverTone;
}

export interface DataPoint {
  label: string;
  value: string;
  note?: string;
}

export interface Analysis {
  primary: Driver;
  secondary: Driver | null;
  structure: MarketStructure;
  verdict: string;
  confidence: Confidence;
  dataUsed: DataPoint[];
  missing: string[];
  signals: Signals;
}

export interface AnalyzeResponse {
  asset: AssetSnapshot;
  analysis: Analysis;
  /** ISO timestamp of when this payload was assembled. */
  generatedAt: string;
}

export type ApiErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_CONTRACT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'MISSING_DATA'
  | 'CONFIG_ERROR';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    hint?: string;
  };
}
