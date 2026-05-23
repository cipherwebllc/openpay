// Cross-chain USDC receive — phase 1 experimental demo route.
//
// 隔離規律:
//   - EXPERIMENTAL_CROSS_CHAIN_ENABLED が false なら notFound() で 404
//     (production / staging で route 自体が存在しないように見える)
//   - 本 page は実験用 UI のため Japanese / English の i18n を持たず、
//     operator-facing の英語 + 開発者向け説明のみ
//   - 既存 /pay /tip /checkout /scan には touch しない
//   - HashPort wallet 実機検証 + 各種 testnet 1 周動作確認のため operator が
//     env=true で opt-in する想定

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { LOCALES } from '@/i18n';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { env } from '@/lib/env';
import { EXPERIMENTAL_CROSS_CHAIN_ENABLED } from '@/lib/crossChain/config';
import { CrossChainDemoClient } from './CrossChainDemoClient';

export const metadata = {
  title: 'OpenPay — Cross-chain Demo (experimental)',
};

export default async function CrossChainDemoPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);

  // env flag 未有効時は 404。route 自体が存在しないように見える
  // (decision doc §3.3 の隔離規律)
  if (!EXPERIMENTAL_CROSS_CHAIN_ENABLED) notFound();

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-4 py-8 sm:py-10">
      <header className="mb-6 flex items-center justify-between gap-2 text-xs text-slate-500">
        <Link href="/" className="hover:text-slate-700" prefetch={false}>
          ← OpenPay
        </Link>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <span className="rounded-full bg-amber-100 px-2 py-1 font-mono text-amber-800">
            experimental
          </span>
          <span className="rounded-full bg-slate-200 px-2 py-1 font-mono">
            {env.networkEnv}
          </span>
        </div>
      </header>

      <div className="mb-6 space-y-2">
        <h1 className="text-2xl font-bold text-slate-900">
          Cross-chain USDC Demo
        </h1>
        <p className="text-sm text-slate-600">
          Circle Gateway 経由で USDC を任意 chain から指定 chain へ
          移動するための実験 demo。phase 1 の動作確認用。
          本 page は <code className="font-mono">NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED=true</code> で opt-in。
        </p>
        <p className="text-xs text-amber-700">
          ⚠ pre-deposit が必要、L2 deposit finality は 13-19 分。
          本実装は本線 PaymentForm へ統合されていない隔離 demo です (decision doc §3.3)。
        </p>
      </div>

      <CrossChainDemoClient />
    </main>
  );
}
