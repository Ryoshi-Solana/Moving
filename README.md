# Why is this coin moving?

A user types a ticker, coin name, or contract address. The app pulls live
CoinMarketCap data, compares the metrics against each other, and explains what
the data suggests is driving the move.

One job, done well. No accounts, no portfolios, no charts.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # then paste your CoinMarketCap key
npm run dev                    # http://localhost:3000
```

Get a free key at <https://pro.coinmarketcap.com/signup>. The free "Basic" plan
is enough for everything here.

```bash
npm test          # six offline suites, no network, no API credits
npm run typecheck # tsc --noEmit
npm run build     # production build
```

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `CMC_API_KEY` | Yes | CoinMarketCap Pro API key. Server-side only. |
| `CMC_BASE_URL` | No | Defaults to `https://pro-api.coinmarketcap.com`. Point at `https://sandbox-api.coinmarketcap.com` to develop without spending credits. |
| `CMC_CACHE_TTL_SECONDS` | No | Quote cache lifetime. Default `60`. |
| `RATE_LIMIT_PER_MINUTE` | No | Requests per IP per minute. Default `20`. |

**Never prefix the key with `NEXT_PUBLIC_`.** It is read only inside
`services/coinmarketcap.ts`, which begins with `import 'server-only'` — if any
client component ever imports that module, the build fails rather than shipping
the key to the browser.

### Adding the key on Vercel

1. Import the repo at <https://vercel.com/new>. Next.js is detected
   automatically; no build settings to change.
2. **Project → Settings → Environment Variables**
   - Key: `CMC_API_KEY`
   - Value: your key
   - Environments: Production, Preview, Development
3. Deploy. Environment variables are not applied to existing builds, so if you
   add the key after the first deploy, redeploy once.

Locally the same value goes in `.env.local`, which is gitignored.

---

## Project structure

```
app/
  layout.tsx              root layout, metadata, backdrop layers
  page.tsx                landing page composition
  globals.css             design tokens, grid/noise backdrop
  api/analyze/route.ts    the only server endpoint
components/
  AnalyzePanel.tsx        client: search → loading → result/error
  AnalysisReport.tsx      the full diagnosis view
  ExampleAnalysis.tsx     optional example component (not shown by default)
  States.tsx              loading + error states
  Chrome.tsx              navbar, how it works, CTA, footer
  ui.tsx, icons.tsx       shared primitives
services/
  coinmarketcap.ts        typed CMC client (server-only)
  resolve-asset.ts        search string → asset (server-only)
  normalize.ts            CMC payload → AssetSnapshot (pure)
analysis/
  signals.ts              raw metrics → comparable signals + all thresholds
  engine.ts               driver scoring, structure, verdict
lib/
  asset-input.ts          validation + address detection
  cache.ts                TTL cache with single-flight
  rate-limit.ts           per-IP limiter
  errors.ts               typed errors → user-facing copy
  format.ts               number/percent formatting
  config.ts               SOCIAL_LINKS and brand copy
  server-config.ts        server-only tunables (TTLs, rate limit)
  sample.ts               example-only sample data (not shown by default)
types/index.ts            all shared types
scripts/                  offline test suites
```

**Editing the social link:** `lib/config.ts` → `SOCIAL_LINKS.x`. The X link is shown
in the navbar and footer; Telegram is intentionally omitted.

---

## CoinMarketCap endpoints used

All three are available on the free Basic plan.

| Endpoint | Used for | Cache |
| --- | --- | --- |
| `GET /v2/cryptocurrency/quotes/latest` | Price, percent changes, market cap, volume, volume change, supply, market pairs. Called with `id`, `symbol`, or `slug`. | 60s |
| `GET /v2/cryptocurrency/info` | Logo, category, chain, contract addresses, website. Also does contract-address resolution via the `address` parameter. | 24h |
| `GET /v1/cryptocurrency/map` | Fuzzy name search fallback, sorted by rank. One call serves every search on the instance. | 6h |

A typical search costs **1–2 credits**. Repeat searches inside the cache window
cost zero. Concurrent identical searches are collapsed into a single upstream
request (`lib/cache.ts` single-flight), so a burst of traffic on one trending
coin does not multiply into a burst of API calls.

### Resolution order

1. Input matches an EVM (`0x…40 hex`), Solana (base58, 32–44 chars), or Tron
   address shape → `info?address=…`, then quotes by the returned id.
2. Ticker-shaped input → `quotes/latest?symbol=…`.
3. Slugified name (`Shiba Inu` → `shiba-inu`) → `quotes/latest?slug=…`.
4. Fuzzy match against the cached map: exact name, then prefix, then substring,
   each ranked by CMC rank.

Tickers collide constantly — dozens of tokens are called PEPE. When a symbol
lookup returns several assets, `pickBest` sorts by market cap, then 24h volume,
then rank, so the search lands on the one the user meant.

---

## How the analysis works

Two stages, both deterministic. No LLM call, no API cost, same input always
produces the same output.

### 1. Signals (`analysis/signals.ts`)

Raw metrics are reduced to comparable signals. Every threshold in the product
lives in one `THRESHOLDS` object here.

