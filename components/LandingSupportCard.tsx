// 運営の応援カード (締め LandingTrust の中・2026-10-12 user 裁定で料金の節から移した)。Server Component。
//
// 応援は単一の「応援プロフカード」に集約し、運営の @openpay_jp プロフ (link-in-bio) へ新規タブで誘導する。
// トークン別 5 ボタンの「選択肢の壁」を引き算しつつ、応援動線をそのまま @handle プロフの実例デモにする
// (dogfooding)。href は canonical な本番 URL (open-pay.jp) を指す (運営の固定プロフなので preview/local
// でも本番ページへ遷移する)。トークン/チェーン選択はプロフ側 (JPYC Polygon/Kaia + USDC) が担う。
// 締めは濃い紺の面なので、案内の文字は明るく、カードは白にする。

import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { ExternalLink, Heart } from 'lucide-react';
import { LANDING_LINK_CARD, LANDING_PRIMARY } from '@/components/LandingControls';

const TIP_ORIGIN = 'https://open-pay.jp';
// 運営の恒久プロフィール (link-in-bio + JPYC/USDC 応援)。会社 @handle は FEE_RECEIVER ウォレットで
// 運用 (利用料対象外) のため、応援は全額そのまま運営へ届く。
const PROFILE_HANDLE = '@openpay_jp';
const PROFILE_URL = `${TIP_ORIGIN}/${PROFILE_HANDLE}`;

export async function LandingSupportCard() {
  const t = await getTranslations('Landing');
  // 区切りの線の上下の空き: スマホは 32 / 24px (技術説明の区切りと同じ)・sm 以上は 40 / 32px。
  return (
    <div className="mx-auto mt-8 max-w-xl border-t border-slate-700/80 pt-6 text-center sm:mt-10 sm:pt-8">
      <p className="text-sm font-medium leading-relaxed text-slate-200">
        {t('supportTipRequest')}
      </p>

      {/* 応援プロフカード: 5 ボタンを 1 つに集約。カード全体が @openpay_jp プロフへの 1 link
          (入れ子の interactive 要素を避けるため CTA は span)。a11y 名は内側の可視テキストから導出する。
          aria-label は付けない: 可視テキストを含まない aria-label は label-content-name-mismatch
          (WCAG 2.5.3 Label in Name) となり Lighthouse a11y が落ちる。
          押せるカードの型 (濃い紺の面の上 = focus の輪は白・hover で浮かせない。hover は中のボタンの色で分かる)。 */}
      <a
        href={PROFILE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`group mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 p-4 text-left sm:p-5 ${LANDING_LINK_CARD.onDark}`}
      >
        {/* avatar (装飾): OpenPay ブランドマーク。@handle プロフの「顔」を見せて実例感を出す。 */}
        <span
          aria-hidden
          className="shrink-0 overflow-hidden rounded-2xl ring-1 ring-slate-200/70"
        >
          <Image
            src="/icon-512.png"
            alt=""
            width={56}
            height={56}
            className="h-12 w-12 sm:h-14 sm:w-14"
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="text-sm font-bold text-slate-900 sm:text-base">
              OpenPay
            </span>
            <span className="font-mono text-xs font-medium text-slate-500">
              {PROFILE_HANDLE}
            </span>
            <ExternalLink
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-colors group-hover:text-brand"
            />
          </span>
          <span className="mt-0.5 block text-[13px] leading-relaxed text-slate-500 sm:text-sm">
            {t('supportProfileTagline')}
          </span>
        </span>

        {/* CTA pill (装飾・aria-hidden)。白いカードの上なので、節の主ボタンの型 (紺)。カード全体が 1 つのリンクなので、色はカードの hover で変える。
            スマホは締めの節の余白で幅が狭いので、名前と説明に 1 行を譲って下の段に置く。幅は中身の幅のまま右に寄せる
            (カードの幅いっぱいにすると、この節の主ボタンやヒーローの主ボタンより大きく見える)。 */}
        <span aria-hidden className="flex w-full shrink-0 justify-end sm:w-auto">
          <span className={`group-hover:bg-brand-dark ${LANDING_PRIMARY.brand}`}>
            <Heart className="h-4 w-4" />
            {t('supportProfileCta')}
          </span>
        </span>
      </a>
    </div>
  );
}
