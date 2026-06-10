// OG カード (1200x630) の共有描画層。/api/og/tip と /api/og/handle が同じ見た目を使う。
//
// デザイン: ダーク背景にアクセント色の発光 (radial-gradient) + 白パネル。パネル左に
// アバター (プロフ) かイニシャル円、右に見出し・@handle・bio・ピル (トークン/ガス不要)。
// 下段に実ブランドアイコン (public/icon-512.png を data URL 同梱) + OpenPay + URL。
// モデルは lib/ogTipCard の OgCardModel (純関数・単体テスト済) に正規化してから渡す。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToRgba, type OgCardModel } from '@/lib/ogTipCard';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// 日本語フォント (Noto Sans JP Bold・OFL-1.1)。任意の名前/bio を描くため同梱。
// 出力ファイルトレースは next.config.mjs の outputFileTracingIncludes で保証する。
const fontBuf = readFileSync(
  join(process.cwd(), 'app/api/og/fonts/NotoSansJP-Bold.ttf'),
);
export const OG_FONTS = [
  {
    name: 'NotoSansJP',
    data: fontBuf.buffer.slice(
      fontBuf.byteOffset,
      fontBuf.byteOffset + fontBuf.byteLength,
    ),
    weight: 700 as const,
    style: 'normal' as const,
  },
];

// ブランドアイコン (青の円環)。外部 fetch せず data URL で同梱する。
const iconBuf = readFileSync(join(process.cwd(), 'public/icon-512.png'));
const ICON_DATA_URL = `data:image/png;base64,${iconBuf.toString('base64')}`;

/**
 * 共有カードの JSX。avatarDataUrl があればアバター円、無ければアクセント円 + initial。
 * route 側は new ImageResponse(ogCardElement(model, avatar), { width: OG_WIDTH, ... }) する。
 */
export function ogCardElement(
  m: OgCardModel,
  avatarDataUrl?: string | null,
): React.ReactElement {
  const glowTop = hexToRgba(m.accent, 0.45);
  const glowBottom = hexToRgba(m.accent, 0.25);
  const chipBg = hexToRgba(m.accent, 0.14);
  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: 52,
        gap: 28,
        fontFamily: 'NotoSansJP',
        backgroundColor: '#0b1220',
        backgroundImage: `radial-gradient(circle at 88% -12%, ${glowTop} 0%, rgba(0,0,0,0) 52%), radial-gradient(circle at -8% 112%, ${glowBottom} 0%, rgba(0,0,0,0) 46%)`,
      }}
    >
      {/* 白パネル (主役) */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 56,
          backgroundColor: 'rgba(255,255,255,0.97)',
          borderRadius: 40,
          padding: '48px 64px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        {/* アバター / イニシャル円 */}
        {avatarDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarDataUrl}
            alt=""
            width={220}
            height={220}
            style={{
              width: 220,
              height: 220,
              borderRadius: 9999,
              objectFit: 'cover',
              border: `10px solid ${chipBg}`,
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 220,
              height: 220,
              borderRadius: 9999,
              backgroundColor: m.accent,
              color: '#ffffff',
              fontSize: m.initial.length > 1 ? 64 : 104,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {m.initial}
          </div>
        )}

        {/* 見出し列 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 68,
              fontWeight: 700,
              color: '#0f172a',
              lineHeight: 1.1,
            }}
          >
            {m.heading}
          </div>
          {m.handleLine && (
            <div
              style={{
                display: 'flex',
                fontSize: 34,
                fontWeight: 700,
                color: m.accent,
              }}
            >
              {m.handleLine}
            </div>
          )}
          {m.bio && (
            <div
              style={{
                display: 'flex',
                fontSize: 28,
                fontWeight: 700,
                color: '#475569',
              }}
            >
              {m.bio}
            </div>
          )}
          <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
            {m.chips.map((chip) => (
              <div
                key={chip}
                style={{
                  display: 'flex',
                  fontSize: 26,
                  fontWeight: 700,
                  color: m.accent,
                  backgroundColor: chipBg,
                  borderRadius: 9999,
                  padding: '10px 26px',
                }}
              >
                {chip}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 下段: ブランド + フッター/URL */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={ICON_DATA_URL}
            alt=""
            width={52}
            height={52}
            style={{ width: 52, height: 52, borderRadius: 14 }}
          />
          <div
            style={{
              display: 'flex',
              fontSize: 34,
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: -1,
            }}
          >
            {m.brand}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              fontWeight: 700,
              color: '#94a3b8',
            }}
          >
            {m.footer}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 28,
              fontWeight: 700,
              color: '#ffffff',
            }}
          >
            {m.url}
          </div>
        </div>
      </div>
    </div>
  );
}
