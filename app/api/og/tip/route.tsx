// /tip/[address] の動的 OG 画像 (1200x630)。SNS (X / Discord / LINE) に tip リンクを
// 貼ったとき、受取人名・トークン・「ガス不要」・OpenPay ブランドのカードが表示される。
//
// 描画モデルは lib/ogTipCard (単体テスト済) に集約し、ここは next/og の ImageResponse を
// 呼ぶ薄い層に留める。任意の creator 名 (日本語) を描けるよう Noto Sans JP を同梱する。

import { ImageResponse } from 'next/og';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTipOgModel } from '@/lib/ogTipCard';

// fs でフォントを読むため Node runtime を明示 (edge はコードサイズ上限に当たる)。
export const runtime = 'nodejs';

const WIDTH = 1200;
const HEIGHT = 630;

// 日本語フォント (Noto Sans JP Bold・OFL-1.1)。任意の creator 名を描くため広い字面被覆を
// 持つ subset を 1 ウェイト同梱。出力ファイルトレースは next.config.mjs の
// outputFileTracingIncludes で保証する。Buffer をクリーンな ArrayBuffer に切り出す。
const fontBuf = readFileSync(
  join(process.cwd(), 'app/api/og/fonts/NotoSansJP-Bold.ttf'),
);
const FONT_DATA = fontBuf.buffer.slice(
  fontBuf.byteOffset,
  fontBuf.byteOffset + fontBuf.byteLength,
);

export function GET(req: Request): ImageResponse {
  const { searchParams } = new URL(req.url);
  const m = buildTipOgModel(searchParams);

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 80,
          color: '#ffffff',
          fontFamily: 'NotoSansJP',
          backgroundColor: '#0f172a',
          backgroundImage:
            'linear-gradient(135deg, #0f172a 0%, #064e3b 100%)',
        }}
      >
        {/* 上段: ブランド + TIP ピル (creator 色をアクセントに) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>
            {m.brand}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              fontWeight: 700,
              color: '#0b1220',
              backgroundColor: m.color,
              borderRadius: 9999,
              padding: '6px 22px',
            }}
          >
            TIP
          </div>
        </div>

        {/* 中段: 見出し + サブ (主役) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={{ display: 'flex', fontSize: 88, fontWeight: 700, lineHeight: 1.08 }}>
            {m.heading}
          </div>
          <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, color: '#cbd5e1' }}>
            {m.sub}
          </div>
        </div>

        {/* 下段: フッター + URL (creator 色) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', fontSize: 32, fontWeight: 700, color: '#e2e8f0' }}>
            {m.footer}
          </div>
          <div style={{ display: 'flex', fontSize: 36, fontWeight: 700, color: m.color }}>
            {m.url}
          </div>
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: [
        { name: 'NotoSansJP', data: FONT_DATA, weight: 700, style: 'normal' },
      ],
      headers: {
        // 同一 URL は不変画像。CDN / SNS クローラ向けに長期キャッシュ。
        'cache-control': 'public, max-age=86400, s-maxage=86400, immutable',
      },
    },
  );
}
