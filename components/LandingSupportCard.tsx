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

const TIP_ORIGIN = 'https://open-pay.jp';
// 運営の恒久プロフィール (link-in-bio + JPYC/USDC 応援)。会社 @handle は FEE_RECEIVER ウォレットで
// 運用 (利用料対象外) のため、応援は全額そのまま運営へ届く。
const PROFILE_HANDLE = '@openpay_jp';
const PROFILE_URL = `${TIP_ORIGIN}/${PROFILE_HANDLE}`;

export async function LandingSupportCard() {
  const t = await getTranslations('Landing');
  return (
    <div className="mx-auto mt-10 max-w-xl border-t border-slate-700/80 pt-8 text-center">
      <p className="text-sm font-medium leading-relaxed text-slate-200">
        {t('supportTipRequest')}
      </p>

      {/* 応援プロフカード: 5 ボタンを 1 つに集約。カード全体が @openpay_jp プロフへの 1 link
          (入れ子の interactive 要素を避けるため CTA は span)。a11y 名は内側の可視テキストから導出する。
          aria-label は付けない: 可視テキストを含まない aria-label は label-content-name-mismatch
          (WCAG 2.5.3 Label in Name) となり Lighthouse a11y が落ちる。 */}
      <a
        href={PROFILE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl bg-white p-4 text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover sm:p-5"
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

        {/* CTA pill (装飾・aria-hidden)。色は同じ節の「受け取りを始める」と同じ青。スマホは締めの節の余白で幅が狭いので、名前と説明に 1 行を譲って下の段に置く。 */}
        <span
          aria-hidden
          className="inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors group-hover:bg-blue-700 sm:w-auto sm:px-4"
        >
          <Heart className="h-4 w-4" />
          {t('supportProfileCta')}
        </span>
      </a>
    </div>
  );
}
