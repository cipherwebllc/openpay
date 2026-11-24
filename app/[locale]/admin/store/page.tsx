// 運営 (OpenPay 自社) 専用: 店の商品の販売を止める画面。中身は AdminStoreTakedownView (client) に委譲。
// 止める可否は API 側 (SIWE + ADMIN_WALLETS) が決め、運営でないウォレットには「権限がない」を出す。noindex。

import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import { AdminStoreTakedownView } from '@/components/AdminStoreTakedownView';

export const metadata: Metadata = {
  title: 'Admin · OpenPay store takedown',
  robots: { index: false, follow: false },
};

export default function AdminStorePage() {
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <AdminStoreTakedownView />
      </div>
    </AppShell>
  );
}
