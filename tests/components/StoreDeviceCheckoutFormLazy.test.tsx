// 「お店の端末で送る」の画面は submit=store の /checkout を開いたときだけ読み込む (components/checkout/StoreDeviceCheckoutFormLazy.tsx)。
// 通常の /checkout の First Load JS に載せないため、page は画面を静的に import しない (bundle 予算)。

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import type { CheckoutParams } from '@/lib/url';

const rendered = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/StoreDeviceCheckoutForm', () => ({
  StoreDeviceCheckoutForm: ({ params }: { params: CheckoutParams }) => {
    rendered.push(params);
    return <p>store-device:{params.handoffId}</p>;
  },
}));

import { StoreDeviceCheckoutFormLazy } from '@/components/checkout/StoreDeviceCheckoutFormLazy';

const params: CheckoutParams = {
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  mode: 'gasless',
  items: [{ name: 'カフェラテ', qty: 1, price: '550' }],
  submit: 'store',
  handoffId: 'AbCdEfGhIjKlMnOpQrStUv',
};

describe('StoreDeviceCheckoutFormLazy', () => {
  it('読み込んだ画面に params をそのまま渡す', async () => {
    render(<StoreDeviceCheckoutFormLazy params={params} />);
    expect(await screen.findByText('store-device:AbCdEfGhIjKlMnOpQrStUv')).toBeInTheDocument();
    expect(rendered.at(-1)).toBe(params);
  });

  it('/checkout の page は、お店の端末で送るの画面を静的に import せず、遅延の入口を submit=store のときに描く', () => {
    const page = readFileSync(path.join(process.cwd(), 'app/[locale]/checkout/page.tsx'), 'utf8');
    expect(page).not.toMatch(/from '@\/components\/StoreDeviceCheckoutForm'/);
    expect(page).toContain("from '@/components/checkout/StoreDeviceCheckoutFormLazy'");
    expect(page).toMatch(/submit === 'store' \? \(\s*<StoreDeviceCheckoutFormLazy params=\{parsed\.params\} \/>/);
  });
});
