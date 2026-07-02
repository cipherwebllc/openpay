'use client';

// リスト項目のドラッグ並べ替え (HTML5 DnD) + ▲▼ 移動の共有ロジック。見た目/i18n は持たず
// (ReorderableRow が担う)、状態 (どの行を掴んでいるか) と並べ替えの実行だけを提供する。
//
// list ごとに 1 インスタンス生成すること。各インスタンスが独自の dragIndex を持つため、
// ドラッグは自然にそのリスト内へスコープされる — 別リストの行は自分の dragIndex が null の
// ままなので onDragOver が preventDefault せず、ドロップが成立しない (= クロスリスト drag を
// ブロック)。@handle プロフの socials/links がひとつの discriminated ref を共有して実現して
// いた「別リストへは落とせない」挙動を、インスタンス分離でそのまま再現する。

import { useRef, type DragEvent } from 'react';

// from の要素を抜いて to へ挿入した新配列を返す (純粋)。境界処理は呼び出し側の
// ▲▼ ボタン disabled が担うため、ここは元の moveItem と同一の splice のみ。
function reorder<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// ReorderableRow へ spread する 1 行ぶんの並べ替え props。
export interface ReorderRowProps {
  index: number;
  length: number;
  moveItem: (from: number, to: number) => void;
  /** ドラッグハンドル (grip) の要素へ spread する。 */
  drag: {
    draggable: true;
    onDragStart: () => void;
    onDragEnd: () => void;
  };
  /** 行 (ドロップ先) の要素へ spread する。 */
  drop: {
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}

export function useDragReorderList<T>(
  list: T[],
  onReorder: (next: T[]) => void,
) {
  // どの行を掴んでいるか。このインスタンス (= このリスト) 専用。
  const dragIndex = useRef<number | null>(null);

  const moveItem = (from: number, to: number) =>
    onReorder(reorder(list, from, to));

  const rowProps = (index: number, length: number): ReorderRowProps => ({
    index,
    length,
    moveItem,
    drag: {
      draggable: true,
      onDragStart: () => {
        dragIndex.current = index;
      },
      onDragEnd: () => {
        dragIndex.current = null;
      },
    },
    drop: {
      onDragOver: (e) => {
        if (dragIndex.current !== null) e.preventDefault();
      },
      onDrop: (e) => {
        const from = dragIndex.current;
        if (from === null) return;
        e.preventDefault();
        if (from !== index) onReorder(reorder(list, from, index));
        dragIndex.current = null;
      },
    },
  });

  return { moveItem, rowProps };
}
