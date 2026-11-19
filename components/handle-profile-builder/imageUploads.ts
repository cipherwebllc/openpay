'use client';

// プロフの画像の欄 (アバター・カバー・リンクの各行の小さな画像) のアップロードの状態。画像の値は持たない (値は下書きの
// avatar・cover・links[].imageUrl の https URL の文字列のまま・保存の形と API は変えない)。
// - 欄を出すか (enabled) は親が決める (持ち主の GET /api/handle の imageUpload を HandleClaimPanel が知らせ、下書きを読み込んだ
//   後だけ true)。false のとき各節は今の URL の欄を出す。
// - 欄ごとに操作の番号 (hooks/useImageUpload) を 1 つ持つ: アバター・カバー・リンクの各行 (行の id ごと)。その欄の「画像を選ぶ」・
//   「外す」・URL の手入力が番号を進め、アップロードの結果は送り始めの番号のままのときだけ入る (後から届いた古い画像で上書きしない)。
// - enabled が切り替わったとき・下書きが丸ごと入れ替わったとき (編集に入る・やめる) は、全部の欄の番号を進める (その前に始まった
//   アップロードの結果を入れない)。入れ替わりでは欄も作り直す (session を key に使う: 送信をやめ「アップロード中」を消す)。
// - アップロード中の欄が 1 つでもあれば busy (親は公開を止め、別のタブの下書きの取り込みを待たせる)。

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { nextImageOperation, type ImageOperationCounter } from '@/hooks/useImageUpload';
import type { DraftLink } from '@/lib/handleProfileDraft';

