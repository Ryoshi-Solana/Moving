import type { MetadataRoute } from 'next';

const SITE_URL = 'https://moving-crypto.vercel.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/']
    },
    sitemap: `${SITE_URL}/sitemap.xml`
  };
}
