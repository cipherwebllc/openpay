// 取引履歴ページ。LocalStorage 専用なので indexing 不要 (noindex)。
// 中身は HistoryView (client component) に委譲。AppShell が header / nav / footer
// を担うため、ここでは AppShell ラップのみを行う。

import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import { HistoryView } from '@/components/HistoryView';

export const metadata: Metadata = {
  title: 'Transaction history · OpenPay',
  robots: { index: false, follow: false },
};

export default function HistoryPage() {
  return (
    <AppShell>
      <HistoryView />
    </AppShell>
  );
}
