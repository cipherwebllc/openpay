// トップ「使い方」の操作の短い動画 3 本 (2026-10-13 にいまの画面で撮り直して戻した)。
// 決済QR → レジ → お客様の支払い の順・手順のカードより前・ja/en とも出す (画面は日本語)。
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';
import { LandingHowItWorks } from '@/components/LandingHowItWorks';

const localeState = vi.hoisted(() => ({ value: 'ja' as 'ja' | 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => localeState.value,
  getTranslations: async () =>
    createTranslator({ locale: localeState.value, messages: localeState.value === 'en' ? en : ja, namespace: 'Landing' }),
}));
// 入口 4 枚は async の Server Component で、テストの描画では suspend する (tests/components/LandingEntryPoints.test.tsx が別に検査)。
vi.mock('@/components/LandingEntryPoints', () => ({ LandingEntryPoints: () => null }));

const SOURCES = ['/demo/lp-qr.mp4', '/demo/lp-register.mp4', '/demo/lp-pay.mp4'];

describe('LandingHowItWorks の操作の動画', () => {
  it('ja: 決済QR → レジ → お客様の支払い の 3 本が、手順のカードより前に出る', async () => {
    localeState.value = 'ja';
    const { container } = render(await LandingHowItWorks());
    expect([...container.querySelectorAll('source')].map((s) => s.getAttribute('src'))).toEqual(SOURCES);
    expect([...container.querySelectorAll('figcaption')].map((f) => f.firstChild?.textContent)).toEqual([
      ja.Landing.howItWorksDemoQr,
      ja.Landing.howItWorksDemoRegister,
      ja.Landing.howItWorksDemoPay,
    ]);
    const region = screen.getByRole('region', { name: ja.Landing.howItWorksDemoCaption });
    const merchantCard = screen.getByRole('heading', { level: 3, name: ja.Landing.howItWorksMerchantTitle });
    expect(region.compareDocumentPosition(merchantCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 支払いはサンプルのウォレットで撮ったことを画面に書く。
    expect(screen.getByText(ja.Landing.howItWorksDemoNote)).toBeInTheDocument();
  });

  it('en: 同じ 3 本を英語の見出しで出す', async () => {
    localeState.value = 'en';
    const { container } = render(await LandingHowItWorks());
    expect([...container.querySelectorAll('source')].map((s) => s.getAttribute('src'))).toEqual(SOURCES);
    expect(screen.getByRole('region', { name: en.Landing.howItWorksDemoCaption })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.Landing.howItWorksDemoPause })).toBeInTheDocument();
  });

  it('動画とポスターのファイルが public/demo にある', async () => {
    localeState.value = 'ja';
    const { container } = render(await LandingHowItWorks());
    const files = [
      ...[...container.querySelectorAll('source')].map((s) => s.getAttribute('src')!),
      ...[...container.querySelectorAll('video')].map((v) => v.getAttribute('poster')!),
    ];
    expect(files).toHaveLength(6);
    for (const f of files) expect(existsSync(join(process.cwd(), 'public', f))).toBe(true);
  });
});
