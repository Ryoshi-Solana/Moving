import type { Metadata, Viewport } from 'next';

import './globals.css';
import { APP } from '@/lib/config';

export const metadata: Metadata = {
  title: 'Why is this coin moving?',
  description: APP.tagline,
  applicationName: APP.name,
  openGraph: {
    title: 'Why is this coin moving?',
    description: APP.tagline,
    siteName: APP.short,
    type: 'website'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Why is this coin moving?',
    description: APP.tagline
  },
  robots: { index: true, follow: true }
};

export const viewport: Viewport = {
  // Matches the site's actual background (deep navy), so the mobile browser
  // chrome doesn't show a mismatched near-black band above the page.
  themeColor: '#0A121C',
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="backdrop-glow" aria-hidden="true" />
        <div className="backdrop-grid" aria-hidden="true" />
        <div className="backdrop-noise" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