/** アップロード中の欄の集まり (key = 'avatar' | 'cover' | `link:<行の id>`)。 */
export function useImageBusyKeys() {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const setBusy = useCallback((key: string, busy: boolean) => {
    setKeys((current) => {
      if (current.has(key) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  return { busy: keys.size > 0, setBusy };
}

// リンクの行の id。下書きの行には id が無い (保存と下書きの形を変えない) ので、画面の中だけで振る。
let linkRowSeq = 0;
const newLinkRowId = () => `r${++linkRowSeq}`;

/**
 * 前の描画の行と id から、今の行の id を決める (純関数・新しい行の id は newId で作る)。
 * 1. 同じ object は同じ行 (並べ替え・削除・追加はほかの行の object をそのまま使う: useDragReorderList・filter・spread)。
 * 2. 1 に当たらない行は、その位置にあった前の行が今の行のどこにも無い (= その行を書き換えて作り直した: ラベル・URL・画像・
 *    注目の切り替え) なら、同じ行としてその id を引き継ぐ。
 * 3. どちらでもなければ新しい行。
 * 下書きが丸ごと入れ替わる (編集に入る・やめる) と 2 で位置ごとに id を引き継ぐが、そのときは親が全部の欄の番号を進めて欄を
 * 作り直すので、前の下書きの行に向けたアップロードの結果は入らない。
 */
export function deriveLinkRowIds(
  prevRows: readonly object[],
  prevIds: readonly string[],
  rows: readonly object[],
  newId: () => string = newLinkRowId,
): string[] {
  const prevIndex = new Map<object, number>();
  prevRows.forEach((row, index) => {
    if (!prevIndex.has(row)) prevIndex.set(row, index);
  });
  const matched = new Set<number>();
  const sameObject = rows.map((row) => {
    const index = prevIndex.get(row);
    if (index === undefined || matched.has(index)) return undefined;
    matched.add(index);
    return prevIds[index];
  });
  return rows.map((_row, index) => {
    const id = sameObject[index];
    if (id !== undefined) return id;
    if (index < prevRows.length && !matched.has(index)) {
      matched.add(index);
      return prevIds[index];
    }
    return newId();
  });
}

/**
 * 今の下書きのリンクの行の id (行と同じ長さ)。前の描画と比べて決める (deriveLinkRowIds)。行の object から id を引く表
 * (rowIdOf) にも入れる: アップロードの結果を最新の下書きの行に入れるとき (関数での更新の中・まだ描画していない行の配列) に、
 * 位置ではなく object から行を探すため。
 */
function useLinkRowIds(links: readonly object[]): { ids: readonly string[]; rowIdOf: WeakMap<object, string> } {
  const [rowIdOf] = useState(() => new WeakMap<object, string>());
  const [state, setState] = useState(() => ({ links, ids: links.map(() => newLinkRowId()) }));
  let ids = state.ids;
  if (state.links !== links) {
    // 前の描画の情報から今の値を決める (React の「前の描画の情報を保存する」型: 描画の中で 1 度だけ setState し、すぐ描き直す)。
    ids = deriveLinkRowIds(state.links, state.ids, links);
    setState({ links, ids });
  }
  links.forEach((link, index) => rowIdOf.set(link, ids[index]));
  return { ids, rowIdOf };
}

function advanceAll(operations: ReadonlyMap<string, ImageOperationCounter>): void {
  for (const operation of operations.values()) nextImageOperation(operation);
}

export type ProfileImageField = {
  operation: ImageOperationCounter;
  onBusyChange: (busy: boolean) => void;
};

export type ProfileImageUploads = {
  /** 画像の欄を出すか (false なら今の URL の欄)。 */
  enabled: boolean;
  /** 下書きが丸ごと入れ替わるたびに変わる値 (画像の欄の key に使い、欄を作り直す)。 */
  session: number;
  avatar: ProfileImageField;
  cover: ProfileImageField;
  /** draft.links と同じ長さ・同じ順の行の id。 */
  linkRowIds: readonly string[];
  link: (rowId: string) => ProfileImageField;
  /**
   * その行の画像を入れる (画像の欄の結果・外す・URL の手入力)。最新の下書きの中で行を id から探し、その行の imageUrl だけを
   * 変える (描画のときの行の配列を丸ごと書き戻さない: 別の行の結果が同じ確定の前に入っていても消さない)。行が消えていたら入れない。
   */
  setLinkImage: (rowId: string, imageUrl: string) => void;
};

export function useProfileImageUploads({
  enabled,
  links,
  setBusy,
  updateLinks,
}: {
  enabled: boolean;
  links: readonly DraftLink[];
  setBusy: (key: string, busy: boolean) => void;
  /** 最新の下書きの links を関数で更新する (親の setSettings の関数の形)。 */
  updateLinks: (update: (current: DraftLink[]) => DraftLink[]) => void;
}): ProfileImageUploads & { draftReplaced: () => void } {
  const { ids: linkRowIds, rowIdOf } = useLinkRowIds(links);
  const [session, setSession] = useState(0);
  // 欄ごとの操作の番号 (中身を持たない)。enabled が false の間も残す (切り替えで番号を進めるため)。
  const operations = useRef(new Map<string, ImageOperationCounter>());
  const operationFor = (key: string): ImageOperationCounter => {
    let operation = operations.current.get(key);
    if (!operation) {
      operation = { current: 0 };
      operations.current.set(key, operation);
    }
    return operation;
  };
  const field = (key: string): ProfileImageField => ({
    operation: operationFor(key),
    onBusyChange: (busy) => setBusy(key, busy),
  });
  // enabled が切り替わったら全部の欄の番号を進める (切り替わる前に始まったアップロードの結果を入れない)。layout effect にして
  // 描画の前に進める (切り替えの後に出た欄で始めた新しい送信が、後から走る effect に番号を進められて捨てられないように・
  // components/creator-store-seller/ProductEditorSection の表紙と同じ型)。
  const enabledSeen = useRef(enabled);
  useLayoutEffect(() => {
    if (enabledSeen.current === enabled) return;
    enabledSeen.current = enabled;
    advanceAll(operations.current);
  }, [enabled]);

  return {
    enabled,
    session,
    avatar: field('avatar'),
    cover: field('cover'),
    linkRowIds,
    link: (rowId) => field(`link:${rowId}`),
    setLinkImage: (rowId, imageUrl) =>
      updateLinks((current) => {
        const index = current.findIndex((link) => rowIdOf.get(link) === rowId);
        const link = index < 0 ? undefined : current[index];
        if (!link || link.kind === 'heading') return current;
        const updated = { ...link, imageUrl };
        // 次の描画の前に、同じ行への次の更新がこの行を探せるように (描画では deriveLinkRowIds も同じ id を引き継ぐ)。
        rowIdOf.set(updated, rowId);
        const next = [...current];
        next[index] = updated;
        return next;
      }),
    // 下書きを丸ごと入れ替える操作 (編集に入る・やめる) の中で、入れ替える前に同期的に呼ぶ。欄の作り直し (session) は
    // 描画の確定のときなので、それより前に届いた結果 (自動で編集に入る effect・競合の「再読込」の後の編集など、クリックの
    // 外で入れ替えが予約された場合) も、番号で止める。
    draftReplaced: () => {
      advanceAll(operations.current);
      setSession((current) => current + 1);
    },
  };
}
