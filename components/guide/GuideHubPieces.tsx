// /guide ハブ (「OpenPay でできること」) のグループ節とカード (plans/guide-hub-sidebar.md §2.5)。
// page.tsx に規定外の export を作らないため部品に分ける (掟 3)。hook なしの同期部品 (jsdom で描画テスト可)。
// Hero 画像は使わず lucide のアイコンだけ (server で SVG になり client JS は増えない)。

import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  Calculator,
  ClipboardCheck,
  Image as ImageIcon,
  Languages,
  Palette,
  Plug,
  QrCode,
  Smartphone,
  Store,
  type LucideIcon,
} from 'lucide-react';
import type { GuideNav, GuideSlug } from '@/lib/guideNav';

// store の Palette・qr の QrCode・shop の Store は LP の入口 (components/LandingEntryPoints.tsx) と同じ。
const GUIDE_ICONS: Record<GuideSlug, LucideIcon> = {
  start: ClipboardCheck,
  qr: QrCode,
  shop: Store,
  pos: Calculator,
  'mobile-order': Smartphone,
  agent: Languages,
  store: Palette,
  'ai-pay': Bot,
  sell: Plug,
  'image-url': ImageIcon,
};

export function GuideHubGroups({ locale, nav }: { locale: string; nav: GuideNav }) {
  return (
    <>
      {nav.groups.map((group) => (
        <section key={group.id} className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">{group.title}</h2>
          {/* base の grid-cols-1 は必須 (スマホで横にはみ出さない)。 */}
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {group.items.map((item) => {
              const Icon = GUIDE_ICONS[item.slug];
              return (
                <li key={item.slug}>
                  {/* リンク名 = タイトル + 説明 (可視テキストだけ・掟 8)。 */}
                  <Link
                    href={`/${locale}/guide/${item.slug}`}
                    prefetch={false}
                    className="group flex h-full items-start gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200/80 transition hover:-translate-y-0.5 hover:ring-emerald-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50">
                      <Icon className="h-5 w-5 text-emerald-700" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 text-sm font-bold leading-snug text-slate-900">
                        {item.label}
                        <ArrowRight
                          aria-hidden
                          className="h-4 w-4 shrink-0 text-emerald-700 transition-transform group-hover:translate-x-0.5"
                        />
                      </span>
                      <span className="mt-1 block text-sm leading-relaxed text-slate-600">
                        {item.summary}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
