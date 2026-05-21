'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { QrGenerator } from '@/components/QrGenerator';
import { TipEmbedGenerator } from '@/components/TipEmbedGenerator';
import type { Locale } from '@/i18n';
import { env } from '@/lib/env';
import { getExchangeLink } from '@/lib/links';
import { TOKEN_SYMBOLS } from '@/lib/tokens';

type Tab = 'qr' | 'tip';

export default function HomePage() {
  const [tab, setTab] = useState<Tab>('qr');
  const t = useTranslations('Home');
  const tScan = useTranslations('Scan');
  const locale = useLocale() as Locale;

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-slate-500">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <LocaleSwitcher />
          <span className="rounded-full bg-slate-200 px-2 py-1 font-mono">
            {env.networkEnv}
          </span>
        </div>
      </header>

      {/* Phase 1 experimental: 「事前接続して、レジで scan → sign」UX の入り口。
          仮説検証期間中 (memory: feedback_demand_first.md)、demand-gated で
          home からの 1 動線のみ提供する。需要 signal が出なければ rollback 容易。 */}
      <Link
        href={`/${locale}/scan`}
        prefetch={false}
        className="mb-4 block rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 transition hover:border-blue-300 hover:bg-blue-100 print:hidden"
      >
        <p className="text-sm font-semibold text-blue-900">
          {tScan('homeCta.title')}
        </p>
        <p className="mt-1 text-xs text-blue-800">
          {tScan('homeCta.body')}
        </p>
        <span className="mt-2 inline-block rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white">
          {tScan('homeCta.button')} →
        </span>
      </Link>

      <div className="mb-4 inline-flex flex-wrap rounded-xl border border-slate-200 bg-slate-100 p-1 print:hidden">
        {(
          [
            ['qr', t('tabs.qr')],
            ['tip', t('tabs.tip')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
              tab === id
                ? 'bg-white text-brand-dark shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {tab === 'qr' ? (
          <QrGenerator />
        ) : (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-800">
                {t('tipPanel.heading')}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {t('tipPanel.subheading')}
              </p>
            </div>
            <TipEmbedGenerator />
          </div>
        )}
      </div>

      <section
        aria-labelledby="offramp-heading"
        className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 print:hidden"
      >
        <h2
          id="offramp-heading"
          className="flex items-center gap-2 text-base font-semibold text-slate-800"
        >
          <SwapIcon />
          {t('offramp.heading')}
        </h2>
        <p className="mt-1 text-[11px] text-slate-400">{t('offramp.subheading')}</p>
        <ul className="mt-3 space-y-2">
          {TOKEN_SYMBOLS.map((token) => {
            const link = getExchangeLink(token, locale);
            return (
              <li
                key={token}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
              >
                <TokenIcon token={token} />
                <span className="text-slate-700">
                  {t('offramp.row', { token: token.toUpperCase() })}
                </span>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand hover:underline"
                >
                  {link.label} ↗
                </a>
                {link.jaResidentsOnly && (
                  <span className="text-xs text-slate-500">
                    {t('offramp.jaResidentsOnlyNote')}
                  </span>
                )}
                {link.blocksJapaneseResidents && (
                  <span className="text-xs text-slate-500">
                    {t('offramp.japaneseUserHint')}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[11px] text-slate-400">{t('offramp.hint')}</p>

        {/* JPYC-only / POL 残高ゼロの novice 店主向け迂回路 (memory:
            project_jpyc_only_users.md)。顧客側は OpenPay の gasless で救済済だが、
            受取後の cash-out 経路にも同じ詰みがあるので MetaMask Swap (gasless meta-tx)
            を案内する。MetaMask 提供機能なので OpenPay は責任範囲外と disclaimer 明示。
            UX 簡潔化: 4 段の長文を <details> 折り畳みに変更。常時露出は icon + title +
            chevron のみ、user が必要に応じて展開。e2e の title regex は summary 内に残存。 */}
        <details className="group mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 open:pb-4">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
            <GasPumpIcon />
            <span className="flex-1">{t('offramp.gasHint.title')}</span>
            <ChevronIcon />
          </summary>
          <p className="mt-2 leading-relaxed">{t('offramp.gasHint.body')}</p>
          <a
            href="https://portfolio.metamask.io/swap"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block font-medium text-amber-900 underline hover:text-amber-700"
          >
            {t('offramp.gasHint.linkLabel')} ↗
          </a>
          <p className="mt-2 text-[11px] text-amber-800">
            {t('offramp.gasHint.disclaimer')}
          </p>
        </details>
      </section>

    </main>
  );
}

// Offramp section 用 inline SVG icon 群 (viewBox 24×24、fill=currentColor で親色継承)。
// 依存追加せず PwaInstallHint の X icon 等と同パターンで描画。装飾目的なので aria-hidden。

function SwapIcon() {
  // 上下矢印 (両替 / swap) — 受取通貨を JPY に換金する section heading 用
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-brand"
      aria-hidden
    >
      <path d="M7 4v12m0 0l-3-3m3 3l3-3" />
      <path d="M17 20V8m0 0l-3 3m3-3l3 3" />
    </svg>
  );
}

function TokenIcon({ token }: { token: 'jpyc' | 'usdc' }) {
  // 通貨記号入りの円形 token icon。JPYC=¥/円 (青)、USDC=$ (緑系)。
  // 文字を Tailwind の text-color で塗り分けると flex 内で sibling text と色が
  // 競合するため、SVG の fill だけで完結させる。
  const fg = token === 'jpyc' ? '#1e40af' : '#047857';
  const bg = token === 'jpyc' ? '#dbeafe' : '#d1fae5';
  const glyph = token === 'jpyc' ? '¥' : '$';
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle cx="12" cy="12" r="11" fill={bg} stroke={fg} strokeWidth="1.2" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fill={fg}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {glyph}
      </text>
    </svg>
  );
}

function GasPumpIcon() {
  // ガスポンプ icon。Heroicons "fuel" 風の独自描画 (側面タンク + ノズル)。
  // amber section 内なので fill=currentColor で amber-900 継承。
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="3" width="9" height="18" rx="1.5" />
      <line x1="4" y1="9" x2="13" y2="9" />
      <path d="M13 7h3a2 2 0 0 1 2 2v8a2 2 0 0 0 2 2" />
      <path d="M16 4l2 2" />
    </svg>
  );
}

function ChevronIcon() {
  // details が open のとき 90° 回転して上向きに、close 時は右向き。CSS のみで実現
  // (JS 不要)。group は親 <details>、:has(:open) や details[open] で角度切替。
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="transition-transform group-open:rotate-90"
      aria-hidden
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
