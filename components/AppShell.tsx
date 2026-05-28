'use client';

// 「ポータル」系ページ (LP /, /create, /scan, /history, /explore) の共通レイアウト。
// 上に AppHeader (logo + TopNav + WalletBadge) を sticky で置き、下に BottomNav
// (md 未満のみ fixed) を置く。main は max-w-5xl + pb-24 で mobile BottomNav と被らない。
//
// AppShell を採用しないページ (pay/checkout/tip/[address]/legal/experimental) は
// 既存どおり個別 header を保つ — transactional leaf を focus 維持。

import type { ReactNode } from 'react';
import { AppHeader } from './AppHeader';
import { BottomNav } from './BottomNav';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-5xl px-4 pb-24 pt-6 md:pb-10">
        {children}
      </main>
      <BottomNav />
    </>
  );
}
