import type { MetadataRoute } from 'next';

const SITE_URL = 'https://www.whymoving.fun';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      changeFrequency: 'daily',
      priority: 1
    }
  ];
}
