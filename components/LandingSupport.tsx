// OpenPay 利用料の早見カード (決済QR / レジ / モバイル注文 / チップ) + 運営応援カード。
// Server Component。FAQ の下に置く。
//
// 料率カードは LandingBenefits と同じビッグナンバー様式で 4 方法の OpenPay 利用料を簡潔に提示する
// (文言は lib/legal.ts の DISCLOSED 定数と整合・drift は tests/lib/landingFeeDisclosure.test.ts で固定)。
// 応援は単一の「応援プロフカード」に集約し、運営の @openpay_jp プロフ (link-in-bio) へ新規タブで誘導する。
// トークン別 5 ボタンの「選択肢の壁」を引き算しつつ、応援動線をそのまま @handle プロフの実例デモにする
// (dogfooding)。href は canonical な本番 URL (open-pay.jp) を指す (運営の固定プロフなので preview/local
// でも本番ページへ遷移する)。トークン/チェーン選択はプロフ側 (JPYC Polygon/Kaia + USDC) が担う。

import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import {
  Heart,
  QrCode,
  Calculator,
  Smartphone,
  Coins,
  ExternalLink,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const TIP_ORIGIN = 'https://open-pay.jp';
// 運営の恒久プロフィール (link-in-bio + JPYC/USDC 応援)。会社 @handle は FEE_RECEIVER ウォレットで
// 運用 (利用料対象外) のため、応援は全額そのまま運営へ届く。
const PROFILE_HANDLE = '@openpay_jp';
const PROFILE_URL = `${TIP_ORIGIN}/${PROFILE_HANDLE}`;

// 利用料カード。id から `supportFee${id}{Focal,Title,Body}` の 3 key を派生 (LandingBenefits と同型)。
type FeeId = 'Pay' | 'Register' | 'Mobile' | 'Tip';
const FEE_CARDS: readonly { id: FeeId; Icon: LucideIcon }[] = [
  { id: 'Pay', Icon: QrCode },
  { id: 'Register', Icon: Calculator },
  { id: 'Mobile', Icon: Smartphone },
  { id: 'Tip', Icon: Coins },
];

export async function LandingSupport() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('supportTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('supportSubtitle')}</p>
      </div>

      {/* 4 方法の利用料カード (導入メリットと同じビッグナンバー様式)。focal は "1% / 3%" が
          最も幅広いため text-3xl/4xl (benefits より一段小さめ) で 2 列でも 1 行に収める。 */}
      <ul className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {FEE_CARDS.map(({ id, Icon }) => (
          <li
            key={id}
            className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-card"
          >
            <Icon className="h-5 w-5 text-brand" aria-hidden />
            <p className="mt-4 whitespace-nowrap break-keep text-3xl font-extrabold leading-none text-brand sm:text-4xl">
              {t(`supportFee${id}Focal`)}
            </p>
            <h3 className="mt-3 text-sm font-semibold text-slate-900 sm:text-base">
              {t(`supportFee${id}Title`)}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
              {t(`supportFee${id}Body`)}
            </p>
          </li>
        ))}
      </ul>

      <p className="mx-auto mt-6 max-w-2xl text-center text-xs leading-relaxed text-slate-500">
        {t('supportFeeNote')}
      </p>

      <div className="mx-auto mt-10 max-w-xl text-center">
        <p className="text-sm font-medium leading-relaxed text-slate-700">
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
          className="group mt-6 flex items-center gap-4 rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/5 to-brand/10 p-4 text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-brand hover:shadow-card-hover sm:p-5"
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
            <span className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-slate-900 sm:text-base">
                OpenPay
              </span>
              <span className="truncate font-mono text-xs font-medium text-slate-400">
                {PROFILE_HANDLE}
              </span>
              <ExternalLink
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-colors group-hover:text-brand"
              />
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-slate-500 sm:text-sm">
              {t('supportProfileTagline')}
            </span>
          </span>

          {/* CTA pill (装飾・aria-hidden)。 */}
          <span
            aria-hidden
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors group-hover:bg-brand-dark"
          >
            <Heart className="h-4 w-4" />
            {t('supportProfileCta')}
          </span>
        </a>
      </div>
    </section>
  );
}
