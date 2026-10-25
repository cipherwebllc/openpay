// トップと同じ <title> になっていた 10 ページ (layout.tsx の generateMetadata) の title / robots のフェンス。
import { describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { routeMetadata } from '@/lib/routeMetadata';

const MESSAGES = { ja, en } as const;

vi.mock('next-intl/server', () => ({
  getTranslations: async ({ locale, namespace }: { locale: 'ja' | 'en'; namespace: string }) => {
    const ns = (MESSAGES[locale] as unknown as Record<string, Record<string, string>>)[namespace];
    return (key: string) => ns[key];
  },
}));

describe('routeMetadata', () => {
  it('title は「ページ名 | OpenPay」でトップの総合 title とは別 (ja / en)', async () => {
    const home = { ja: ja.Meta.title, en: en.Meta.title };
    for (const locale of ['ja', 'en'] as const) {
      const meta = await routeMetadata({ locale, path: '/terms', name: { namespace: 'Terms', key: 'title' } });
      expect(meta.title).toBe(`${MESSAGES[locale].Terms.title} | OpenPay`);
      expect(meta.title).not.toBe(home[locale]);
      expect(meta.alternates?.canonical).toBe(`/${locale}/terms`);
      expect(meta.robots).toBeUndefined();
    }
  });

  it('固定名 (messages に無い名前) も ja / en で出る', async () => {
    const name = { ja: '見本', en: 'Example' };
    expect((await routeMetadata({ locale: 'ja', path: '/example', name })).title).toBe('見本 | OpenPay');
    expect((await routeMetadata({ locale: 'en', path: '/example', name })).title).toBe('Example | OpenPay');
  });

  it('noindex の画面 (pay / orders) は robots を noindex にし、canonical を付けない', async () => {
    const meta = await routeMetadata({
      locale: 'ja',
      path: '/orders/kitchen',
      name: { namespace: 'OrderFulfillment', key: 'kitchenTitle' },
      noindex: true,
    });
    expect(meta.title).toBe('厨房モニター | OpenPay');
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.alternates).toBeUndefined();
  });

  it('10 ページの layout が参照する messages のキーが ja / en に実在する', () => {
    const refs: [string, string][] = [
      ['Tokutei', 'title'], ['Privacy', 'title'], ['Disclaimer', 'title'], ['Terms', 'title'],
      ['Nav', 'pay'], ['Scan', 'pageTitle'], ['OrderPickupMonitor', 'title'],
      ['OrderFulfillment', 'kitchenTitle'], ['OrderFulfillment', 'hallTitle'],
    ];
    for (const locale of ['ja', 'en'] as const) {
      for (const [ns, key] of refs) {
        const value = (MESSAGES[locale] as unknown as Record<string, Record<string, string>>)[ns]?.[key];
        expect(value, `${locale} ${ns}.${key}`).toBeTruthy();
      }
    }
  });
});
