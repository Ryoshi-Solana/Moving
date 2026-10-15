'use client';

import { useEffect, useState } from 'react';

import type { AssetSnapshot, DiscoveryBoard, FieldPoint, GlobalSnapshot } from '@/types';

export interface MarketFeedsPayload {
  trending: AssetSnapshot[] | null;
  gainers: AssetSnapshot[] | null;
  field?: FieldPoint[] | null;
  boards?: DiscoveryBoard[] | null;
  asOf?: string | null;
}

export interface ContextPayload {
  btc: AssetSnapshot | null;
  global: GlobalSnapshot | null;
}

type Load<T> = { status: 'loading' | 'ready' | 'error'; data: T | null };

/**
 * One request per page view for /api/trending, shared by the ticker, the move
 * field and the discovery boards. No polling: the underlying pool is cached
 * for ~5 minutes server-side, so re-fetching on a timer would only add load.
 */
let feedsPromise: Promise<MarketFeedsPayload> | null = null;

function loadFeeds(): Promise<MarketFeedsPayload> {
  if (!feedsPromise) {
    feedsPromise = fetch('/api/trending', { headers: { Accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<MarketFeedsPayload>;
      })
      .catch((err) => {
        feedsPromise = null;
        throw err;
      });
  }
  return feedsPromise;
}

export function useMarketFeeds(): Load<MarketFeedsPayload> {
  const [state, setState] = useState<Load<MarketFeedsPayload>>({ status: 'loading', data: null });
  useEffect(() => {
    let alive = true;
    loadFeeds()
      .then((data) => alive && setState({ status: 'ready', data }))
      .catch(() => alive && setState({ status: 'error', data: null }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** Reused for up to two minutes (the server cache window); used by the dossier's market-context row and questions. */
let contextPromise: Promise<ContextPayload> | null = null;
let contextLoadedAt = 0;
const CONTEXT_MAX_AGE_MS = 120_000;

export function loadContext(): Promise<ContextPayload> {
  if (!contextPromise || Date.now() - contextLoadedAt > CONTEXT_MAX_AGE_MS) {
    contextLoadedAt = Date.now();
    contextPromise = fetch('/api/context', { headers: { Accept: 'application/json' } })
      .then((r) => r.json() as Promise<ContextPayload>)
      .catch(() => {
        contextPromise = null;
        return { btc: null, global: null };
      });
  }
  return contextPromise;
}

export function useMarketContext(): ContextPayload | null {
  const [context, setContext] = useState<ContextPayload | null>(null);
  useEffect(() => {
    let alive = true;
    void loadContext().then((c) => alive && setContext(c));
    return () => {
      alive = false;
    };
  }, []);
  return context;
}
