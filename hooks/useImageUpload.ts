'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { flushSync } from 'react-dom';
import type { ImagePurpose } from '@/lib/images/purpose';
import { uploadImageFile, type ImageUploadFailure } from '@/lib/images/uploadClient';

// 画像の欄 (components/ImageField.tsx) と Store の追加画像の「画像を追加」が共有する、アップロードの状態。
// - 1 度に 1 枚だけ送る (送っている間の 2 回目は送らない = 二重送信の防ぎ)。
// - 取消 (cancel)・unmount の後に届いた古い応答は捨てる (フォームの値を上書きしない)。
// - busy を親へ知らせる (親はアップロード中の保存を止める)。effect を待たず、送り始め・やめる・届いたときに、その場で
//   (同じイベント・同じ描画の確定で) 知らせる: effect まで待つと「アップロード中」が出た後の次のクリックで保存・公開できて
//   しまう。unmount でも false を知らせる。
// - 届いた結果はその場で確定させる (flushSync): 確定を待つ間に来た別の更新 (ほかの欄の結果・手入力) と、描画のときの値を
//   丸ごと書き戻す更新が重なって、片方が消えないように。入れ先は呼び元が最新の値に重ねる (関数で更新する) のが前提。
// - 失敗は code を返すだけ: 元の値は呼び元が持ったまま (onUploaded は成功のときだけ呼ぶ)。
// - operation (操作の番号) を渡すと「最後の操作だけが反映される」: 送り始めに番号を進め、届いたときに番号が進んでいたら
//   入れない。同じ入れ先 (商品の表紙) を書き換える操作 = 表紙の欄のアップロード・AI の「この画像を表紙に使う」・URL の
//   手入力・外す・元に戻す が 1 つの番号を共有し、どれも同期的に番号を進める (nextImageOperation)。値ではなく番号で
//   比べるので、手入力で元の値に戻した場合も、後から届いた古い画像はその操作を上書きしない。

/**
 * 同じ入れ先を書き換える操作の番号 (useRef(0) で作り、その入れ先を書き換える部品すべてに同じものを渡す)。
 * 中身 (URL など) は持たない。
 */
export type ImageOperationCounter = { current: number };

/** 操作を 1 つ進め、その番号を返す。入れ先を書き換える操作 (アップロードの開始を含む) のたびに、同期的に呼ぶ。 */
export function nextImageOperation(operation: ImageOperationCounter): number {
  operation.current += 1;
  return operation.current;
}

export type UseImageUploadOptions = {
  purpose: ImagePurpose;
  onUploaded: (url: string) => void;
  onBusyChange?: (busy: boolean) => void;
  /**
   * 入れ先の操作の番号。渡すと、送り始めに番号を進め、届いたときに番号がそのままのときだけ onUploaded を呼ぶ。
   * 入れ先をほかの部品も書き換えるなら必ず渡す (足すだけで取り合いのない追加画像は渡さない)。
   */
  operation?: ImageOperationCounter;
  /** 前処理の長辺 (渡さなければ用途の長辺 IMAGE_MAX_EDGE)。同じ用途で大きさだけ違う欄 (店のアイコンとカバー) が渡す。 */
  maxEdge?: number;
};

/**
 * アップロード中の欄の集まり (key は呼び元が決める・1 つでもあれば busy)。親が持ち、各欄の onBusyChange から同期に更新する
 * (送り始めのイベントの中で知らせる = その描画の確定で、親の保存・公開のボタンも止まっている)。
 * key には欄を作り直すたびに変わる値 (切り替えの世代など) を入れる: 作り直す前の欄の後片づけ (unmount の false) が、作り直した
 * 欄の送信中の印を消さないように。
 */
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
  return { busy: keys.size > 0, keys, setBusy };
}

/**
 * 欄ごとの操作の番号 (key → ImageOperationCounter・中身は持たない) と、その失効。
 * - scope (画像の欄を出すか・本人) が替わったら、描画の前 (layout effect) に全部の欄の番号を進める: 切り替わる前に始まった
 *   アップロードの結果を入れない。layout にするのは、切り替えの後に出た欄で始めた新しい送信が、後から走る effect に番号を
 *   進められて捨てられないように (components/creator-store-seller/ProductEditorSection の表紙と同じ型)。
 * - この hook を持つ部品が外れる (シートを閉じる) ときも、同じく描画の確定の中で全部の番号を進める (欄の unmount の後片づけ =
 *   effect より前に届いた結果を入れない)。
 */
export function useImageFieldOperations(scope: string) {
  const operations = useRef(new Map<string, ImageOperationCounter>());
  const operation = useCallback((key: string): ImageOperationCounter => {
    let counter = operations.current.get(key);
    if (!counter) {
      counter = { current: 0 };
      operations.current.set(key, counter);
    }
    return counter;
  }, []);
  /** その欄の操作 (手入力・外す・行の削除・追加の後の片づけ) の前に、同期的に呼ぶ。 */
  const advance = useCallback((key: string) => nextImageOperation(operation(key)), [operation]);
  /** 全部の欄を書き換える操作 (公開中の店の読み込み) の前に、同期的に呼ぶ。 */
  const advanceAll = useCallback(() => {
    for (const counter of operations.current.values()) nextImageOperation(counter);
  }, []);
  const scopeSeen = useRef(scope);
  useLayoutEffect(() => {
    if (scopeSeen.current === scope) return;
    scopeSeen.current = scope;
    advanceAll();
  }, [scope, advanceAll]);
  useLayoutEffect(() => () => advanceAll(), [advanceAll]);
  return { operation, advance, advanceAll };
}

