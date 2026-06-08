// 運営 (OpenPay 自社) 専用: a1 利用料の収益ダッシュボード。中身は AdminBillingView (client) に委譲。
// アクセス可否は API 側 (SIWE + ADMIN_WALLETS) が決め、非 admin には「権限なし」を表示する。noindex。

import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import { AdminBillingView } from '@/components/AdminBillingView';

export const metadata: Metadata = {
  title: 'Admin · OpenPay fee revenue',
  robots: { index: false, follow: false },
};

export default function AdminBillingPage() {
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <AdminBillingView />
      </div>
    </AppShell>
  );
}
