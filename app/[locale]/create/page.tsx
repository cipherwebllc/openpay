'use client';

// 「受け取る (Receive)」: 店舗向けの決済 QR / Tip widget 作成ハブ。
// 旧 / の中身 (QR / Tip タブ + offramp section) を AppShell の下に移行。
// AppShell が logo + nav + wallet badge を担うため、ここでは個別 header を持たない。

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRightLeft, ChevronRight, Fuel } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { BillingDueBanner } from '@/components/BillingDueBanner';
import { MarketRates } from '@/components/MarketRates';
import { MiniHistoryRecent } from '@/components/MiniHistoryRecent';
import { QrGenerator } from '@/components/QrGenerator';
import { RegisterMode } from '@/components/RegisterMode';
import { TipEmbedGenerator } from '@/components/TipEmbedGenerator';
import { HandleProfileBuilder } from '@/components/HandleProfileBuilder';
import { env } from '@/lib/env';
import type { Locale } from '@/i18n';
import { getExchangeLink } from '@/lib/links';
import { TOKEN_SYMBOLS, type TokenSymbol } from '@/lib/tokens';

type Tab = 'qr' | 'register' | 'tip' | 'profile';

export default function CreatePage() {
  const [tab, setTab] = useState<Tab>('qr');
  const t = useTranslations('Create');
  const locale = useLocale() as Locale;

  return (
    <AppShell>
      <BillingDueBanner />
      <div className="mb-4">
        <MarketRates />
      </div>

      {/* タブバー: inline-flex のまま (flex にすると desktop で全幅に伸びる)。flex-nowrap +
          overflow-x-auto + 各ボタン whitespace-nowrap/shrink-0 で、ラベル短縮済みでもスマホ
          (360–390px) で 1 行を保ち、将来タブが増えても横スクロールで崩れない。 */}
      <div className="mb-2 inline-flex max-w-full flex-nowrap overflow-x-auto rounded-xl border border-slate-200 bg-slate-100 p-1 print:hidden">
        {(
          [
            ['qr', t('tabs.qr')],
            ['register', t('tabs.register')],
            ['tip', t('tabs.tip')],
            // 「プロフ」(@handle link-in-bio) は flag ON のときだけ露出。
            ...(env.enableHandles
              ? ([['profile', t('tabs.profile')]] as const)
              : []),
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`shrink-0 whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium transition ${
              tab === id
                ? 'bg-white text-brand-dark shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 決済QR タブのみ 1 行説明を出す。レジ / チップは各パネル先頭に見出し+説明が
          あり重複するため出さない。 */}
      {tab === 'qr' && (
        <p className="mb-4 text-sm text-slate-500">{t('tabDesc.qr')}</p>
      )}

      {tab === 'qr' && <QrGenerator />}
      {tab === 'register' && (
        <RegisterMode onEditCurrency={() => setTab('qr')} />
      )}
      {tab === 'tip' && (
        <div className="space-y-5">
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
      {tab === 'profile' && env.enableHandles && <HandleProfileBuilder />}

      <MiniHistoryRecent />

      <section
        aria-labelledby="offramp-heading"
        className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 print:hidden"
      >
        <h2
          id="offramp-heading"
          className="flex items-center gap-2 text-base font-semibold text-slate-800"
        >
          <ArrowRightLeft className="h-5 w-5 text-brand" aria-hidden />
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

        <details className="group mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 open:pb-4">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
            <Fuel className="h-4 w-4" aria-hidden />
            <span className="flex-1">{t('offramp.gasHint.title')}</span>
            <ChevronRight
              className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
              aria-hidden
            />
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
    </AppShell>
  );
}

function TokenIcon({ token }: { token: TokenSymbol }) {
  const fg = token === 'jpyc' ? '#1e40af' : '#047857';
  const bg = token === 'jpyc' ? '#dbeafe' : '#d1fae5';
  const glyph = token === 'jpyc' ? '¥' : '$';
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
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
