// 料金ページ (/pricing) に数字の直書きが無いことのフェンス (plans/pricing-page.md §7.1 ②)。
// tests/components/LandingFeeDisclosure.test.tsx と同じ型: @/lib/legal の正本を別の値に差し替えて描き、
// 差し替えた値 (と、同じ式で出した計算例) が出て、今の値が出ないことを確かめる。実際の料金は変えない。
//
// disclosedStoreGasChains は自分のモジュールの DISCLOSED_STORE_GAS_WALLET を読むので、チェーン名を
// 差し替えて確かめるには関数ごと差し替える (計画レビュー R4)。

import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import PricingPage from '@/app/[locale]/pricing/page';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/lib/legal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/legal')>();
  return {
    ...actual,
    DISCLOSED_RECOVER_FEE: { floorJpyc: 5, percentFromJulyBps: 170 },
    DISCLOSED_MOBILE_ORDER_FEE: { storefrontBps: 200, preorderBps: 400 },
    DISCLOSED_X402_FEE: { bps: 150, floorJpyc: 3 },
    DISCLOSED_TIP_FEE_MODELS: { ...actual.DISCLOSED_TIP_FEE_MODELS, jpycRelay: { floorJpyc: 4 } },
    DISCLOSED_STORE_GAS_WALLET: { ...actual.DISCLOSED_STORE_GAS_WALLET, feeWei: 7 },
    disclosedStoreGasChains: (locale: 'ja' | 'en') => (locale === 'ja' ? 'ChainA・ChainB' : 'ChainA and ChainB'),
    DISCLOSED_STORE_USDC_PAYMENT: { ...actual.DISCLOSED_STORE_USDC_PAYMENT, chainName: 'StoreChain' },
    DISCLOSED_DUAL_RAIL_USDC: { ...actual.DISCLOSED_DUAL_RAIL_USDC, chainName: 'DualChain', arcChainName: 'DualArcChain' },
    DISCLOSED_CCTP_FEE: { ...actual.DISCLOSED_CCTP_FEE, maxFeeBps: 25, minMaxFeeAtomic: 5_000 },
  };
});

// 差し替えた値から、ページと同じ式 (床除算・max(最低額, 額×bps/10000)) で出した計算例。
// 100 JPYC の 1.7% = 1.7 < 5 → 最低額 5 / 受け取り 95。1,000 → 17 / 983。10,000 → 170 / 9,830。
// モバイル注文 2% / 4%: 100 → 2 / 4・1,000 → 20 / 40・10,000 → 200 / 400。事前注文の上乗せ 1,040 / 1,000・お店払い 1,000 / 960。
// x402 1.5%・最低 3: 50 → 0.75 < 3 → 3 / 53。1,000 → 15 / 1,015。10,000 → 150 / 10,150。
// 計算機は 1,000 JPYC で描かれる (差し替えた料率: ガスレス 1.7%・最低 5 / 店内 2%・事前 4% / x402 1.5%・最低 3)。
//   ガスレス 1,000 − 17 = 983・店内 1,000 − 20 = 980・事前 1,000 − 40 = 960 (お客様の上乗せ 1,040)・デジタル 1,000 + 15 = 1,015
const EXPECTED = {
  ja: [
    '1.7%',
    '最低 5 JPYC',
    '2%',
    '事前注文は 4%',
    '1.5%',
    '最低 3 JPYC',
    '約 4 JPYC',
    '7 wei',
    '0.000000000000000007 JPYC',
    'ChainA・ChainB',
    'StoreChain',
    'DualChain',
    'DualArcChain',
    '983',
    '980',
    '960',
    '1,040',
    '1,015',
    'ガスレス決済の利用料は、1.7% が 5 JPYC に満たないときは 5 JPYC です（例: 100 JPYC の 1.7% は 1.7 JPYC）。5 JPYC 以下は、ガスレス決済を使えません。',
    '上限は金額の 0.25%。2 USDC 未満の支払いでは 0.005 USDC',
  ],
  en: [
    '1.7%',
    'minimum 5 JPYC',
    '1.5%',
    'minimum 3 JPYC',
    'about 4 JPYC',
    '7 wei',
    'ChainA and ChainB',
    'StoreChain',
    'DualChain',
    'DualArcChain',
    '983',
    '1,040',
    '1,015',
    'The gasless fee is 5 JPYC when 1.7% comes to less than that (e.g. 1.7% of 100 JPYC is 1.7 JPYC). Gasless payments are not available for 5 JPYC or less.',
    'capped at 0.25% of the amount, or 0.005 USDC for payments under 2 USDC',
  ],
} as const;

const CURRENT = {
  ja: ['最低 2 JPYC', '最低 1 JPYC', '約 2 JPYC', '1 wei', 'Polygon', '990', '1,030', '1,010', '0.1%', '0.001 USDC', '1 USDC 未満'],
  en: ['minimum 2 JPYC', 'minimum 1 JPYC', 'about 2 JPYC', '1 wei', 'Polygon', '990', '1,030', '1,010', '0.1%', '0.001 USDC', 'under 1 USDC'],
} as const;

describe.each(['ja', 'en'] as const)('%s: 正本を差し替えると料金ページの数字が全部追従する', (locale) => {
  it('差し替えた値が出て、今の値と補間の漏れが無い', async () => {
    const { container } = render(await PricingPage({ params: Promise.resolve({ locale }) }));
    const text = container.textContent ?? '';
    for (const expected of EXPECTED[locale]) expect(text, expected).toContain(expected);
    for (const current of CURRENT[locale]) expect(text, current).not.toContain(current);
    // 1% / 3% (今の料率) が単独で残っていない (1.7% や 1.5% の一部は除く)。
    expect(text).not.toMatch(/(?<![\d.])[13]%/);
    expect(text).not.toMatch(/[{}]|undefined|NaN/);
  });
});
