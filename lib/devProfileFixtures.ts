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
    cover: '/landing/usecase-digital-goods.avif',
    bio: '3D 素材と BGM を作っています (dev フィクスチャ)',
    font: 'rounded',
    linkLayout: 'grid',
    links: [{ label: 'Portfolio', url: 'https://example.com' }, { label: 'Blog', url: 'https://example.com/blog' }],
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
    // 商品詳細 P1 (plans/store-product-detail.md) の表示検証用: 長文・仕様表・「実際に試す」。
    details:
      'カフェの内装一式をローポリで揃えた GLB キットです。\n\n【内容物】カウンター、テーブル 3 種、椅子 4 種、照明 2 種、観葉植物、メニューボード。すべて 1 ファイルにまとめた版と、パーツごとに分けた版の両方が入っています。\n\n【使い方】Hyperfy / Three.js / Unity にそのまま読み込めます。原点は床面の中央、単位はメートルです。',
    specs: [
      { label: '形式', value: 'GLB (glTF 2.0)' },
      { label: 'ファイルサイズ', value: '12.4 MB' },
      { label: 'ポリゴン数', value: '約 18,000 tris (一式)' },
      { label: 'テクスチャ', value: '2K PBR (BaseColor / Normal / ORM)' },
      { label: '対応', value: 'Hyperfy・Three.js・Unity・Blender' },
    ],
    demoUrl: 'https://example.com/world/cafe-kit',
    // 利用条件 (plans/store-usage-terms.md) の表示検証用: 可・不可・記載なし (選ばなかった項目) の 3 つと補足。
    usage: { commercial: 'allowed', redistribute: 'not_allowed', note: 'クレジット表記は不要です。' },
    // featured 厳選の再現用 (1〜4 の 4 商品を厳選・5・6 はプロフで隠れる = ディープリンク検証)。
    // 2 つ以上なので PC ではプロフが 2 列 (左にプロフィールと応援・右に商品)。4 つで商品の列が左の列より
    // 長くなる (e2e/prodflags/handle-profile-layout.spec.ts が位置を測る前提)。
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
    featured: true,
  }),
  fx(3, {
    title: 'AI プロンプト 100 選',
    priceJpyc: '480',
    emoji: '🧠',
    contentKind: 'text',
    label: 'prompt',
    desc: '仕事で使えるテンプレート集。購入後すぐテキストで届きます。',
    category: 'ai',
    featured: true,
  }),
  fx(4, {
    title: 'イベント出店チェックリスト (PDF)',
    priceJpyc: '300',
    imageUrl: '/landing/usecase-store-event.avif',
    label: 'pdf',
    category: 'documents',
    featured: true,
  }),
  // 厳選から外れてプロフでは隠れる商品 (?product= のディープリンクで商品ページとして出る)。
  fx(5, {
    title: 'ローポリ 観葉植物セット',
    priceJpyc: '600',
    emoji: '🌿',
    desc: '鉢植え 8 種の 3D モデル (.glb)。',
    category: '3d-game',
  }),
  fx(6, {
    title: '効果音パック (SE 50 種)',
    priceJpyc: '400',
    emoji: '🔊',
    label: 'zip',
    category: 'music',
  }),
];
