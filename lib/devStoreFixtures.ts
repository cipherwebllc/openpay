// 【開発専用】/store の UI 磨き・スクショ検証用フィクスチャ (plans/store-showcase-polish.md)。
// 利用側 (app/[locale]/store/page.tsx) は `!process.env.VERCEL &&
// STORE_DEV_FIXTURES==='1'` の二重ガード (dev mock wallet #327 と同型) — 偽の商品が
// 本番一覧に出る波及を構造的に断つ。画像は public/ 同梱アセットのみ (外部依存なし)。

import type { StoreListing } from '@/lib/x402/storeListing';

function fx(
  n: number,
  over: Partial<StoreListing> & Pick<StoreListing, 'title' | 'priceJpyc'>,
): StoreListing {
  const price = Number(over.priceJpyc);
  const fee = Math.max(1, Math.round(price * 0.01 * 100) / 100);
  return {
    id: `h_${'f'.repeat(30)}${String(n).padStart(2, '0')}`,
    label: 'download',
    handle: 'fixture',
    updatedAt: 1754300000000 + n,
    totalJpyc: String(price + fee),
    feeJpyc: String(fee),
    ...over,
  };
}

export const STORE_DEV_FIXTURE_LISTINGS: readonly StoreListing[] = [
  fx(1, {
    title: 'ローポリ カフェ内装キット',
    priceJpyc: '4950',
    imageUrl: '/landing/usecase-digital-goods.avif',
    category: 'threed',
    tags: ['GLB', 'Unity'],
    desc: 'GLTF 3D モデル (.glb)。商用利用可。',
  }),
  fx(2, {
    title: '和風ジングル素材集 vol.2',
    priceJpyc: '980',
    imageUrl: '/landing/usecase-creator-tip.avif',
    category: 'music',
    tags: ['BGM'],
  }),
  fx(3, {
    title: 'AI プロンプト 100 選',
    priceJpyc: '480',
    emoji: '🧠',
    category: 'ai',
    label: 'prompt',
  }),
  fx(4, {
    title: 'イベント出店チェックリスト (PDF)',
    priceJpyc: '300',
    imageUrl: '/landing/usecase-store-event.avif',
    category: 'documents',
  }),
  fx(5, {
    title: 'ポップアップ店舗の看板テンプレート',
    priceJpyc: '1200',
    imageUrl: '/landing/usecase-popup-payment.avif',
    category: 'templates',
  }),
  fx(6, {
    title: 'Web3 コミュニティ運営ノート',
    priceJpyc: '800',
    imageUrl: '/landing/usecase-web3-event.avif',
    category: 'documents',
  }),
  fx(7, {
    title: 'JPYC 決済導入 API サンプル',
    priceJpyc: '2000',
    emoji: '🔌',
    category: 'software',
    label: 'api',
  }),
  fx(8, {
    title: 'とても長いタイトルの商品名がカードでどう省略されるかを確認するための商品',
    priceJpyc: '150',
    imageUrl: '/landing/usecase-ai-api.avif',
    category: 'images',
  }),
];
