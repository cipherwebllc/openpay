// /guide ハブ (「OpenPay でできること」) のグループのパネル (plans/guide-hub-sidebar.md §2.5・plans/guide-ux-polish-2.md P2)。
// page.tsx に規定外の export を作らないため部品に分ける (掟 3)。hook なしの同期部品 (jsdom で描画テスト可)。
// Hero 画像は使わず lucide のアイコンだけ (server で SVG になり client JS は増えない)。
// 料金 (ガイド以外のページ) の行は「補足」の中に置く。

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Bot,
  Calculator,
  ChevronRight,
  ClipboardCheck,
  Image as ImageIcon,
  Languages,
  Palette,
  Plug,
  QrCode,
  ReceiptText,
  ScanLine,
  Smartphone,
  Store,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { STEP_BADGE } from '@/components/guide/PosGuidePieces';
import type { GuideNav, GuideRelatedItem, GuideSlug } from '@/lib/guideNav';

// store の Palette・qr の QrCode・shop の Store は LP の入口 (components/LandingEntryPoints.tsx) と同じ。
// pay の ScanLine は下のナビの「決済」(/scan・components/navItems.tsx) と同じ。
const GUIDE_ICONS: Record<GuideSlug, LucideIcon> = {
  start: ClipboardCheck,
  qr: QrCode,
  shop: Store,
  pos: Calculator,
  pay: ScanLine,
  wallet: Wallet,
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

// ハブの 1 行 (ガイドと関連ページで共通)。リンク名 = タイトル + 説明 (可視テキストだけ・掟 8)。
// 頭はアイコンのタイル。「はじめての方へ」(お店向けの 4 本) は番号のバッジにして読む順を示す。
function HubRow({
  href,
  Icon,
  step,
  label,
  summary,
}: {
  href: string;
  Icon: LucideIcon;
  step?: number;
  label: string;
  summary: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="group flex items-start gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-slate-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
    >
      {step ? (
        <span className={`${STEP_BADGE} mt-0.5`}>{step}</span>
      ) : (
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-50">
          <Icon className="h-4 w-4 text-emerald-700" aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold leading-snug text-slate-900 [word-break:auto-phrase] group-hover:text-emerald-800">
          {label}
        </span>
        <span className="mt-0.5 block text-[13px] leading-relaxed text-slate-500 [text-wrap:pretty] [word-break:auto-phrase]">{summary}</span>
      </span>
      <ChevronRight
        aria-hidden
        className="mt-1 h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-emerald-700"
      />
    </Link>
  );
}

function HubPanel({
  id,
  title,
  badge,
  lead,
  bare = false,
  children,
}: {
  id: string;
  title: string;
  badge?: string;
  lead?: string;
  /** true: 外枠の箱を付けない (本数の少ない従のグループ)。 */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={bare ? 'p-2' : 'rounded-2xl bg-white p-2 ring-1 ring-slate-200/80'}>
      <div className="px-3 pb-1 pt-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 id={id} className="text-base font-bold text-slate-900">
            {title}
          </h2>
          {badge ? (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200/70">
              {badge}
            </span>
          ) : null}
        </div>
        {lead ? <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{lead}</p> : null}
      </div>
      <ul className="divide-y divide-slate-100">{children}</ul>
    </section>
  );
}

/**
 * ガイドのグループを並べる。主な 2 グループ (お店向け・お客様向け) は箱のパネルを 2 列に (同じ段は高さをそろえる)。
 * お店向けのパネルの頭に「はじめての方へ」を置き、4 本に読む順の番号を付ける (ガイドの「次へ」と同じ順)。
 * 残り (クリエイター・AI・補足) は 1〜2 本ずつと短いので、箱にせず罫線の下に並べる (PC は 3 列)。
 * ガイドではない料金 (/pricing) は「補足」に入れる (1 本だけの節を 2 つ並べない・plans/guide-ux-polish-2.md P4)。
 * 目次のサイドバー (GuideFrame) には料金を出さない (plans/pricing-page.md §2.6)。
 */
export function GuideHubPanels({ locale, nav }: { locale: string; nav: GuideNav }) {
  const primary = new Set(['shops', 'customers']);
  const groupPanel = (group: GuideNav['groups'][number], bare: boolean) => (
    <HubPanel
      key={group.id}
      id={`guide-hub-${group.id}`}
      title={group.title}
      badge={group.id === 'shops' ? nav.hubStartTitle : undefined}
      lead={group.id === 'shops' ? nav.hubStartLead : undefined}
      bare={bare}
    >
      {group.items.map((item, index) => (
        <li key={item.slug}>
          <HubRow
            href={`/${locale}/guide/${item.slug}`}
            Icon={GUIDE_ICONS[item.slug]}
            step={group.id === 'shops' ? index + 1 : undefined}
            label={item.label}
            summary={item.summary}
          />
        </li>
      ))}
      {group.id === 'more'
        ? nav.related.items.map((item) => (
            <li key={item.id}>
              <HubRow
                href={`/${locale}${item.path}`}
                Icon={RELATED_ICONS[item.id]}
                label={item.label}
                summary={item.summary}
              />
            </li>
          ))
        : null}
    </HubPanel>
  );
  return (
    <>
      {/* base の grid-cols-1 は必須 (スマホで横にはみ出さない)。 */}
      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
        {nav.groups.filter((group) => primary.has(group.id)).map((group) => groupPanel(group, false))}
      </div>
      <div className="mt-8 grid grid-cols-1 gap-x-4 gap-y-2 border-t border-slate-200 pt-4 md:grid-cols-2 lg:grid-cols-3">
        {nav.groups.filter((group) => !primary.has(group.id)).map((group) => groupPanel(group, true))}
      </div>
    </>
  );
}
