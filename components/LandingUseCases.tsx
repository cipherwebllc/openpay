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
import { Bot, Gift, Landmark, Palette, ShoppingBag, Store, Ticket, type LucideIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';

const USE_CASES = [
  {
    id: '1',
    icon: Store,
    image: '/landing/usecase-store-event.avif',
    altKey: 'useCase1ImageAlt',
  },
  {
    id: '2',
    icon: Ticket,
    image: '/landing/usecase-web3-event.avif',
    altKey: 'useCase2ImageAlt',
  },
  {
    id: '3',
    icon: Palette,
    image: '/landing/usecase-creator-tip.avif',
    altKey: 'useCase3ImageAlt',
  },
  {
    id: '4',
    icon: Landmark,
    image: '/landing/usecase-community-dues.avif',
    altKey: 'useCase4ImageAlt',
  },
  {
    id: '5',
    icon: Gift,
    image: '/landing/usecase-popup-payment.avif',
    altKey: 'useCase5ImageAlt',
  },
  // LP 再構成 P2 (2026-08-04): 販売プラットフォーム化の 2 シーン。画像は Codex image_gen
  // で既存 5 枚とスタイルを揃えて生成 (960x540 avif)。
  {
    id: '6',
    icon: ShoppingBag,
    image: '/landing/usecase-digital-goods.avif',
    altKey: 'useCase6ImageAlt',
  },
  {
    id: '7',
    icon: Bot,
    image: '/landing/usecase-ai-api.avif',
    altKey: 'useCase7ImageAlt',
  },
] as const satisfies readonly { id: string; icon: LucideIcon; image: string; altKey: string }[];

export async function LandingUseCases() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader id="lp-use-cases-title" eyebrow={t('eyebrowUseCases')} title={t('useCasesTitle')} lead={t('useCasesSubtitle')} />

      {/* スマホは横スクロールの 1 行 (2 列の格子 4 段 ≒ 1 画面強を 1 段に・plans/lp-polish-2026-09.md P1)。
          次のカードが少し見えて「横に続く」と分かる幅にする。スクロール領域はキーボードでも動かせるよう
          フォーカス可能にし、名前は見出しから取る (掟 8: 可視テキスト由来)。sm 以上は従来の格子。 */}
      <div
        role="region"
        aria-labelledby="lp-use-cases-title"
        tabIndex={0}
        className="-mx-4 mt-8 snap-x snap-mandatory scroll-px-4 overflow-x-auto px-4 pb-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:mx-0 sm:mt-10 sm:scroll-px-0 sm:overflow-visible sm:px-0 sm:pb-0"
      >
        <ul className="flex gap-3 sm:flex-wrap sm:justify-center sm:gap-4">
          {USE_CASES.map((useCase) => (
            <li
              key={useCase.id}
              className="w-[72%] shrink-0 snap-start overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 sm:w-[calc(50%-0.5rem)] sm:shrink lg:w-[calc((100%-3rem)/4)]"
            >
              <Image
                src={useCase.image}
                alt={t(useCase.altKey)}
                width={960}
                height={540}
                sizes="(min-width: 1024px) 23vw, (min-width: 640px) 46vw, 72vw"
                className="aspect-video w-full object-cover"
              />
              <div className="flex flex-col gap-1.5 p-3.5 sm:gap-2 sm:p-5">
                {/* 見出しの記号は線のアイコンでそろえる (絵文字は端末ごとに見た目が変わる・plans/lp-polish-2026-09.md P2)。 */}
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 sm:text-base">
                  <useCase.icon aria-hidden className="h-4 w-4 shrink-0 text-brand" />
                  {t(`useCase${useCase.id}Title`)}
                </h3>
                <p className="text-xs leading-relaxed text-slate-600 sm:text-sm">
                  {t(`useCase${useCase.id}Body`)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
