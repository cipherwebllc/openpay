// /tip/[address] の動的 OG 画像 (1200x630)。SNS (X / Discord / LINE) に tip リンクを
// 貼ったとき、受取人名・トークン・「ガス不要」・OpenPay ブランドのカードが表示される。
//
// 描画モデルは lib/ogTipCard (単体テスト済) に集約し、見た目は app/api/og/_card の
// 共有カード (プロフカードと同一デザイン) を使う。ここは配線だけの薄い層。

import { ImageResponse } from 'next/og';
import { buildTipOgModel, tipModelToCard } from '@/lib/ogTipCard';
import { ogCardElement, OG_FONTS, OG_WIDTH, OG_HEIGHT } from '../_card';

// fs でフォントを読むため Node runtime を明示 (edge はコードサイズ上限に当たる)。
export const runtime = 'nodejs';

export function GET(req: Request): ImageResponse {
  const { searchParams } = new URL(req.url);
  const card = tipModelToCard(buildTipOgModel(searchParams));

  return new ImageResponse(ogCardElement(card), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: OG_FONTS,
    headers: {
      // 同一 URL は不変画像。CDN / SNS クローラ向けに長期キャッシュ。
      'cache-control': 'public, max-age=86400, s-maxage=86400, immutable',
    },
  });
}
