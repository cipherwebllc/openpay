'use client';

// ドラッグハンドル (grip) + ▲▼ 移動ボタン + 行内容 (children) を並べる行シェル。
// @handle プロフの SNS / リンク集、モバイルオーダーの SNS の 3 リストで共有する。
// 並べ替えの状態/挙動は useDragReorderList が持ち、この component は見た目 + i18n ラベルのみ。
// ⚠️ grip <span> は onDrop を持つ外側 <div> の直接の子であること (ドロップ先を
// grip.parentElement で辿るテスト/実装があるため、この親子関係を崩さない)。

import { GripVertical } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ReorderRowProps } from '@/hooks/useDragReorderList';

export function ReorderableRow({
  index,
  length,
  moveItem,
  drag,
  drop,
  labels,
  children,
}: ReorderRowProps & {
  /** i18n ラベル。呼び出し側の namespace の既存キー (dragToReorder/moveUp/moveDown) を渡す。 */
  labels: { dragToReorder: string; moveUp: string; moveDown: string };
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2" {...drop}>
      <span
        {...drag}
        role="button"
        aria-label={labels.dragToReorder}
        title={labels.dragToReorder}
        className="shrink-0 cursor-grab select-none text-slate-300 hover:text-slate-500"
      >
        <GripVertical className="h-4 w-4" />
      </span>
      <span className="flex shrink-0 flex-col">
        <button
          type="button"
          onClick={() => moveItem(index, index - 1)}
          disabled={index === 0}
          aria-label={labels.moveUp}
          title={labels.moveUp}
          className="leading-none text-slate-300 hover:text-slate-600 disabled:opacity-30"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={() => moveItem(index, index + 1)}
          disabled={index >= length - 1}
          aria-label={labels.moveDown}
          title={labels.moveDown}
          className="leading-none text-slate-300 hover:text-slate-600 disabled:opacity-30"
        >
          ▼
        </button>
      </span>
      {children}
    </div>
  );
}
