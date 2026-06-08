// OpenPay 利用料 (a1) の店主向けページ。中身は OpenPayFeePanel (client) に委譲し、AppShell が
// header / nav / footer を担う。LocalStorage/SIWE 依存で indexing 不要 (noindex)。

import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import { OpenPayFeePanel } from '@/components/OpenPayFeePanel';

export const metadata: Metadata = {
  title: 'OpenPay usage fee · OpenPay',
  robots: { index: false, follow: false },
};

export default function BillingPage() {
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-xl px-4 py-6">
        <OpenPayFeePanel />
      </div>
    </AppShell>
  );
}
