import { describe, expect, it } from 'vitest';
import { mobileOrderGuideMetadata } from '@/lib/mobileOrderGuide';

describe('mobile-order guide fee disclosure in social previews', () => {
  it.each(['ja', 'en'])('%s: uses the mobile-order image instead of the generic image with a 0% claim', (locale) => {
    const metadata = mobileOrderGuideMetadata(locale);
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({
        url: '/og-image-mobileorder.webp',
        width: 1280,
        height: 670,
      }),
    ]);
    expect(metadata.twitter).toMatchObject({
      images: ['/og-image-mobileorder.webp'],
    });
  });
});
