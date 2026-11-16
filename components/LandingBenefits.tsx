// お店向けの導入メリット (4 cards)。Server Component。
//
// LandingFeatures (技術特長) と差別化して「実利・実用メリット」をビッグナンバー
// フォーカルで訴求する。レイアウトは mobile 2 col / desktop 4 col。
//
// Fee カードは「0円〜」を前に出し、条件 (お客様がガス代を払う通常決済) とガスレスの料率・最低額を本文に示す
// (2026-10-25 user 指摘: 強みの 0 円が埋もれていた)。2 枚目は 0 が並ばないよう「スマホ1つ」にした。
// 店舗 / 顧客のピルは外した (章ラベル「お店向け」が宛名を持つ・4 枚目は見出しで「お客様は」と書く)。
// 数字の色は LandingHowItWorks (merchant=emerald / customer=blue) と整合。

import type { CSSProperties } from 'react';
import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import { focalFitCqi } from '@/lib/focalFit';
import { getLocale, getTranslations } from 'next-intl/server';
import { Coins, Rocket, Zap, UserCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { PAYER_TONE } from '@/components/pricing/PayerPill';
import { LANDING_CARD, LANDING_CARD_TITLE, LANDING_FIGURE, LANDING_ICON_BOX } from '@/components/LandingControls';
import { phrased } from '@/components/Phrased';

// i18n key は `benefits${BenefitId}{Focal,Title,Body}` で命名統一済 (messages/*.json)、
// 1 つの BenefitId discriminator から template literal で 3 key を派生させる。
type BenefitId = 'Fee' | 'Cost' | 'Settlement' | 'NoSignup';

type BenefitCard = {
  id: BenefitId;
  audience: 'merchant' | 'customer';
  Icon: LucideIcon;
};

const CARDS: readonly BenefitCard[] = [
  { id: 'Fee', audience: 'merchant', Icon: Coins },
  { id: 'Cost', audience: 'merchant', Icon: Rocket },
  { id: 'Settlement', audience: 'merchant', Icon: Zap },
  { id: 'NoSignup', audience: 'customer', Icon: UserCheck },
];

// merchant / customer ごとの card tone。merchant=emerald (LandingHowItWorks の
// merchant 列と整合)、customer=blue (同・customer 列)。背景は両者とも bg-white で
// 固定なので card className に直接置く (TONE には残さない)。
const TONE = {
  merchant: {
    focal: PAYER_TONE.shop.focal,
    iconBox: 'bg-emerald-50 text-emerald-600',
  },
  customer: {
    focal: PAYER_TONE.customer.focal,
    iconBox: 'bg-blue-50 text-blue-600',
  },
} as const satisfies Record<BenefitCard['audience'], unknown>;

export async function LandingBenefits() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section className="mt-16 sm:mt-28">
      {/* 見出しは「売上を待たない。」(旧・独立節の一文)。「導入メリット」は章ラベルに回し、
          即時着金の一文と 4 枚の実利を 1 か所で読ませる。 */}
      <LandingSectionHeader
        eyebrow={t('benefitsTitle')}
        title={phrased(t('payoutStatementTitle'), locale)}
        lead={phrased(t('payoutStatementBody'), locale)}
      />

      <ul className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {CARDS.map(({ id, audience, Icon }) => {
          const c = TONE[audience];
          const focal = t(`benefits${id}Focal`, LANDING_PAYMENT_FEE_VALUES);
          return (
            <li
              key={id}
              className={`flex flex-col p-5 [container-type:inline-size] [word-break:auto-phrase] sm:p-6 ${LANDING_CARD}`}
            >
              <span className={`${LANDING_ICON_BOX} ${c.iconBox}`}>
                <Icon className="h-5 w-5" aria-hidden />
              </span>

              {/* focal: ビッグナンバー (大きい数字の型)。文字サイズを「最大 2.25rem (料金のカードの数字と同じ)」と「カード幅に収まる
                  大きさ」の小さい方にして 1 行に収める (lib/focalFit.ts)。未知の書体で収まらなければ空白で折り返す。
                  PC も 2.25rem まで: 3rem にすると 4 列のカードに入る語と入らない語で大きさがばらつく (ja の 1280px 幅で 48 / 37 / 48 / 44px)。 */}
              <p
                className={`mt-4 break-keep text-[length:min(2.25rem,var(--focal-fit))] ${LANDING_FIGURE.base} ${c.focal}`}
                style={{ '--focal-fit': focalFitCqi(focal) } as CSSProperties}
                data-focal=""
              >
                {focal}
              </p>

              <h3 className={`mt-3 ${LANDING_CARD_TITLE}`}>
                {phrased(t(`benefits${id}Title`), locale)}
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-600 sm:text-sm">
                {t(`benefits${id}Body`, LANDING_PAYMENT_FEE_VALUES)}
              </p>
            </li>
          );
        })}
      </ul>

    </section>
  );
}
