// /guide ハブ (「OpenPay でできること」) のグループ節とカード (plans/guide-hub-sidebar.md §2.5)。
// page.tsx に規定外の export を作らないため部品に分ける (掟 3)。hook なしの同期部品 (jsdom で描画テスト可)。
// Hero 画像は使わず lucide のアイコンだけ (server で SVG になり client JS は増えない)。
// 末尾の「関連ページ」(GuideHubRelated) はガイド以外のページ (料金) へのカード。

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
  ReceiptText,
  Smartphone,
  Store,
  type LucideIcon,
} from 'lucide-react';
import type { GuideNav, GuideRelatedItem, GuideSlug } from '@/lib/guideNav';

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

// 料金は通貨記号の無い ReceiptText (Receipt は「$」入りで JPYC・円の文脈に合わない)。
const RELATED_ICONS: Record<GuideRelatedItem['id'], LucideIcon> = {
  pricing: ReceiptText,
};

// カード 1 枚の見た目 (ガイドのカードと関連ページのカードで共通)。リンク名 = タイトル + 説明 (可視テキストだけ・掟 8)。
function HubCard({ href, Icon, label, summary }: { href: string; Icon: LucideIcon; label: string; summary: string }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="group flex h-full items-start gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200/80 transition hover:-translate-y-0.5 hover:ring-emerald-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50">
        <Icon className="h-5 w-5 text-emerald-700" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-bold leading-snug text-slate-900">
          {label}
          <ArrowRight
            aria-hidden
            className="h-4 w-4 shrink-0 text-emerald-700 transition-transform group-hover:translate-x-0.5"
          />
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-slate-600">{summary}</span>
      </span>
    </Link>
  );
}

export function GuideHubGroups({ locale, nav }: { locale: string; nav: GuideNav }) {
  return (
    <>
      {nav.groups.map((group) => (
        <section key={group.id} className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">{group.title}</h2>
          {/* base の grid-cols-1 は必須 (スマホで横にはみ出さない)。 */}
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {group.items.map((item) => (
              <li key={item.slug}>
                <HubCard
                  href={`/${locale}/guide/${item.slug}`}
                  Icon={GUIDE_ICONS[item.slug]}
                  label={item.label}
                  summary={item.summary}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

// ハブの末尾「関連ページ」: ガイドではないページ (料金 /pricing) へのカード (plans/pricing-page.md §2.6)。
// 目次のサイドバー (GuideFrame) には出さない。
export function GuideHubRelated({ locale, nav }: { locale: string; nav: GuideNav }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold text-slate-900">{nav.related.title}</h2>
      <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {nav.related.items.map((item) => (
          <li key={item.id}>
            <HubCard
              href={`/${locale}${item.path}`}
              Icon={RELATED_ICONS[item.id]}
              label={item.label}
              summary={item.summary}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
