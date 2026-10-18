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

/**
 * wide: ガイド (/guide/*) の docs 型の幅。xl (1280px) 以上だけ main とヘッダーを max-w-7xl に広げ、
 * 左の目次・本文・右の「このページの内容」の 3 列を置く。xl 未満はほかのページと同じ max-w-5xl。
 */
export function AppShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <>
      <AppHeader wide={wide} />
      <main className={`mx-auto w-full max-w-5xl px-4 pb-24 pt-6 md:pb-10${wide ? ' xl:max-w-7xl' : ''}`}>
        {children}
      </main>
      <BottomNav />
    </>
  );
}
