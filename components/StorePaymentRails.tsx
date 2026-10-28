import { useTranslations } from 'next-intl';

// Store の商品の支払い方法の表記 (Store 一覧・プロフの商品カード・商品ページで共通)。
// 「4,999.5 JPYC (Polygon) · USDC でも購入可」の形で、JPYC の価格には Polygon のロゴ、USDC には Base のロゴを添える
// (「JPYC · Polygon +USDC」だと Polygon の USDC と読める・2026-10-28 user 指示)。
// ロゴは装飾 (alt="")。チェーン名は可視の「Polygon」と、読み上げ用の「（Base）」(sr-only) で伝える (掟 8)。

/** 価格の直後に置く「(◇Polygon)」。文字の大きさと色は親から受ける。 */
export function JpycPolygonTag({ className = '' }: { className?: string }) {
  return (
    <span className={`whitespace-nowrap ${className}`}>
      (
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/chains/polygon.svg" alt="" aria-hidden className="mr-0.5 inline h-[1.1em] w-[1.1em] align-[-0.2em]" />
      Polygon)
    </span>
  );
}

/** USDC 可の商品だけに添える「▣ USDC でも購入可」(Base のロゴ)。 */
export function UsdcAlsoNote({ className = '' }: { className?: string }) {
  const t = useTranslations('CreatorStorefront');
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/chains/base.svg" alt="" aria-hidden className="h-[1.1em] w-[1.1em] shrink-0 rounded-[3px]" />
      <span>
        {t.rich('usdcAlso', {
          chain: (chunks) => <span className="sr-only">{chunks}</span>,
        })}
      </span>
    </span>
  );
}
