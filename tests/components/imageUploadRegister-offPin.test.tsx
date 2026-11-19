// 画像のアップロード PR 3B (レジの商品の画像・モバイル注文の店のアイコンとカバー) の「off のときは今の画面のまま」の網。
// 期待値の hash はすべて PR 3B の前の main (1c39b783) で採取したもの。採り直さない — hash が変わったら off の DOM が
// 変わったので、PR 3B の方を直す。固定するもの:
//   - レジの商品の編集 (ProductPresetManager): 画像のある行・ない行・追加のフォーム
//   - モバイル注文 (MobileOrderBuilder + 本物の StorefrontPublishPanel): 画像の欄・プレビュー・公開の状態カードと帯 2 つ
// /api/auth/siwe/me の imageUpload が無い (段階 off・未設定・取得の失敗) ときは、どちらも今の URL の欄のまま。
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { ProductPreset } from '@/hooks/useProductPresets';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const h = vi.hoisted(() => ({ signedIn: true }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, enableMobileOrder: true, enableHandles: true, enableShopLive: false, enableMenuOptions: false },
  };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: ADDR, isConnected: true }) }));
// 段階 off の /me (imageUpload・imageUploadSignIn が無い)。
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.signedIn,
    sessionAddress: h.signedIn ? ADDR : null,
    imageUpload: false,
    imageUploadSignIn: false,
    mismatch: false,
    isLoading: false,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
    refreshSession: vi.fn(),
  }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useResolveAddress', () => ({ useResolveAddress: () => ({ data: null }) }));
vi.mock('@/components/AddressInput', () => ({
  AddressInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="addr" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { ProductPresetManager } from '@/components/ProductPresetManager';
import { MobileOrderBuilder } from '@/components/MobileOrderBuilder';

/** useId の通し番号 (描画の順で変わる) を除いた DOM の hash。 */
function domHash(html: string): string {
  return createHash('sha256').update(html.replace(/:r[0-9a-z]+:/g, ':id:')).digest('hex');
}

function preset(over: Partial<ProductPreset>): ProductPreset {
  return {
    id: 'p1',
    name: 'コーヒー',
    unitPrice: '500',
    token: 'jpyc',
    taxRate: 10,
    taxCategory: 'taxable_10',
    memo: null,
    sortOrder: 0,
    enabled: true,
    ...over,
  };
}

beforeEach(() => {
  h.signedIn = true;
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('画像のアップロードが off のときのレジの商品の編集 (今の DOM のまま)', () => {
  it('画像のある行・ない行・追加のフォーム', () => {
    const fns = { addPreset: vi.fn(), updatePreset: vi.fn(), removePreset: vi.fn(), movePreset: vi.fn() };
    const presets = [
      preset({ id: 'a', image: 'https://images.example/coffee.png' }),
      preset({ id: 'b', name: 'Tシャツ', unitPrice: '3000', sortOrder: 1, category: '物販' }),
    ];
    const { container } = renderWithIntl(<ProductPresetManager presets={presets} {...fns} hydrated />);
    expect(domHash(container.innerHTML)).toBe('d25e5d916d790a97cfb0a8962846c9fa1957670d7b99f004911d3ad46d70563f');
  });

  it('サインインしていなくても段階 off なら今のまま', () => {
    h.signedIn = false;
    const fns = { addPreset: vi.fn(), updatePreset: vi.fn(), removePreset: vi.fn(), movePreset: vi.fn() };
    const { container } = renderWithIntl(
      <ProductPresetManager presets={[preset({ id: 'a', image: 'https://images.example/coffee.png' })]} {...fns} hydrated />,
    );
    expect(domHash(container.innerHTML)).toBe('8e4dfac236f623646f01c3c08ff22c054f2bbdb437926621a591a21e42782c6b');
  });
});

describe('画像のアップロードが off のときのモバイル注文 (今の DOM のまま)', () => {
  it('画像の欄・プレビュー・公開の状態カードと帯', async () => {
    window.localStorage.setItem(
      'openpay:product-presets:v1',
      JSON.stringify({
        presets: [{ id: 'm1', name: 'ブレンド', unitPrice: '500', token: 'jpyc', taxRate: 8, taxCategory: 'reduced_8', memo: null, image: 'https://images.example/menu.png', sortOrder: 0, enabled: true }],
        receipt: { day: '', n: 0 },
      }),
    );
    window.localStorage.setItem(
      'openpay:mobile-order-draft:v1',
      JSON.stringify({ shopName: 'Cafe', avatar: 'https://images.example/avatar.png', cover: 'https://images.example/cover.png' }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/handle') {
          return new Response(
            JSON.stringify({
              ok: true,
              max: 3,
              handles: [
                {
                  handle: 'cafe',
                  config: { to: ADDR, methods: [{ token: 'jpyc', chain: 'polygon' }] },
                  storefront: { chain: 'polygon', mode: 'storefront', feePayer: 'merchant', menu: [{ id: 'm1', name: 'ブレンド', price: '500' }] },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 500 });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = renderWithIntl(
      <QueryClientProvider client={qc}>
        <MobileOrderBuilder />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: '公開を更新' })).toHaveLength(2));
    expect(domHash(container.innerHTML)).toBe('df71cb4e0a368d80fa300ee90ab7077344e6f33698030580f5cad7fe007965fb');
  });
});
