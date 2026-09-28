import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const current = vi.hoisted(() => ({ locale: 'ja' as 'ja' | 'en' }));
vi.mock('next-intl/server', async () => {
  const jaMessages = (await import('../../messages/ja.json')).default;
  const enMessages = (await import('../../messages/en.json')).default;
  return {
    getLocale: async () => current.locale,
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: current.locale, messages: current.locale === 'ja' ? jaMessages : enMessages, namespace: namespace as 'Landing' }),
  };
});

import { LandingFaq } from '@/components/LandingFaq';
import { StructuredData } from '@/components/StructuredData';

type FaqPage = { '@type': string; mainEntity: { name: string; acceptedAnswer: { text: string } }[] };

describe('StructuredData (FAQPage)', () => {
  it.each(['ja', 'en'] as const)('%s: 画面に見えている FAQ と同じ Q&A を同じ順で出し、差し込み値とタグを残さない', async (locale) => {
    current.locale = locale;
    const { container: faq } = render(await LandingFaq());
    const visible = [...faq.querySelectorAll('details')].map((d) => ({
      q: d.querySelector('summary')?.textContent?.trim(),
      a: d.querySelector('p')?.textContent?.trim(),
    }));
    const { container } = render(await StructuredData());
    const faqPage = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent ?? '{}') as FaqPage)
      .find((v) => v['@type'] === 'FAQPage');
    expect(faqPage).toBeDefined();
    const structured = faqPage!.mainEntity.map((e) => ({ q: e.name, a: e.acceptedAnswer.text }));
    expect(structured).toEqual(visible);
    expect(structured).toHaveLength(7);
    for (const { q, a } of structured) {
      // 穴あきの料率 ({recoverPercent} など) や生のタグ (<jpycEx> など) を検索エンジン・AI に渡さない。
      expect(`${q} ${a}`).not.toMatch(/[{}<>]/);
    }
  });
});
