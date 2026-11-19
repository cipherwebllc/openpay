'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { ImagePurpose } from '@/lib/images/purpose';
import { uploadImageFile, type ImageUploadFailure } from '@/lib/images/uploadClient';

// 画像の欄 (components/ImageField.tsx) と Store の追加画像の「画像を追加」が共有する、アップロードの状態。
// - 1 度に 1 枚だけ送る (送っている間の 2 回目は送らない = 二重送信の防ぎ)。
// - 取消 (cancel)・unmount の後に届いた古い応答は捨てる (フォームの値を上書きしない)。
// - busy を親へ知らせる (親はアップロード中の保存を止める)。unmount でも false を知らせる。
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
};

export type ImageUploadState = {
  busy: boolean;
  error: ImageUploadFailure | null;
  upload: (file: Blob) => Promise<void>;
  cancel: () => void;
  /** 失敗の文だけを消す (送っている途中には触れない)。 */
  clearError: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

export function useImageUpload({ purpose, onUploaded, onBusyChange, operation }: UseImageUploadOptions): ImageUploadState {
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

  useEffect(() => {
    callbacks.current.onBusyChange?.(busy);
  }, [busy]);

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
      const result = await uploadImageFile(file, purpose, abort.signal);
      if (id !== request.current) return;
      inFlight.current = false;
      controller.current = null;
      setBusy(false);
      // 送っている間にほかの操作が番号を進めていたら、その操作を残す (後から届いた画像で上書きしない)。もう最後の操作では
      // ないので、失敗の文も出さない。
      if (operation && operation.current !== startedAs) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      callbacks.current.onUploaded(result.url);
    },
    [purpose, operation],
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
