// 【開発専用】/@fixture プロフィールの UI 磨き・スクショ検証用フィクスチャ
// (plans/store-showcase-polish.md P2)。利用側 (app/[locale]/[handle]/page.tsx) は
// `!process.env.VERCEL && STORE_DEV_FIXTURES==='1' && handle==='fixture'` の
// 三重ガード — 偽プロフ/偽商品が本番に出る波及を構造的に断つ。
// owner/payTo は hardhat/anvil 既知テストアカウント #0 (dev mock wallet と同一)。

import type { Address } from 'viem';
import type { HandleRecord } from '@/lib/handle';
import type { HostedProduct } from '@/lib/x402/hostedStore';

const DEV_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

export const DEV_FIXTURE_HANDLE_RECORD: HandleRecord = {
  owner: DEV_ADDR,
  config: {
    to: DEV_ADDR,
    name: 'Fixture Studio',
    methods: [{ token: 'jpyc', chain: 'polygon' }],
  },
  profile: {
    bio: '3D 素材と BGM を作っています (dev フィクスチャ)',
    links: [{ label: 'Portfolio', url: 'https://example.com' }],
  },
  createdAt: 1754300000000,
  updatedAt: 1754300000000,
} as HandleRecord;

function fx(
  n: number,
  over: Partial<HostedProduct> & Pick<HostedProduct, 'title' | 'priceJpyc'>,
): HostedProduct {
  return {
    id: `h_${'e'.repeat(30)}${String(n).padStart(2, '0')}`,
    owner: DEV_ADDR,
    payTo: DEV_ADDR,
    contentKind: 'url',
    label: 'download',
    contentRevision: 1,
    saleActive: true,
    contentAvailable: true,
    createdAt: 1754300000000 + n,
    ...over,
  };
}

export const DEV_FIXTURE_HOSTED_PRODUCTS: HostedProduct[] = [
  fx(1, {
    title: 'ローポリ カフェ内装キット',
    priceJpyc: '4950',
    imageUrl: '/landing/usecase-digital-goods.avif',
    desc: 'GLTF 3D モデル (.glb) ▼プレビュー https://example.com/preview/1406f421-46e5-4c9d-b715-323f50f0b325 商用利用可・クレジット不要です。',
    category: '3d-game',
    tags: ['GLB', 'Unity'],
    // featured 厳選の再現用 (これ以外の 3 商品はプロフで隠れる = ディープリンク検証)。
    featured: true,
    // USDC 購入 UI (P2) の dev 検証用: 支払い方法選択が出る側の代表。
    usdcEnabled: true,
  }),
  fx(2, {
    title: '和風ジングル素材集 vol.2',
    priceJpyc: '980',
    imageUrl: '/landing/usecase-creator-tip.avif',
    desc: 'ループ対応の BGM 10 曲入り。',
    category: 'music',
  }),
  fx(3, {
    title: 'AI プロンプト 100 選',
    priceJpyc: '480',
    emoji: '🧠',
    contentKind: 'text',
    label: 'prompt',
    desc: '仕事で使えるテンプレート集。購入後すぐテキストで届きます。',
    category: 'ai',
  }),
  fx(4, {
    title: 'イベント出店チェックリスト (PDF)',
    priceJpyc: '300',
    imageUrl: '/landing/usecase-store-event.avif',
    label: 'pdf',
    category: 'documents',
  }),
];
