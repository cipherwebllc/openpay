// @handle ページ (app/[locale]/[handle]/page) の generateMetadata を実行して検証する。
// storefront 公開時はモバイルオーダー meta、非公開/flag OFF はプロフ (link-in-bio) meta に
// 分岐する。分岐条件はページ本体の MobileOrderView ゲートと同一式なので、ここがズレると
// カードと本体が食い違う (それを防ぐ回帰)。env / resolveHandle をモックする。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  enableHandles: true,
  enableMobileOrder: false,
  record: null as unknown,
  ok: true,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return h.enableHandles;
      },
      get enableMobileOrder() {
        return h.enableMobileOrder;
      },
    },
  };
});
vi.mock('@/lib/handleStore', () => ({
  resolveHandle: vi.fn(async () => (h.ok ? { ok: true, record: h.record } : { ok: false })),
}));

import { generateMetadata } from '@/app/[locale]/[handle]/page';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const PROFILE_RECORD = {
  owner: ADDR,
  config: { to: ADDR, name: '山田太郎', methods: [{ token: 'jpyc', chain: 'polygon' }] },
  profile: { bio: 'Web3 クリエイター' },
  createdAt: 1,
  updatedAt: 2,
};
const STORE_RECORD = {
  owner: ADDR,
  config: { to: ADDR, name: '山田太郎', methods: [{ token: 'jpyc', chain: 'polygon' }] },
  profile: {},
  storefront: {
    chain: 'polygon',
    mode: 'storefront',
    feePayer: 'merchant',
    shopName: '山田カフェ',
    tagline: 'こだわり珈琲',
    menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
  },
  createdAt: 1,
  updatedAt: 2,
};

// Next は dynamic param を %40 で渡す (page が decodeHandleSegment する)。
const call = (rawHandle: string, locale = 'ja') =>
  generateMetadata({ params: Promise.resolve({ locale, handle: rawHandle }) });

beforeEach(() => {
  h.enableHandles = true;
  h.enableMobileOrder = false;
  h.ok = true;
  h.record = PROFILE_RECORD;
});

describe('@handle generateMetadata', () => {
  it('storefront 公開 (enableMobileOrder ON) はモバイルオーダー meta', async () => {
    h.enableMobileOrder = true;
    h.record = STORE_RECORD;
    const m = await call('%40yamada');
    expect(m.title).toBe('山田カフェ のモバイルオーダー — OpenPay');
    expect(String(m.description)).toContain('JPYC');
    // OG/Twitter 画像が付く (/api/og/handle)。
    expect(JSON.stringify(m.twitter)).toContain('summary_large_image');
    expect(JSON.stringify(m.openGraph?.images)).toContain('/api/og/handle');
  });

  it('storefront あっても enableMobileOrder OFF はプロフ meta (本体ゲートと一致)', async () => {
    h.enableMobileOrder = false;
    h.record = STORE_RECORD;
    const m = await call('%40yamada');
    expect(String(m.title)).toContain('山田太郎');
    expect(String(m.title)).not.toContain('モバイルオーダー');
  });

  it('プロフのみ (storefront 無し) はプロフ meta + bio description', async () => {
    h.record = PROFILE_RECORD;
    const m = await call('%40masia');
    expect(m.title).toBe('山田太郎 (@masia) — OpenPay');
    expect(String(m.description)).toContain('Web3 クリエイター');
  });

  it('flag OFF は素の OpenPay meta (KV を読まない)', async () => {
    h.enableHandles = false;
    const m = await call('%40masia');
    expect(m.title).toBe('OpenPay');
  });
});