| Signal | Meaning |
| --- | --- |
| `direction` | up / down / flat, from 24h change against a ±2% noise floor |
| `moveSize` | quiet (<2%), modest (<10%), strong (<40%), extreme (≥40%) |
| `momentumStrength` | 0–1, move size normalized against a 25% reference |
| `volumeTrend` | contracting / flat / expanding / surging, from `volume_change_24h` |
| `volumeConfirmation` | 0–1, how strongly volume growth backs the move. `null` when unavailable |
| `turnover` | `volume_24h / market_cap`, bucketed dormant → extreme |
| `amplification` | `|volume change| / |price change|` — how much louder volume is than price |
| `trendAlignment` | −1…1 agreement between the 1h, 24h and 7d directions |
| `shortTermReversal` | the last hour is running against the 24h move |
| `liquidityBreadth` | thin / moderate / deep, from `num_market_pairs` |
| `missing` | which metrics this asset or plan did not provide |

### 2. Scoring (`analysis/engine.ts`)

Ten candidate drivers each decide whether they apply and score themselves 0–100
against the signals:

`volume-expansion`, `broad-participation`, `thin-liquidity-momentum`,
`selling-pressure`, `fading-interest`, `speculative-activity`,
`rising-activity`, `range-consolidation`, `trend-continuation`,
`short-term-turn`.

- Highest score becomes the **primary driver**.
- Highest score from a *different group* (and ≥25) becomes the **secondary**, so
  the two slots never restate the same observation.
- **Market structure** is classified separately from direction plus whether
  volume confirms it.
- The **verdict** is composed from the winning driver and the actual numbers
  behind it.

Adding a diagnosis means adding one function to `CANDIDATES`. Nothing else
changes.

Language is deliberately hedged — "appears to be", "suggests", "the data
indicates". The engine only knows what CMC reports, so it never claims a
real-world cause (a whale, an exchange listing, a KOL) that market data cannot
establish. It also never predicts direction.

### Confidence and missing data

The engine is built to run on incomplete data. Missing metrics are dropped from
the analysis rather than guessed, the response reports which ones were missing,
and the UI labels the result as partial or limited data.

### Tests

`npm test` runs six offline suites:

- **Analysis** — deterministic driver scoring, missing-data and no-data paths.
- **Resolution** — input validation, address detection, normalization, formatting,
  explorer links, and ticker disambiguation.
- **Integration** — resolver and CMC client behavior against mocked upstream responses.
- **Questions** — question/answer logic and its supported paths.
- **Market feeds** — trending/gainers feed behavior.
- **DexScreener** — fallback lookup and pair/token selection.

The test runner uses Node's built-in TypeScript stripping (`--experimental-strip-types`),
so use Node ≥22.6. No network or API credits are required for these offline suites.

---

## Security

- The API key is read server-side only and guarded by `server-only`.
- Input is validated and length-capped before any upstream call; anything with
  characters outside `[\w\s.$@+\-']` is rejected.
- Upstream responses are normalized field by field into a fixed shape.
  `NaN`/`Infinity` become `null`. Nothing is passed through verbatim.
- Every failure becomes a typed `AppError` with user-facing copy. Raw upstream
  messages and status codes stay in the server log.
- Per-IP rate limiting (20/min by default).

The rate limiter and cache live in process memory. On serverless that is
per-instance, which is fine for abuse dampening and credit saving. If the
product needs a real shared quota, swap `lib/rate-limit.ts` for Vercel KV or
Upstash — it is one small module behind one function.

---

## Known limitations

**From the CoinMarketCap Basic plan:**

1. **No market-cap change field.** CMC does not report one. The app infers it
   from the price change at constant supply. Because it is not a CMC metric, it
   is deliberately **excluded from the primary metric cards** and appears only
   in the Data used section, labelled `derived, not reported by CMC`. It is
   display-only — no driver scores against it. The market-cap *value* itself is
   genuine CMC data and is shown normally.
2. **`volume_change_24h` is occasionally null** for illiquid assets. The engine
   drops volume confirmation and falls back to turnover.
3. **No OHLCV history**, so no intraday reconstruction or volatility measures.
4. **No per-exchange breakdown.** `market-pairs/latest` is not on Basic, so the
   app can only say how many pairs exist, not which venues are driving flow.
5. **Contract lookups only cover listed tokens.** A token CMC has not indexed
   returns the invalid-contract state, however real the contract is.
6. **Quotes are snapshots**, typically a minute or so old.
7. **Credit limits.** The free plan allows 10k credits/month and a handful of
   calls per minute. Caching keeps normal traffic well inside that; a viral
   spike would need a paid plan.

**By design:**

8. The engine explains *what the data shows*, not *why the world did it*. It
   cannot see news, listings, unlocks, or wallet flows, and it says so.
9. It never forecasts direction.

---

## Validation status

Verified by running it:

| Check | Result |
| --- | --- |
| `npm test` (6 offline suites) | not re-run in this audit yet |
| Strict typecheck of `analysis/ lib/ services/ types/ scripts/` | pass, 0 errors |
| Server-side render of every component + state (60 assertions) | pass |

Not yet verified — needs a machine with network access and a real key:

- `npm install`, `npm run build`, `npm run dev`
- `tsc` over the `.tsx` files (needs `@types/react`)
- Live CoinMarketCap responses
- Visual layout in a browser at desktop and mobile widths

---

## Deployment

```bash
npm run build && npm start   # Node 22.6+ recommended/required by the test runner
```

Or push to GitHub and import at <https://vercel.com/new>. Zero config beyond
`CMC_API_KEY`. No database, no external services, no build plugins.

---

Market data from CoinMarketCap. Not financial advice.
