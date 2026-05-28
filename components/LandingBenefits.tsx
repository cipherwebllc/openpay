// 導入メリット (4 cards: 店舗 3 + 顧客 1)。Server Component。
//
// LandingFeatures が「技術特長 (gasless / multichain / non-custody)」を伝えるのに
// 対し、本セクションは「実利・実用メリット (決済手数料・コスト・着金・登録不要)」を
// ビッグナンバーフォーカル (大きい数字/シンボル) で訴求する。
//
// LandingFeatures との視覚差別化:
// - Features = horizontal 3 col、icon + heading + body
// - Benefits  = mobile 2 col / desktop 4 col、focal text を中心に据える
//
// Fee カード (focal="0%") は「決済額に連動した % 手数料 = 永久にゼロ」を訴求する。
// Phase 1 で OpenPay 利用全体が 0% という位置づけだが、ここで強く打ち出すのは
// 「決済手数料 (= 取引額連動の %)」の永続コミットメントのみ — 将来の月額固定
// や利用権販売は別軸として、決済額連動の手数料は取らないという宣言は規制論的にも
// 「決済の媒介ではなくソフト/インフラ提供者」を強化する。
//
// audience pill のカラーは LandingHowItWorks (merchant=emerald / customer=blue) と
// 整合させる。

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

      <ul className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
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
