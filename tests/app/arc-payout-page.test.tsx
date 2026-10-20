// 「Arc の売上を受け取る」ページ: flag OFF (既定) では存在しない・検索に載せない・引き出す前の決まりを先に見せる。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import ja from '@/messages/ja.json';

const flags = vi.hoisted(() => ({ enableArcPayoutUi: false }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableArcPayoutUi() {
        return flags.enableArcPayoutUi;
      },
    },
  };
});

const notFoundSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
vi.mock('next/navigation', () => ({ notFound: notFoundSpy }));
vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async (namespace: keyof typeof ja) => {
    const messages = ja[namespace] as Record<string, string>;
    return (key: string) => messages[key] ?? key;
  },
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/components/arcPayout/ArcPayoutPanel', () => ({ ArcPayoutPanel: () => <div>panel-stub</div> }));

import ArcPayoutPage, { generateMetadata } from '@/app/[locale]/discovery/arc-payout/page';

const params = Promise.resolve({ locale: 'ja' });

beforeEach(() => {
  flags.enableArcPayoutUi = false;
  notFoundSpy.mockClear();
});

describe('/discovery/arc-payout', () => {
  it('flag OFF (既定) では notFound', async () => {
    await expect(ArcPayoutPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalled();
  });

  it('flag ON なら決まり (署名・手数料・ガス・精算待ち・10 分・コントラクト) を先に出してからパネルを出す', async () => {
    flags.enableArcPayoutUi = true;
    render(await ArcPayoutPage({ params }));
    expect(screen.getByRole('heading', { name: ja.ArcPayout.title })).toBeInTheDocument();
    for (const key of ['ruleSign', 'ruleFee', 'ruleGas', 'rulePending', 'ruleExpiry', 'ruleContract'] as const) {
      expect(screen.getByText(ja.ArcPayout[key])).toBeInTheDocument();
    }
    expect(screen.getByText('panel-stub')).toBeInTheDocument();
  });

  it('検索に載せない (noindex)', async () => {
    await expect(generateMetadata({ params })).resolves.toMatchObject({
      title: `${ja.ArcPayout.metaTitle} · OpenPay`,
      robots: { index: false, follow: false },
    });
  });
});
