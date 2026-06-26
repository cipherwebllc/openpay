// 「こんな用途に使えます」: OpenPay の利用シーン 5 種を提示。
// Server Component。
//
// LandingBenefits (汎用メリット) と LandingHowItWorks (操作フロー) の間に置き、
// 訪問者が「自分ごと化」できる具体的な scenario を見せる:
//   1. 店舗・イベント出店 (実店舗 / フリマ)
//   2. Web3 イベント物販 (ETHTokyo / Devcon 等)
//   3. クリエイター Tip widget (LP に Tip 導線を持たせる)
//   4. DAO / コミュニティ会費
//   5. ポップアップ / 少額決済 (クレカが割に合わない単価)
//
// Tip widget の存在感を LP にも持たせる狙いも兼ねる (機能としては /create タブで
// 提供しているが、トップから見えにくかった)。

import Image from 'next/image';
import { getTranslations } from 'next-intl/server';

const USE_CASES = [
  {
    id: '1',
    image: '/landing/usecase-store-event.avif',
    altKey: 'useCase1ImageAlt',
  },
  {
    id: '2',
    image: '/landing/usecase-web3-event.avif',
    altKey: 'useCase2ImageAlt',
  },
  {
    id: '3',
    image: '/landing/usecase-creator-tip.avif',
    altKey: 'useCase3ImageAlt',
  },
  {
    id: '4',
    image: '/landing/usecase-community-dues.avif',
    altKey: 'useCase4ImageAlt',
  },
  {
    id: '5',
    image: '/landing/usecase-popup-payment.avif',
    altKey: 'useCase5ImageAlt',
  },
] as const;

export async function LandingUseCases() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('useCasesTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('useCasesSubtitle')}</p>
      </div>

      {/* 5 件 grid。mobile 1 col / sm 2 col / lg 3 col。5 件目は 3 col 行では
          独立して左寄せになる (素直な flow)。デザイン上 6 件目で揃えるよりも
          5 件を本気で並べる方が「内容が薄められない」感を出せる。 */}
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {USE_CASES.map((useCase) => (
          <li
            key={useCase.id}
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card"
          >
            <Image
              src={useCase.image}
              alt={t(useCase.altKey)}
              width={960}
              height={540}
              sizes="(min-width: 1024px) 31vw, (min-width: 640px) 46vw, calc(100vw - 2rem)"
              className="aspect-video w-full object-cover"
            />
            <div className="flex flex-col gap-2 p-5">
              <h3 className="text-base font-semibold text-slate-900">
                {t(`useCase${useCase.id}Title`)}
              </h3>
              <p className="text-sm leading-relaxed text-slate-600">
                {t(`useCase${useCase.id}Body`)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
