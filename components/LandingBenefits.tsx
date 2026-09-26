// 導入メリット (4 cards: 店舗 3 + 顧客 1)。Server Component。
//
// LandingFeatures (技術特長) と差別化して「実利・実用メリット」をビッグナンバー
// フォーカルで訴求する。レイアウトは mobile 2 col / desktop 4 col。
//
// Fee カードはレジ JPYC の店舗負担率を表示し、ガスレスの最低額と無料の範囲を本文に示す。
//
// audience pill のカラーは LandingHowItWorks (merchant=emerald / customer=blue) と整合。

import type { CSSProperties } from 'react';
import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import { focalFitCqi } from '@/lib/focalFit';
import { getTranslations } from 'next-intl/server';
import { Coins, Rocket, Zap, UserCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
    focal: 'text-emerald-600',
    pillBg: 'bg-emerald-100',
    pillInk: 'text-emerald-800',
    iconInk: 'text-emerald-500',
  },
  customer: {
    focal: 'text-blue-600',
    pillBg: 'bg-blue-100',
    pillInk: 'text-blue-800',
    iconInk: 'text-blue-500',
  },
} as const satisfies Record<BenefitCard['audience'], unknown>;

const AUDIENCE_LABEL_KEY = {
  merchant: 'benefitsAudienceMerchant',
  customer: 'benefitsAudienceCustomer',
} as const satisfies Record<BenefitCard['audience'], string>;

export async function LandingBenefits() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('benefitsTitle')}
        </h2>
        <p className="mt-3 text-sm text-slate-500 sm:text-base">{t('benefitsSubtitle')}</p>
      </div>

      <ul className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {CARDS.map(({ id, audience, Icon }) => {
          const c = TONE[audience];
          const focal = t(`benefits${id}Focal`, LANDING_PAYMENT_FEE_VALUES);
          return (
            <li
              key={id}
              className="flex flex-col rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 [container-type:inline-size] sm:p-6"
            >
              <div className="flex items-center justify-between">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.pillBg} ${c.pillInk}`}
                >
                  {t(AUDIENCE_LABEL_KEY[audience])}
                </span>
                <Icon className={`h-5 w-5 ${c.iconInk}`} aria-hidden />
              </div>

              {/* focal: ビッグナンバー。文字サイズを「最大 (2.25rem / sm 3rem)」と「カード幅に収まる
                  大きさ」の小さい方にして 1 行に収める (lib/focalFit.ts)。未知の書体で収まらなければ空白で折り返す。 */}
              <p
                className={`mt-4 break-keep text-[length:min(2.25rem,var(--focal-fit))] font-extrabold leading-none ${c.focal} sm:text-[length:min(3rem,var(--focal-fit))]`}
                style={{ '--focal-fit': focalFitCqi(focal) } as CSSProperties}
                data-focal=""
              >
                {focal}
              </p>

              <h3 className="mt-3 text-sm font-semibold text-slate-900 sm:text-base">
                {t(`benefits${id}Title`)}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
                {t(`benefits${id}Body`, LANDING_PAYMENT_FEE_VALUES)}
              </p>
            </li>
          );
        })}
      </ul>

    </section>
  );
}
