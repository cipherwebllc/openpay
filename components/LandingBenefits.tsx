// 導入メリット (4 cards: 店舗 3 + 顧客 1)。Server Component。
//
// LandingFeatures が「技術特長 (gasless / multichain / non-custody)」を伝えるのに
// 対し、本セクションは「実利・実用メリット (手数料・コスト・着金・登録不要)」を
// ビッグナンバーフォーカル (大きい数字/シンボル) で訴求する。
//
// LandingFeatures との視覚差別化:
// - Features = horizontal 3 col、icon + heading + body
// - Benefits  = horizontal 2 col mobile / 4 col desktop、focal text を中心に据える
//
// audience pill のカラーは LandingHowItWorks (merchant=emerald / customer=blue) と
// 整合させる。

import { getTranslations } from 'next-intl/server';
import { Coins, Rocket, Zap, UserCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type BenefitTitleKey =
  | 'benefitsFeeTitle'
  | 'benefitsCostTitle'
  | 'benefitsSettlementTitle'
  | 'benefitsNoSignupTitle';

type BenefitFocalKey =
  | 'benefitsFeeFocal'
  | 'benefitsCostFocal'
  | 'benefitsSettlementFocal'
  | 'benefitsNoSignupFocal';

type BenefitBodyKey =
  | 'benefitsFeeBody'
  | 'benefitsCostBody'
  | 'benefitsSettlementBody'
  | 'benefitsNoSignupBody';

type BenefitCard = {
  audience: 'merchant' | 'customer';
  Icon: LucideIcon;
  focalKey: BenefitFocalKey;
  titleKey: BenefitTitleKey;
  bodyKey: BenefitBodyKey;
};

const CARDS: readonly BenefitCard[] = [
  {
    audience: 'merchant',
    Icon: Coins,
    focalKey: 'benefitsFeeFocal',
    titleKey: 'benefitsFeeTitle',
    bodyKey: 'benefitsFeeBody',
  },
  {
    audience: 'merchant',
    Icon: Rocket,
    focalKey: 'benefitsCostFocal',
    titleKey: 'benefitsCostTitle',
    bodyKey: 'benefitsCostBody',
  },
  {
    audience: 'merchant',
    Icon: Zap,
    focalKey: 'benefitsSettlementFocal',
    titleKey: 'benefitsSettlementTitle',
    bodyKey: 'benefitsSettlementBody',
  },
  {
    audience: 'customer',
    Icon: UserCheck,
    focalKey: 'benefitsNoSignupFocal',
    titleKey: 'benefitsNoSignupTitle',
    bodyKey: 'benefitsNoSignupBody',
  },
];

// merchant / customer ごとの card tone。merchant=emerald (LandingHowItWorks の
// merchant 列と整合)、customer=blue (同・customer 列)。
const TONE = {
  merchant: {
    border: 'border-emerald-200',
    cardBg: 'bg-white',
    focal: 'text-emerald-600',
    pillBg: 'bg-emerald-100',
    pillInk: 'text-emerald-800',
    iconInk: 'text-emerald-500',
  },
  customer: {
    border: 'border-blue-200',
    cardBg: 'bg-white',
    focal: 'text-blue-600',
    pillBg: 'bg-blue-100',
    pillInk: 'text-blue-800',
    iconInk: 'text-blue-500',
  },
} as const satisfies Record<BenefitCard['audience'], unknown>;

export async function LandingBenefits() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('benefitsTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('benefitsSubtitle')}</p>
      </div>

      <ul className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {CARDS.map(({ audience, Icon, focalKey, titleKey, bodyKey }) => {
          const c = TONE[audience];
          const audienceLabel =
            audience === 'merchant'
              ? t('benefitsAudienceMerchant')
              : t('benefitsAudienceCustomer');
          return (
            <li
              key={titleKey}
              className={`flex flex-col rounded-2xl border ${c.border} ${c.cardBg} p-5 shadow-sm`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.pillBg} ${c.pillInk}`}
                >
                  {audienceLabel}
                </span>
                <Icon className={`h-5 w-5 ${c.iconInk}`} aria-hidden />
              </div>

              {/* focal: ビッグナンバー。break-keep + whitespace-nowrap で mobile
                  2 列でも 1 行に収める。 */}
              <p
                className={`mt-4 whitespace-nowrap text-4xl font-extrabold leading-none ${c.focal} sm:text-5xl`}
                style={{ wordBreak: 'keep-all' }}
              >
                {t(focalKey)}
              </p>

              <h3 className="mt-3 text-sm font-semibold text-slate-900 sm:text-base">
                {t(titleKey)}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
                {t(bodyKey)}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
