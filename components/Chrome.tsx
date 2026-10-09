import Image from 'next/image';
import Link from 'next/link';
import { APP, PUMPFUN_URL, SOCIAL_LINKS } from '@/lib/config';
import { XIcon } from '@/components/icons';
import { FocusSearchButton } from '@/components/FocusSearchButton';

export function Navbar() {
  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-void/85 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-6">
        <Link href="/" className="group flex items-center" aria-label={`${APP.name} home`}>
          <Image src="/moving-logo-clean.svg" alt="MOVING" width={148} height={34} priority className="h-8 w-auto" />
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          {SOCIAL_LINKS.x ? (
          <a
            href={SOCIAL_LINKS.x}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="MOVING on X"
            title="X / Twitter"
            className="inline-flex h-9 w-9 items-center justify-center rounded-[3px] border border-edge text-muted transition-colors duration-150 hover:border-mint/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-void"
          >
            <XIcon className="h-[18px] w-[18px]" />
          </a>
          ) : null}
          {PUMPFUN_URL ? (
          <a
            href={PUMPFUN_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Buy MOVING on Pump.fun"
            className="inline-flex items-center gap-2 rounded-[3px] border border-mint/50 bg-mint px-3.5 py-2 text-[10px] font-bold tracking-[0.12em] text-void shadow-[0_0_20px_rgba(0,229,160,0.13)] transition-all duration-150 hover:border-[#7BFFE0] hover:bg-[#7BFFE0] hover:shadow-[0_0_28px_rgba(0,229,160,0.24)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-void sm:px-4 sm:text-[11px]"
          >
            <Image src="/moving-mark.svg" alt="" aria-hidden="true" width={17} height={17} className="h-[17px] w-[17px]" />
            <span>BUY $MOVING</span>
            <span aria-hidden="true" className="ml-0.5 text-[15px] leading-none">↗</span>
          </a>
          ) : null}
        </div>
      </nav>
    </header>
  );
}

const STEPS = [
  { n: '01', title: 'Search', body: 'Enter a ticker, a coin name, or paste a contract address.' },
  { n: '02', title: 'Analyze', body: 'We pull live market data and compare price, volume and market cap against each other.' },
  { n: '03', title: 'Investigate', body: 'Get a plain explanation, then keep asking what changed and why.' }
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-5xl px-5 py-20 sm:px-6 sm:py-24" aria-labelledby="how-it-works">
      <h2 id="how-it-works" className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
        How it works
      </h2>
      <ol className="mt-8 grid gap-px bg-edge sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.n} className={`bg-void py-6 sm:py-2 ${index === 0 ? 'sm:pr-6' : 'sm:px-6'}`}>
            <span className="tnum text-[11.5px] tracking-[0.1em] text-mint/70">{step.n}</span>
            <h3 className="mt-3 text-[18px] font-medium tracking-tight text-ink">{step.title}</h3>
            <p className="mt-2 max-w-[38ch] text-[13.5px] leading-relaxed text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="border-y border-edge">
      <div className="mx-auto max-w-5xl px-5 py-20 text-center sm:px-6 sm:py-24">
        <p className="text-[24px] font-medium leading-[1.1] tracking-display text-faint sm:text-[34px]">
          Stop asking what happened.
        </p>
        <p className="mt-1 text-[32px] font-semibold leading-[1.1] tracking-display text-ink sm:text-[46px]">
          Start asking why.
        </p>
        <div className="mt-9 flex justify-center">
          <FocusSearchButton />
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="mx-auto max-w-5xl px-5 py-10 sm:px-6">
      <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
        <div className="space-y-1.5">
          <p className="tnum text-[11.5px] font-semibold tracking-[0.2em] text-muted">{APP.short}</p>
          <p className="max-w-readable text-[12px] leading-relaxed text-faint">
            Market data from CoinMarketCap and DexScreener. Not financial advice.
          </p>
        </div>
        {(SOCIAL_LINKS.x || PUMPFUN_URL) ? (
        <div className="flex items-center gap-4">
          {SOCIAL_LINKS.x ? (
          <a
            href={SOCIAL_LINKS.x}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="MOVING on X"
            title="X / Twitter"
            className="rounded-[3px] p-2 text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint"
          >
            <XIcon className="h-[18px] w-[18px]" />
          </a>
          ) : null}
          {PUMPFUN_URL ? (
          <a
            href={PUMPFUN_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-mint transition-colors hover:text-ink"
            aria-label="Buy MOVING on Pump.fun"
          >
            BUY $MOVING <span aria-hidden="true" className="text-[14px]">↗</span>
          </a>
          ) : null}
        </div>
        ) : null}
      </div>
    </footer>
  );
}
