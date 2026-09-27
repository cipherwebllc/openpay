// トップの「あなたの OpenPay」帯 (plans/lp-polish-2026-09.md P4a)。再訪の接続者に、自分の道具への近道と今日の売上を
// ヒーローより前で見せる。中身は server が描き、出すかどうかだけ client (YourOpenPayFrame) が決める。
// 未接続の訪問者には描かない (display:none・リクエストなし)。道具の並びは flag で決まるので静的 (後から増減しない)。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Calculator, ChevronRight, ClipboardList, History, Palette, QrCode, type LucideIcon } from 'lucide-react';
import { env } from '@/lib/env';
import { YourOpenPayFrame, YourOpenPayToday } from '@/components/LandingYourOpenPayClient';

type Tool = { key: string; href: string; label: string; icon: LucideIcon };

export async function LandingYourOpenPay() {
  const t = await getTranslations('Landing');
  const locale = await getLocale();

  // 注文: 受注の一覧 (受注リレー / 店舗ライブ) を優先し、なければモバイルオーダーの設定へ。どちらも OFF なら出さない。
  const orders: Tool | null =
    env.enableOrderRelay || env.enableShopLive
      ? { key: 'orders', href: `/${locale}/create?tab=orders`, label: t('yourOpenPayToolOrders'), icon: ClipboardList }
      : env.enableMobileOrder
        ? { key: 'orders', href: `/${locale}/create?tab=mobileOrder`, label: t('yourOpenPayToolMobileOrder'), icon: ClipboardList }
        : null;
  const tools: readonly Tool[] = [
    { key: 'qr', href: `/${locale}/create?tab=qr`, label: t('yourOpenPayToolQr'), icon: QrCode },
    { key: 'register', href: `/${locale}/create?tab=register`, label: t('yourOpenPayToolRegister'), icon: Calculator },
    ...(orders ? [orders] : []),
    { key: 'history', href: `/${locale}/history`, label: t('yourOpenPayToolHistory'), icon: History },
  ];

  return (
    <YourOpenPayFrame>
      <section aria-labelledby="your-openpay-title" className="mt-3 rounded-3xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 sm:p-5">
        {/* 見出しの行は高さ固定。今日の売上は右に 1 行で出る (出ても下の段を動かさない)。 */}
        <div className="flex h-8 items-center justify-between gap-3">
          <h2 id="your-openpay-title" className="min-w-0 truncate text-base font-bold text-slate-900 sm:text-lg">
            {t('yourOpenPayTitle')}
          </h2>
          <YourOpenPayToday label={t('yourOpenPayToday')} />
        </div>
        <div className={`mt-3 grid grid-cols-1 gap-2 sm:gap-3 ${env.enableHandles ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : ''}`}>
          <ul className={`grid gap-2 sm:gap-3 ${tools.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
            {tools.map(({ key, href, label, icon: Icon }) => (
              <li key={key}>
                <Link
                  href={href}
                  prefetch={false}
                  className="flex h-full flex-col items-center justify-center gap-1.5 rounded-2xl bg-slate-50 px-1 py-2.5 text-center ring-1 ring-slate-200/70 transition hover:bg-white hover:ring-brand/40 sm:flex-row sm:gap-2 sm:px-3"
                >
                  <Icon className="h-5 w-5 shrink-0 text-brand" aria-hidden />
                  <span className="text-xs font-semibold leading-tight text-slate-800 sm:text-sm">{label}</span>
                </Link>
              </li>
            ))}
          </ul>
          {/* 自分のページ: 作る・編集する入口 (P4b でサインイン済みなら自分のテーマのカードに差し替える・高さは同じ)。 */}
          {env.enableHandles ? (
            <Link
              href={`/${locale}/create?tab=profile`}
              prefetch={false}
              className="group flex h-14 items-center gap-3 rounded-2xl bg-slate-50 px-3 ring-1 ring-slate-200/70 transition hover:bg-white hover:ring-brand/40 lg:h-auto"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10">
                <Palette className="h-5 w-5 text-brand" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-slate-900">{t('yourOpenPayPageTitle')}</span>
                <span className="block truncate text-xs text-slate-600">{t('yourOpenPayPageBody')}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-brand transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ) : null}
        </div>
      </section>
    </YourOpenPayFrame>
  );
}
