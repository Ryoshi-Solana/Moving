import { FinalCta, Footer, Method, Navbar } from '@/components/Chrome';
import { TrendingTicker } from '@/components/TrendingTicker';
import { Workspace } from '@/components/Workspace';

export default function HomePage() {
  return (
    <>
      <Navbar />
      <TrendingTicker />
      <main>
        <Workspace />
        <Method />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
