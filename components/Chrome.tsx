import Image from 'next/image';
import Link from 'next/link';

import { FocusSearchButton } from '@/components/FocusSearchButton';
import { XIcon } from '@/components/icons';
import { APP, PUMPFUN_URL, SOCIAL_LINKS } from '@/lib/config';

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-void/80 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-shell items-center justify-between gap-4 px-5 sm:px-8" aria-label="Main">
        <Link href="/" className="flex shrink-0 items-center" aria-label={`${APP.short} home`}>
          <Image src="/moving-logo-clean.svg" alt="MOVING" width={148} height={34} priority className="h-8 w-auto" />
        </Link>
        <div className="hidden items-center gap-6 text-[13.5px] text-muted md:flex">
          <a href="#coin-search" className="transition-colors hover:text-ink">
            Investigate
          </a>
          <a href="#screens" className="transition-colors hover:text-ink">
            Screens
          </a>
          <a href="#method" className="transition-colors hover:text-ink">
            Method
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {SOCIAL_LINKS.x ? (
            <a
              href={SOCIAL_LINKS.x}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="MOVING on X"
              className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-edge text-muted transition-colors hover:border-teal/50 hover:text-ink"
            >
              <XIcon className="h-[16px] w-[16px]" />
            </a>
          ) : null}
          {PUMPFUN_URL ? (
            <a
              href={PUMPFUN_URL}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Buy MOVING on Pump.fun (opens in a new tab)"
              className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-teal/40 px-3 text-[12.5px] font-semibold text-teal transition-colors hover:bg-teal hover:text-void"
            >
              <Image src="/moving-mark.svg" alt="" aria-hidden="true" width={16} height={16} className="h-4 w-4" />
              <span>Buy $MOVING</span>
            </a>
          ) : null}
        </div>
      </nav>
    </header>
  );
}

const EVIDENCE_CLASSES = [
  {
    title: 'Observed',
    body: 'Prices, volumes, market cap, liquidity and timestamps exactly as the data provider reports them. Missing values are labelled, never filled in.'
  },
  {
    title: 'Interpreted',
    body: 'A fixed, published set of rules compares those numbers — is volume backing the move, is turnover unusual, do the timeframes agree. Same input, same answer, every time.'
  },
  {
    title: 'Outside the data',
    body: 'News, listings, social attention and wallet flows are invisible to market data. MOVING lists them instead of guessing which one it was.'
  }
];

export function Method() {
  return (
    <section id="method" className="border-t border-edge" aria-labelledby="method-title">
      <div className="mx-auto grid max-w-shell gap-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
        <div>
          <h2 id="method-title" className="wide text-[28px] font-semibold tracking-display text-ink sm:text-[34px]">
            How a reading is built
          </h2>
          <p className="mt-3 max-w-[44ch] text-[15px] leading-relaxed text-muted">
            Every investigation separates three kinds of statement, so you always know which parts are facts and which are
            inference.
          </p>
        </div>
        <dl className="grid gap-px overflow-hidden rounded-[6px] border border-edge bg-edge sm:grid-cols-3">
          {EVIDENCE_CLASSES.map((item) => (
            <div key={item.title} className="bg-panel px-5 py-6">
              <dt className="text-[16px] font-semibold text-ink">{item.title}</dt>
              <dd className="mt-2 text-[13.5px] leading-relaxed text-muted">{item.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="border-t border-edge">
      <div className="mx-auto flex max-w-shell flex-col items-start justify-between gap-6 px-5 py-14 sm:flex-row sm:items-center sm:px-8">
        <p className="wide max-w-[24ch] text-[26px] font-semibold leading-[1.1] tracking-display text-ink sm:text-[32px]">
          Every move has a story. Start with the data.
        </p>
        <FocusSearchButton />
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-edge">
      <div className="mx-auto flex max-w-shell flex-col gap-5 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="space-y-1.5">
          <Image src="/moving-logo-clean.svg" alt="MOVING" width={120} height={28} className="h-6 w-auto opacity-80" />
          <p className="max-w-readable text-[12.5px] leading-relaxed text-faint">
            Market data from CoinMarketCap and DexScreener; price history from Coinbase and GeckoTerminal when it can be
            verified. Not financial advice.
          </p>
        </div>
        {SOCIAL_LINKS.x || PUMPFUN_URL ? (
          <div className="flex items-center gap-4 text-[13px]">
            {SOCIAL_LINKS.x ? (
              <a href={SOCIAL_LINKS.x} target="_blank" rel="noreferrer noopener" aria-label="MOVING on X" className="p-2 text-muted transition-colors hover:text-ink">
                <XIcon className="h-[16px] w-[16px]" />
              </a>
            ) : null}
            {PUMPFUN_URL ? (
              <a href={PUMPFUN_URL} target="_blank" rel="noreferrer noopener" className="text-teal transition-colors hover:text-ink">
                Buy $MOVING
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </footer>
  );
}
