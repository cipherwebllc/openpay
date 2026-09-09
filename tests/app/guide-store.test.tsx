import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import GuideStorePage from '@/app/[locale]/guide/store/page';
import { licenseStoreGuideContentFor } from '@/lib/storeGuide';
import { DISCLOSED_LICENSE_NFT } from '@/lib/legal';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

const state = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableLicenseNftUi() { return state.enabled; } } };
});
vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

beforeEach(() => { state.enabled = false; });
describe('store guide license section', () => {
  it('OFF では既存ガイドだけを表示する', async () => {
    render(await GuideStorePage({ params: Promise.resolve({ locale: 'ja' }) }));
    expect(screen.queryByRole('heading', { name: '利用ライセンスを売る' })).not.toBeInTheDocument();
    expect(screen.queryByText(/createLicenseGate/)).not.toBeInTheDocument();
  });
  it.each(['ja', 'en'])('%s で SDK 0.7.1・商品 ID の組み込み例・verify とポリシーを表示する', async (locale) => {
    state.enabled = true;
    render(await GuideStorePage({ params: Promise.resolve({ locale }) }));
    const c = licenseStoreGuideContentFor(locale);
    expect(screen.getByRole('heading', { name: c.heading })).toBeInTheDocument();
    expect(screen.getByText(c.integration)).toHaveTextContent('SDK 0.7.1');
    const snippet = screen.getByText(/product: LICENSE_PRODUCT_ID/);
    expect(snippet).toHaveTextContent('secret: LICENSE_SESSION_SECRET');
    expect(snippet).toHaveTextContent('await entry.ready()');
    expect(snippet).not.toHaveTextContent('chainId:');
    expect(screen.getByText(c.entry)).toHaveTextContent('createLicenseGate');
    expect(screen.getByText(c.metered)).toHaveTextContent('createJpycGate');
    expect(screen.getByText(c.verifyCommand)).toHaveTextContent('https://open-pay.jp/api/license/verify');
    expect(c.policy).toContain(DISCLOSED_LICENSE_NFT.maxSupply.toLocaleString('en-US'));
    expect(c.policy).toContain(DISCLOSED_LICENSE_NFT.minPriceJpyc.toLocaleString('en-US'));
    expect(c.policy).toContain('Amoy');
    expect(c.fields).toMatch(/利用条件の版|terms version/);
    expect(c.verifyBody).toContain('null');
  });
  it('翻訳は指定 namespace に完全 parity で存在する', () => {
    const paths = (obj: Record<string, unknown>, prefix = ''): string[] => Object.entries(obj).flatMap(([key, value]) => typeof value === 'object' && value !== null ? paths(value as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`]).sort();
    for (const ns of ['CreatorStoreLicense', 'CreatorStoreSeller', 'CreatorStorePurchase', 'CreatorStoreLibrary'] as const) {
      expect(paths(ja[ns])).toEqual(paths(en[ns]));
    }
    expect(Object.keys(licenseStoreGuideContentFor('ja')).sort()).toEqual(Object.keys(licenseStoreGuideContentFor('en')).sort());
    expect(ja.CreatorStoreSeller.licenseTitleLabel).toBe('ライセンス名');
    expect(en.CreatorStoreSeller.licenseTitleLabel).toBe('License name');
    expect(ja.CreatorStorePurchase.licenseErrors.sold_out).toBe('完売しました');
  });
});
