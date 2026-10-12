// お客様のウォレットの案内 (選び方 + WalletConnect のつなぎ方)。「JPYC で支払う」と「モバイルオーダーのやり方」で共通。
// 文言は lib/walletGuide.ts。呼び出し側が Section (h2 = walletTitle) で包む。hook・next-intl に依存しない同期の部品。
// aria-label は使わない (名前は可視の文字・掟 8)。お客様の手順なので番号は青 (STEP_BADGE_CUSTOMER)。

import { GuideCallout } from '@/components/guide/GuideCallout';
import { STEP_BADGE_CUSTOMER, StepList } from '@/components/guide/PosGuidePieces';
import type { WalletGuideContent } from '@/lib/walletGuide';

export function WalletChoice({ content: c }: { content: WalletGuideContent }) {
  return (
    <>
      <p className="mt-3 text-sm leading-relaxed text-slate-700">{c.walletLead}</p>
      <ul className="mt-4 space-y-3">
        {c.wallets.map((w) => (
          <li key={w.name} className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
            <p className="text-sm font-semibold text-slate-900">{w.name}</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">{w.body}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">{c.walletNote}</p>
      <h3 className="mt-8 text-base font-semibold text-slate-900">{c.wcTitle}</h3>
      <StepList steps={c.wcSteps} badgeClassName={STEP_BADGE_CUSTOMER} />
      <GuideCallout kind="tip">{c.wcTip}</GuideCallout>
    </>
  );
}
