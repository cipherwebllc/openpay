'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { ImagePurpose } from '@/lib/images/purpose';
import { uploadImageFile, type ImageUploadFailure } from '@/lib/images/uploadClient';

// 画像の欄 (components/ImageField.tsx) と Store の追加画像の「画像を追加」が共有する、アップロードの状態。
// - 1 度に 1 枚だけ送る (送っている間の 2 回目は送らない = 二重送信の防ぎ)。
// - 取消 (cancel)・unmount の後に届いた古い応答は捨てる (フォームの値を上書きしない)。
// - busy を親へ知らせる (親はアップロード中の保存を止める)。unmount でも false を知らせる。
// - 失敗は code を返すだけ: 元の値は呼び元が持ったまま (onUploaded は成功のときだけ呼ぶ)。

export type UseImageUploadOptions = {
  purpose: ImagePurpose;
  onUploaded: (url: string) => void;
  onBusyChange?: (busy: boolean) => void;
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

export function useImageUpload({ purpose, onUploaded, onBusyChange }: UseImageUploadOptions): ImageUploadState {
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
      setBusy(true);
      setError(null);
      const result = await uploadImageFile(file, purpose, abort.signal);
      if (id !== request.current) return;
      inFlight.current = false;
      controller.current = null;
      setBusy(false);
      if (result.ok) callbacks.current.onUploaded(result.url);
      else setError(result.error);
    },
    [purpose],
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
