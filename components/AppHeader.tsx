'use client';

// AppShell の sticky 上部ヘッダー。
// 左: Logo (h1 として alt='OpenPay' を継承)。
// 中: TopNav (md+ のみ、mobile では BottomNav が代替)。
// 右: WalletBadge + LocaleSwitcher + env pill。

import Link from 'next/link';
import NextImage from 'next/image';
import { useLocale } from 'next-intl';
import { LocaleSwitcher } from './LocaleSwitcher';
import { TopNav } from './TopNav';
import { WalletBadge } from './WalletBadge';
import { env } from '@/lib/env';
import type { Locale } from '@/i18n';

// ブランド名はロケール非依存 (alt / aria-label の logo a11y 名)。i18n 経由で
// 別 namespace の "title" key を借りる必要は無く、ここで literal を保持する方が
// 結合度が低い。
const BRAND_NAME = 'OpenPay';

export function AppHeader() {
  const locale = useLocale() as Locale;

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur print:hidden">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:gap-4">
        <h1 className="flex-shrink-0">
          <Link
            href={`/${locale}`}
            prefetch={false}
            aria-label={BRAND_NAME}
            className="block"
          >
            <NextImage
              src="/logo.svg"
              alt={BRAND_NAME}
              width={205}
              height={48}
              priority
              className="h-7 w-auto sm:h-8"
            />
          </Link>
        </h1>

        <div className="flex-1">
          <TopNav />
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 text-xs text-slate-500">
          <WalletBadge />
          <LocaleSwitcher />
          <span className="hidden rounded-full bg-slate-200 px-2 py-1 font-mono sm:inline">
            {env.networkEnv}
          </span>
        </div>
      </div>
    </header>
  );
}
