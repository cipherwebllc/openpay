'use client';

import { CopyableField } from './CopyableField';

export function PaymentResultPanel({
  title,
  reload,
  rows,
}: {
  title: string;
  /**
   * 復元した前の支払いの確定で、この画面の支払いでないと証明できたとき (第 10 回レビュー H-S・判定は PaymentForm の
   * foreignSettlement)。題の下に読み込み直しの案内 (body) と「読み込み直す」(label) を出す。題は呼ぶ側が差し替えて渡す。
   * 結果の行は同じ。無ければ今までどおり。
   */
  reload?: { body: string; label: string };
  // copyable=true の row はクリックで clipboard コピー可能 (tx hash 等の長い文字列向け)
  rows: Array<{ label: string; value: string; copyable?: boolean }>;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
      <p className="font-semibold">{title}</p>
      {/* hook は確定と同時に前の支払いの記録を片づけるので、読み込み直せばこの画面の支払いを払える。削除に失敗した端末
          (失敗は握る) では記録が残り、読み込み直しても同じ表示に戻る (既存の限界・/checkout の CheckoutCompletion と同じ)。 */}
      {reload && (
        <>
          <p className="mt-1 text-xs">{reload.body}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            {reload.label}
          </button>
        </>
      )}
      <dl className="mt-2 space-y-1 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-2">
            <dt className="opacity-70">{row.label}</dt>
            <dd className="min-w-0 flex-1 text-right">
              {row.copyable ? (
                <CopyableField value={row.value} label={row.label} />
              ) : (
                <span className="break-all font-mono">{row.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
