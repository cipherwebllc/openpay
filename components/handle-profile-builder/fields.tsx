// HandleProfileBuilder と各節 (handle-profile-builder/*) が共有する入力欄の部品・class・更新関数の型。
// 状態は持たない (下書きとその更新は親の HandleProfileBuilder が持ち、各節は props で受け取る)。

import type { ReactNode } from 'react';
import type { ReorderRowProps } from '@/hooks/useDragReorderList';
import type { HandleProfileDraft } from '@/hooks/useHandleProfileDraft';

/** 下書きの一部を書き換える (親の setSettings に patch を重ねる)。 */
export type DraftUpdate = (patch: Partial<HandleProfileDraft>) => void;
/** 親が持つ並べ替え (useDragReorderList) のうち、行に spread する props を作る部分。 */
export type RowReorder = { rowProps: (index: number, length: number) => ReorderRowProps };
/** 並べ替えハンドル/▲▼ の i18n ラベル (socials/links 共通)。 */
export type ReorderLabels = { dragToReorder: string; moveUp: string; moveDown: string };

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </label>
  );
}

export function FieldGroup({
  label,
  children,
  hint,
  hideLabel = false,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  /** 見出しを目に見せない (任意のまとまりの見出しと同じ言葉を 2 回出さない・読み上げには残す)。 */
  hideLabel?: boolean;
}) {
  return (
    <fieldset className="block">
      <legend className={hideLabel ? 'sr-only' : 'text-sm font-medium text-slate-700'}>{label}</legend>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </fieldset>
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none';
export const linkFieldLabelClass =
  'mb-1 block text-xs font-medium text-slate-600';
