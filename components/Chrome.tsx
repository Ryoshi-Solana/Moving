import { APP, SOCIAL_LINKS } from '@/lib/config';
import { TelegramIcon, XIcon } from '@/components/icons';
import { FocusSearchButton } from '@/components/FocusSearchButton';

export function Navbar() {
  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-void/85 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-6">
        <a href="/" className="group flex items-center gap-2.5" aria-label={`${APP.name} home`}>
          <span className="h-[9px] w-[9px] bg-mint shadow-[0_0_12px_rgba(0,229,160,0.55)]" />
          <span className="tnum text-[12.5px] font-semibold tracking-[0.2em] text-ink">{APP.short}</span>
        </a>
        <SocialLinks />
      </nav>
    </header>
  );
}

export function SocialLinks({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      <a
        href={SOCIAL_LINKS.telegram}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Telegram"
        className="rounded-[2px] p-2 text-faint transition-colors duration-150 hover:text-ink"
      >
        <TelegramIcon className="h-[20px] w-[20px]" />
      </a>
      <a
        href={SOCIAL_LINKS.x}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="X"
        className="rounded-[2px] p-2 text-faint transition-colors duration-150 hover:text-ink"
      >
        <XIcon className="h-[20px] w-[20px]" />
      </a>
    </div>
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
            Market data from CoinMarketCap. Not financial advice.
          </p>
        </div>
        <SocialLinks className="-mx-2" />
      </div>
    </footer>
  );
}
