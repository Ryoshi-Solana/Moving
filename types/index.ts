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

/** Minimal shape of /v1/global-metrics/quotes/latest — only fields we use. */
export interface CmcGlobalMetrics {
  btc_dominance: number | null;
  eth_dominance: number | null;
  quote: {
    USD: {
      total_market_cap: number | null;
      total_volume_24h: number | null;
      total_market_cap_yesterday_percentage_change?: number | null;
      total_volume_24h_yesterday_percentage_change?: number | null;
    };
  };
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
  /** Derived, not reported by CMC. See normalize.ts. */
  marketCapChange24h: number | null;
  marketCapChangeIsDerived: boolean;

  volume24h: number | null;
  volumeChange24h: number | null;
  volumeToMarketCap: number | null;

  /**
   * CEX/DEX volume split. The CMC Basic-plan quotes endpoint this app uses
   * does not return these fields, so normalize.ts always sets them to null.
   * They exist on the type so the CEX_VS_DEX question can be wired up
   * end-to-end and will activate automatically if a future data source
   * populates them — never invented, never assumed present.
   */
  cexVolume24h: number | null;
  dexVolume24h: number | null;

  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  numMarketPairs: number | null;

  currency: string;
  lastUpdated: string | null;
  /** Provider used for the normalized snapshot. Optional for legacy fixtures. */
  dataSource?: 'CoinMarketCap' | 'DexScreener';
  /** Direct market/pair URL for transparency, when the provider exposes one. */
  dataSourceUrl?: string | null;
}

/** Normalized global market snapshot, used only by CONTEXT questions. */
export interface GlobalSnapshot {
  totalMarketCap: number | null;
  totalVolume24h: number | null;
  btcDominance: number | null;
  marketCapChange24h: number | null;
}

/**
 * Everything the question engine can draw on beyond the primary asset.
 * Each field is independently optional — a failure fetching one must never
 * block the others or the core analysis.
 */
export interface MarketContext {
  btc: AssetSnapshot | null;
  global: GlobalSnapshot | null;
  movers: AssetSnapshot[] | null;
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
  /** 0–1. How big the 24h move is relative to a reference move. */
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

/* ------------------------------------------------------------------ *
 * Question engine (V1 investigation loop)
 * ------------------------------------------------------------------ */

export type QuestionCategory = 'WHY' | 'STRENGTH' | 'CHANGE' | 'CONTEXT' | 'DISCOVERY';

/** What a question needs before it can even be considered. */
export type QuestionRequirement = 'base' | 'btc' | 'global' | 'movers' | 'cexdex';

export interface QuestionAnswer {
  id: string;
  title: string;
  summary: string;
  /** label/value pairs — the numbers behind the answer, shown expandable. */
  dataUsed: DataPoint[];
  tone: DriverTone;
}

export interface QuestionDefinition {
  id: string;
  category: QuestionCategory;
  label: string;
  requires: QuestionRequirement[];
  /** Returns true if this question is eligible to be offered right now. */
  isEligible: (ctx: QuestionEngineContext) => boolean;
  /** Higher scores are preferred by the selector. */
  priority: (ctx: QuestionEngineContext) => number;
  /** Produces the deterministic answer. Only called when eligible. */
  answer: (ctx: QuestionEngineContext) => QuestionAnswer;
}

/** Everything a question's trigger/priority/handler can read. */
export interface QuestionEngineContext {
  asset: AssetSnapshot;
  analysis: Analysis;
  context: MarketContext;
  answeredIds: string[];
}
