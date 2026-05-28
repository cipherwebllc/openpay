// 導入メリット (3 cards: 店舗 2 + 顧客 1)。Server Component。
//
// LandingFeatures が「技術特長 (gasless / multichain / non-custody)」を伝えるのに
// 対し、本セクションは「実利・実用メリット (コスト・着金・登録不要)」を
// ビッグナンバーフォーカル (大きい数字/シンボル) で訴求する。
//
// LandingFeatures との視覚差別化:
// - Features = horizontal 3 col、icon + heading + body
// - Benefits  = mobile 1 col / desktop 3 col、focal text を中心に据える
//
// Phase 1 (alpha) で OpenPay 決済手数料を 0% 化した際、Fee カード (focal="0.5%")
// は削除。「手数料無料」訴求は LandingFeatures + FAQ に控えめに集約 (LP の
// マーケ的押し出しを避け、Phase 2 での課金モデル復活時の整合性を保つため)。
//
// audience pill のカラーは LandingHowItWorks (merchant=emerald / customer=blue) と
// 整合させる。

import { getTranslations } from 'next-intl/server';
import { Rocket, Zap, UserCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// i18n key は `benefits${BenefitId}{Focal,Title,Body}` で命名統一済 (messages/*.json)、
// 1 つの BenefitId discriminator から template literal で 3 key を派生させる。
type BenefitId = 'Cost' | 'Settlement' | 'NoSignup';

type BenefitCard = {
  id: BenefitId;
  audience: 'merchant' | 'customer';
  Icon: LucideIcon;
};

const CARDS: readonly BenefitCard[] = [
  { id: 'Cost', audience: 'merchant', Icon: Rocket },
  { id: 'Settlement', audience: 'merchant', Icon: Zap },
  { id: 'NoSignup', audience: 'customer', Icon: UserCheck },
];

// merchant / customer ごとの card tone。merchant=emerald (LandingHowItWorks の
// merchant 列と整合)、customer=blue (同・customer 列)。背景は両者とも bg-white で
// 固定なので card className に直接置く (TONE には残さない)。
const TONE = {
  merchant: {
    border: 'border-emerald-200',
    focal: 'text-emerald-600',
    pillBg: 'bg-emerald-100',
    pillInk: 'text-emerald-800',
    iconInk: 'text-emerald-500',
  },
  customer: {
    border: 'border-blue-200',
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
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('benefitsTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('benefitsSubtitle')}</p>
      </div>

      <ul className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-3">
        {CARDS.map(({ id, audience, Icon }) => {
          const c = TONE[audience];
          return (
            <li
              key={id}
              className={`flex flex-col rounded-2xl border bg-white ${c.border} p-5 shadow-sm`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.pillBg} ${c.pillInk}`}
                >
                  {t(AUDIENCE_LABEL_KEY[audience])}
                </span>
                <Icon className={`h-5 w-5 ${c.iconInk}`} aria-hidden />
              </div>

              {/* focal: ビッグナンバー。break-keep + whitespace-nowrap で mobile
                  2 列でも 1 行に収める。 */}
              <p
                className={`mt-4 whitespace-nowrap break-keep text-4xl font-extrabold leading-none ${c.focal} sm:text-5xl`}
              >
                {t(`benefits${id}Focal`)}
              </p>

              <h3 className="mt-3 text-sm font-semibold text-slate-900 sm:text-base">
                {t(`benefits${id}Title`)}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
                {t(`benefits${id}Body`)}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
