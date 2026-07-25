'use client';

import { PayerReceiptCompletion } from './PayerReceiptCompletion';
import { ResultRow } from './ResultRow';

export function TipSuccessPanel({
  title,
  thanks,
  thanksUrl,
  openLinkLabel,
  userOpHash,
  txHash,
  blockNumber,
  userOpLabel,
  txLabel,
  blockLabel,
}: {
  title: string;
  thanks?: string;
  thanksUrl?: string;
  openLinkLabel: string;
  userOpHash?: string;
  txHash: string;
  blockNumber?: bigint;
  userOpLabel: string;
  txLabel: string;
  blockLabel: string;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
      <p className="font-semibold">{title}</p>
      {thanks && (
        <p className="mt-2 whitespace-pre-wrap text-sm">{thanks}</p>
      )}
      {thanksUrl && (
        <a
          href={thanksUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          {openLinkLabel}
        </a>
      )}
      <dl className="mt-3 space-y-1">
        {/* relay は userOpHash / blockNumber を持たない (txHash のみ) → 該当行は省略。 */}
        {userOpHash && (
          <ResultRow label={userOpLabel} value={userOpHash} copyable />
        )}
        <ResultRow label={txLabel} value={txHash} copyable />
        {blockNumber !== undefined && (
          <ResultRow label={blockLabel} value={blockNumber.toString()} />
        )}
      </dl>

      {/* 顧客 (支援者) 向け電子レシート (支払い控え) を完了画面にも埋め込む。 */}
      <div className="mt-3">
        <PayerReceiptCompletion
          candidateIds={
            userOpHash ? [txHash, userOpHash] : [txHash]
          }
        />
      </div>
    </div>
  );
}
