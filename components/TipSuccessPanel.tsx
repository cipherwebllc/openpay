'use client';

import { PayerReceiptCompletion } from './PayerReceiptCompletion';
import { ResultRow } from './ResultRow';

export function TipSuccessPanel({
  title,
  reload,
  thanks,
  thanksUrl,
  openLinkLabel,
  userOpHash,
  txHash,
  receiptId,
  blockNumber,
  userOpLabel,
  txLabel,
  blockLabel,
}: {
  title: string;
  /**
   * 復元した前の支払いの確定で、この画面のチップでないと証明できたとき (第 10 回レビュー H-S・判定は TipForm の
   * foreignSettlement)。題の下に読み込み直しの案内 (body) と「読み込み直す」(label) を出す。題は呼ぶ側が差し替えて渡す。
   * 結果の行と控えは同じ。無ければ今までどおり。
   */
  reload?: { body: string; label: string };
  thanks?: string;
  thanksUrl?: string;
  openLinkLabel: string;
  userOpHash?: string;
  txHash?: string;
  receiptId?: string;
  blockNumber?: bigint;
  userOpLabel: string;
  txLabel: string;
  blockLabel: string;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
      <p className="font-semibold">{title}</p>
      {/* hook は確定と同時に前の支払いの記録を片づけるので、読み込み直せばこの画面のチップを送れる。削除に失敗した端末
          (失敗は握る) では記録が残り、読み込み直しても同じ表示に戻る (既存の限界・/checkout の CheckoutCompletion と同じ)。
          埋め込み (iframe) の中では、読み込み直すのは枠の中だけ (親のページはそのまま)。 */}
      {reload && (
        <>
          <p className="mt-1">{reload.body}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            {reload.label}
          </button>
        </>
      )}
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
        {txHash && <ResultRow label={txLabel} value={txHash} copyable />}
        {blockNumber !== undefined && (
          <ResultRow label={blockLabel} value={blockNumber.toString()} />
        )}
      </dl>

      {/* 顧客 (支援者) 向け電子レシート (支払い控え) を完了画面にも埋め込む。 */}
      <div className="mt-3">
        <PayerReceiptCompletion
          candidateIds={
            receiptId ? [receiptId] : userOpHash ? [txHash, userOpHash] : [txHash]
          }
        />
      </div>
    </div>
  );
}
