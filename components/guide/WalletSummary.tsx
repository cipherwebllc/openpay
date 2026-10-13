// 「ウォレットを選ぶ」の短い案内 (「JPYC で支払う」と「モバイルオーダーのやり方」で共通)。選び方・QR の読み取り方・つなぎ方は
// /guide/wallet にまとめ、ここには要点とそのページへのリンクだけを置く。文言は lib/walletGuide.ts (summary・summaryLink)。
// 呼び出し側が Section (h2 = 目次の名前「ウォレットを選ぶ」) で包む。hook・next-intl に依存しない同期の部品。

import Link from 'next/link';
import type { WalletGuideContent } from '@/lib/walletGuide';

export function WalletSummary({ locale, content: c }: { locale: string; content: WalletGuideContent }) {
  return (
    <>
      <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.summary}</p>
      <p className="mt-4">
        <Link
          href={`/${locale}/guide/wallet`}
          prefetch={false}
          className="text-sm font-semibold text-emerald-700 underline-offset-2 hover:underline"
        >
          {c.summaryLink} →
        </Link>
      </p>
    </>
  );
}
