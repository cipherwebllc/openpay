import { describe, expect, it } from 'vitest';
import { mobileOrderGuideContentFor, mobileOrderGuideMetadata } from '@/lib/mobileOrderGuide';
import { DISCLOSED_MOBILE_ORDER_FEE } from '@/lib/legal';

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

describe('mobile-order guide FAQ: fees and gas', () => {
  it.each(['ja', 'en'])('%s: ガス代なし・事前注文の利用料が合計に含まれうることを、開示定数の率で答える', (locale) => {
    const faq = mobileOrderGuideContentFor(locale).faq;
    const entry = faq.find((f) => (locale === 'ja' ? f.q.includes('ガス代') : f.q.includes('gas')));
    expect(entry).toBeDefined();
    const pct = `${DISCLOSED_MOBILE_ORDER_FEE.preorderBps / 100}%`;
    expect(entry!.a).toContain(pct);
    // 「かかりません」の言い切り (料金ページの事前注文の上乗せと矛盾する) に戻さない。
    expect(entry!.a).not.toBe(locale === 'ja' ? 'かかりません。表示された金額だけを支払います。' : 'No. You pay exactly the amount displayed.');
  });
});
