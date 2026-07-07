// 導入メリット (4 cards: 店舗 3 + 顧客 1)。Server Component。
//
// LandingFeatures (技術特長) と差別化して「実利・実用メリット」をビッグナンバー
// フォーカルで訴求する。レイアウトは mobile 2 col / desktop 4 col。
//
// Fee カード (focal="1%") は OpenPay 利用料 (ガスレス決済の月額利用料・受け取り額の
// 1% 基準・2026 年 7 月のご利用分から・後払い) を素直に打ち出す。クレカ (約 3%) /
// 一般的な QR 決済 (1.5–3.25%) との低率比較が訴求点。決済の媒介ではなくソフト /
// インフラ提供者という規制論的ポジショニングは body の「ガスレス決済の利用に対する
// 月額の利用料」という対価表現で保つ (決済額連動の都度徴収に読ませない)。
//
// audience pill のカラーは LandingHowItWorks (merchant=emerald / customer=blue) と整合。

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
          return (
            <li
              key={id}
              className="flex flex-col rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6"
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

      {/* 「なぜ店舗決済に OpenPay が必要か」: ウォレット送金は送れる人には便利でも店舗
          決済には不十分、という核心メッセージ。ビッグナンバーカードの下に narrative で補足。 */}
      <div className="mx-auto mt-12 max-w-3xl">
        <h3 className="text-center text-xl font-bold text-slate-900 sm:text-2xl">
          {t('benefitsWhyTitle')}
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          {t('benefitsWhyLead')}
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200/70">
            <h4 className="text-sm font-semibold text-slate-900 sm:text-base">
              {t('benefitsWhyPoint1Title')}
            </h4>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
              {t('benefitsWhyPoint1Body')}
            </p>
          </div>
          <div className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200/70">
            <h4 className="text-sm font-semibold text-slate-900 sm:text-base">
              {t('benefitsWhyPoint2Title')}
            </h4>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
              {t('benefitsWhyPoint2Body')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