/** 画像の欄を出すか (/api/auth/siwe/me の imageUpload・imageUploadSignIn から)。 */
export type ImageUploadAccess = 'upload' | 'signIn' | 'off';

export type ImageUploadScope = {
  access: ImageUploadAccess;
  /** 画像の欄を出すか・本人 (セッションのアドレス) が替わったら変わる値 (useImageFieldOperations の scope・欄の key)。 */
  key: string;
};

export const IMAGE_UPLOAD_OFF: ImageUploadScope = { access: 'off', key: 'off' };

/**
 * useSiweSession の値から、画像の欄を出すかを決める (純関数)。
 * - upload: サインイン済み (セッションが接続中の wallet と一致) で /me の imageUpload が true (useSiweSession は今の取得が成功
 *   しているときだけ true にする)。
 * - signIn: サインインしていなくて /me の imageUploadSignIn が true (「サインインすると画像をアップロードできます」の 1 行と今の
 *   URL の欄)。
 * - off: それ以外 (段階 off・設定が無い・/me の取得の失敗・読み込み中) は今の画面のまま。
 */
export function imageUploadScopeOf(session: {
  isSignedIn: boolean;
  sessionAddress: string | null;
  imageUpload?: boolean;
  imageUploadSignIn?: boolean;
}): ImageUploadScope {
  if (session.isSignedIn && session.imageUpload === true && session.sessionAddress) {
    return { access: 'upload', key: `upload:${session.sessionAddress.toLowerCase()}` };
  }
  if (!session.isSignedIn && session.imageUploadSignIn === true) return { access: 'signIn', key: 'signIn' };
  return IMAGE_UPLOAD_OFF;
}

export type ImageUploadState = {
  busy: boolean;
  error: ImageUploadFailure | null;
  upload: (file: Blob) => Promise<void>;
  cancel: () => void;
  /** 失敗の文だけを消す (送っている途中には触れない)。 */
  clearError: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

export function useImageUpload({
  purpose,
  onUploaded,
  onBusyChange,
  operation,
  maxEdge,
}: UseImageUploadOptions): ImageUploadState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ImageUploadFailure | null>(null);
  // 送るたび・取り消すたびに増やす。応答が届いたとき値が変わっていれば、その応答は古い (捨てる)。
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  // state の反映 (ボタンの無効化) より先に、同じ tick の 2 回目を止める。
  const inFlight = useRef(false);
  const callbacks = useRef({ onUploaded, onBusyChange });
  useEffect(() => {
    callbacks.current = { onUploaded, onBusyChange };
  });

  useEffect(
    () => () => {
      request.current += 1;
      controller.current?.abort();
      controller.current = null;
      inFlight.current = false;
      callbacks.current.onBusyChange?.(false);
    },
    [],
  );

  // 送っている途中を取り消し、失敗の文も消す (やめる・外す・URL を書き換えたとき)。
  const cancel = useCallback(() => {
    request.current += 1;
    controller.current?.abort();
    controller.current = null;
    inFlight.current = false;
    setBusy(false);
    setError(null);
    callbacks.current.onBusyChange?.(false);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const upload = useCallback(
    async (file: Blob) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const id = ++request.current;
      const abort = new AbortController();
      controller.current = abort;
      // このアップロードが、入れ先の最後の操作になる (前に始まったほかのアップロードの結果は入らなくなる)。
      const startedAs = operation ? nextImageOperation(operation) : null;
      setBusy(true);
      setError(null);
      // 親 (保存・公開のボタン) へは同じイベントの中で知らせる (この描画の確定で、ボタンも止まっている)。
      callbacks.current.onBusyChange?.(true);
      const result =
        maxEdge === undefined
          ? await uploadImageFile(file, purpose, abort.signal)
          : await uploadImageFile(file, purpose, abort.signal, maxEdge);
      if (id !== request.current) return;
      inFlight.current = false;
      controller.current = null;
      flushSync(() => {
        setBusy(false);
        callbacks.current.onBusyChange?.(false);
        // 送っている間にほかの操作が番号を進めていたら、その操作を残す (後から届いた画像で上書きしない)。もう最後の操作では
        // ないので、失敗の文も出さない。
        if (operation && operation.current !== startedAs) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        callbacks.current.onUploaded(result.url);
      });
    },
    [purpose, operation, maxEdge],
  );

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // 同じ file を選び直しても change が来るように空にする (file は上で取り出し済み)。
      event.target.value = '';
      if (file) void upload(file);
    },
    [upload],
  );

  return { busy, error, upload, cancel, clearError, onFileChange };
}
