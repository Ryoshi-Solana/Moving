import { AppError } from '@/lib/errors';
import type { AssetSnapshot, CmcInfoItem, CmcQuoteItem, ContractRef } from '@/types';

/**
 * Converts raw CoinMarketCap payloads into the single normalized shape the rest
 * of the app consumes. Missing fields become null rather than throwing — the
 * analysis engine is built to reason about incomplete data.
 */
export function normalize(item: CmcQuoteItem, info: CmcInfoItem | null): AssetSnapshot {
  const quote = item.quote?.USD;
  if (!quote) throw new AppError('MISSING_DATA', { detail: `No USD quote for ${item.symbol}` });

  const marketCap = finite(quote.market_cap);
  const volume24h = finite(quote.volume_24h);
  const percentChange24h = finite(quote.percent_change_24h);
  const contracts = buildContracts(item, info);

  return {
    id: item.id,
    name: item.name,
    symbol: item.symbol,
    slug: item.slug,
    rank: item.cmc_rank ?? null,
    logoUrl: info?.logo ?? `https://s2.coinmarketcap.com/static/img/coins/64x64/${item.id}.png`,
    category: info?.category ?? null,

    chain: item.platform?.name ?? info?.platform?.name ?? null,
    primaryContract: contracts[0] ?? null,
    contracts,
    websiteUrl: firstUrl(info, 'website'),

    price: finite(quote.price),
    percentChange1h: finite(quote.percent_change_1h),
    percentChange24h,
    percentChange7d: finite(quote.percent_change_7d),
    percentChange30d: finite(quote.percent_change_30d),

    marketCap,
    fullyDilutedMarketCap: finite(quote.fully_diluted_market_cap),
    marketCapDominance: finite(quote.market_cap_dominance),
    // CMC does not report a market-cap change field on the Basic plan. With
    // supply constant over 24h, cap moves with price, so we surface that and
    // flag it as derived rather than inventing a number.
    marketCapChange24h: percentChange24h,
    marketCapChangeIsDerived: percentChange24h !== null,

    volume24h,
    volumeChange24h: finite(quote.volume_change_24h),
    volumeToMarketCap: marketCap && volume24h && marketCap > 0 ? volume24h / marketCap : null,

    // The Basic-plan quotes endpoint this app calls has no CEX/DEX split.
    // Always null here — see the AssetSnapshot type comment.
    cexVolume24h: null,
    dexVolume24h: null,

    circulatingSupply: finite(item.circulating_supply),
    totalSupply: finite(item.total_supply),
    maxSupply: finite(item.max_supply),
    numMarketPairs: item.num_market_pairs ?? null,

    currency: 'USD',
    lastUpdated: quote.last_updated ?? item.last_updated ?? null,
    dataSource: 'CoinMarketCap',
    dataSourceUrl: null
  };
}

function buildContracts(item: CmcQuoteItem, info: CmcInfoItem | null): ContractRef[] {
  const refs: ContractRef[] = [];
  const seen = new Set<string>();

  const push = (address: string | null | undefined, platform: string | null) => {
    if (!address) return;
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ address, platform, explorerUrl: explorerFor(platform, address) });
  };

  push(item.platform?.token_address, item.platform?.name ?? null);
  push(info?.platform?.token_address, info?.platform?.name ?? null);
  for (const entry of info?.contract_address ?? []) {
    push(entry.contract_address, entry.platform?.coin?.name ?? entry.platform?.name ?? null);
  }

  return refs.slice(0, 4);
}

const EXPLORERS: Array<[RegExp, (address: string) => string]> = [
  [/^ethereum$/i, (a) => `https://etherscan.io/token/${a}`],
  [/^bnb|^binance/i, (a) => `https://bscscan.com/token/${a}`],
  [/^solana$/i, (a) => `https://solscan.io/token/${a}`],
  [/^polygon|^matic/i, (a) => `https://polygonscan.com/token/${a}`],
  [/^base$/i, (a) => `https://basescan.org/token/${a}`],
  [/^arbitrum/i, (a) => `https://arbiscan.io/token/${a}`],
  [/^optimism/i, (a) => `https://optimistic.etherscan.io/token/${a}`],
  [/^avalanche/i, (a) => `https://snowtrace.io/token/${a}`],
  [/^tron$/i, (a) => `https://tronscan.org/#/token20/${a}`],
  [/^sui$/i, (a) => `https://suiscan.xyz/mainnet/coin/${a}`],
  [/^ton|^toncoin/i, (a) => `https://tonviewer.com/${a}`]
];

export function explorerFor(platform: string | null, address: string): string | null {
  if (!platform) return null;
  for (const [pattern, build] of EXPLORERS) {
    if (pattern.test(platform)) return build(address);
  }
  return null;
}

function firstUrl(info: CmcInfoItem | null, key: string): string | null {
  const list = info?.urls?.[key];
  if (!list || list.length === 0) return null;
  const url = list[0];
  return /^https?:\/\//i.test(url) ? url : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Tickers are not unique on CoinMarketCap - dozens of tokens call themselves
 * PEPE. Prefer the one with real market cap, then real volume, then rank, so a
 * search lands on the asset the user almost certainly means.
 */
export function pickBest(items: CmcQuoteItem[]): CmcQuoteItem | null {
  const usable = items.filter((item) => item && item.quote);
  if (usable.length === 0) return null;
  return usable.slice().sort((a, b) => {
    const capA = a.quote?.USD?.market_cap ?? 0;
    const capB = b.quote?.USD?.market_cap ?? 0;
    if (capB !== capA) return capB - capA;
    const volA = a.quote?.USD?.volume_24h ?? 0;
    const volB = b.quote?.USD?.volume_24h ?? 0;
    if (volB !== volA) return volB - volA;
    return (a.cmc_rank ?? 1e9) - (b.cmc_rank ?? 1e9);
  })[0];
}
