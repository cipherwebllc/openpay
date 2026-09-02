'use client';

import { useEffect, useRef, useState } from 'react';

export const COPIED_FEEDBACK_MS = 1500;

/**
 * `navigator.clipboard.writeText` をラップし、コピー直後 `feedbackMs` 間
 * `copied=true` を返す。HTTPS/localhost 外で `clipboard` が無い環境では
 * `available=false` となり、UI 側で graceful degrade に振る (button にしない等)。
 *
 * `copy` は成否を boolean で返す (失敗時は `copied` を立てない)。
 */
export function useCopyToClipboard(feedbackMs: number = COPIED_FEEDBACK_MS): {
  copied: boolean;
  available: boolean;
  copy: (value: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const available =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined';

  // unmount 後に setCopied が走らない (かつ timer が残らない) よう後始末する。
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  async function copy(value: string): Promise<boolean> {
    if (!available || !value) return false;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // ブラウザ API の失敗 (権限拒否・非フォーカス document 等) を呼び出し元の
      // UI へ波及させない。unhandled rejection を出さず false を返し、
      // 「コピーしました」表示も出さない (偽成功を作らない)。
      return false;
    }
    setCopied(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, feedbackMs);
    return true;
  }

  return { copied, available, copy };
}
