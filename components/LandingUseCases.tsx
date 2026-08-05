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
  // LP 再構成 P2 (2026-08-04): 販売プラットフォーム化の 2 シーン。画像は Codex image_gen
  // で既存 5 枚とスタイルを揃えて生成 (960x540 avif)。
  {
    id: '6',
    image: '/landing/usecase-digital-goods.avif',
    altKey: 'useCase6ImageAlt',
  },
  {
    id: '7',
    image: '/landing/usecase-ai-api.avif',
    altKey: 'useCase7ImageAlt',
  },
] as const;

export async function LandingUseCases() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('useCasesTitle')}
        </h2>
        <p className="mt-3 text-sm text-slate-500 sm:text-base">{t('useCasesSubtitle')}</p>
      </div>

      {/* 7 件 grid。mobile も 2 col (縦積み 1 col ≒ 3 画面分の縦長を半減 —
          plans/lp-jobs-pass2.md P3)。lg 3 col。端数は justify-center で中央寄せ。 */}
      <ul className="mt-10 flex flex-wrap justify-center gap-3 sm:gap-4">
        {USE_CASES.map((useCase) => (
          <li
            key={useCase.id}
            className="w-[calc(50%-0.375rem)] overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 sm:w-[calc(50%-0.5rem)] lg:w-[calc((100%-2rem)/3)]"
          >
            <Image
              src={useCase.image}
              alt={t(useCase.altKey)}
              width={960}
              height={540}
              sizes="(min-width: 1024px) 31vw, 46vw"
              className="aspect-video w-full object-cover"
            />
            <div className="flex flex-col gap-1.5 p-3.5 sm:gap-2 sm:p-5">
              <h3 className="text-sm font-semibold text-slate-900 sm:text-base">
                {t(`useCase${useCase.id}Title`)}
              </h3>
              <p className="text-xs leading-relaxed text-slate-600 sm:text-sm">
                {t(`useCase${useCase.id}Body`)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
