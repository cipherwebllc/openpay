// 取引履歴ページ。LocalStorage 専用なので indexing 不要 (noindex)。
// 中身は HistoryView (client component) に委譲。

import type { Metadata } from 'next';
import { HistoryView } from '@/components/HistoryView';

export const metadata: Metadata = {
  title: 'Transaction history · OpenPay',
  robots: { index: false, follow: false },
};

export default function HistoryPage() {
  return <HistoryView />;
}
