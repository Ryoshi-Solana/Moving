import { AnalyzePanel } from '@/components/AnalyzePanel';
import { ExampleAnalysis } from '@/components/ExampleAnalysis';
import { FinalCta, Footer, HowItWorks, Navbar } from '@/components/Chrome';
import { APP } from '@/lib/config';

export default function HomePage() {
  return (
    <>
      <Navbar />

      <main>
        <section className="mx-auto max-w-5xl px-5 pb-16 pt-14 sm:px-6 sm:pb-20 sm:pt-24">
          {/* Small credibility line above the headline — the first thing a
              crypto-native reader checks is where the data comes from. */}
          <div className="flex items-center gap-2.5">
            <span aria-hidden="true" className="h-[5px] w-[5px] animate-breathe bg-mint" />
            <span className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-faint">
              Live market data · CoinMarketCap
            </span>
          </div>

          <h1 className="mt-6 max-w-[15ch] text-[42px] font-semibold leading-[0.98] tracking-display text-ink sm:text-[72px] lg:text-[80px]">
            Why is this coin <span className="text-mint">moving</span>?
          </h1>
          <p className="mt-6 max-w-readable text-[16px] leading-relaxed text-muted sm:mt-7 sm:text-[18px]">
            {APP.tagline}
          </p>

          <div className="mt-10 sm:mt-11">
            <AnalyzePanel example={<ExampleAnalysis />} />
          </div>
        </section>

        <HowItWorks />
        <FinalCta />
      </main>

      <Footer />
    </>
  );
}
