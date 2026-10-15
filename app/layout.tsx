import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';

import './globals.css';
import { APP } from '@/lib/config';

const SITE_URL = 'https://www.whymoving.fun';

// Archivo's width axis is used as a design device: wide for the headline,
// narrow for data labels. Plex Mono is reserved for tickers and addresses.
const sans = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: '/' },
  title: 'Why is this coin moving?',
  description: APP.tagline,
  applicationName: APP.name,
  openGraph: {
    title: 'Why is this coin moving?',
    description: APP.tagline,
    siteName: APP.short,
    url: '/',
    type: 'website',
    images: [
      {
        url: '/moving-x-banner-1500x500.jpg',
        width: 1500,
        height: 500,
        alt: 'MOVING — Why is this coin moving?'
      }
    ]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Why is this coin moving?',
    description: APP.tagline,
    images: ['/moving-x-banner-1500x500.jpg']
  },
  robots: { index: true, follow: true }
};

export const viewport: Viewport = {
  themeColor: '#080C0D',
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a
          href="#coin-search"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-teal focus:px-3 focus:py-2 focus:text-void"
        >
          Skip to search
        </a>
        <div className="backdrop-glow" aria-hidden="true" />
        <div className="backdrop-grid" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
