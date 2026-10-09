import type { Metadata, Viewport } from 'next';

import './globals.css';
import { APP } from '@/lib/config';

const SITE_URL = 'https://moving-crypto.vercel.app';

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
