'use client';

import { useState } from 'react';

export const COPIED_FEEDBACK_MS = 1500;

/**
 * `navigator.clipboard.writeText` をラップし、コピー直後 `feedbackMs` 間
 * `copied=true` を返す。HTTPS/localhost 外で `clipboard` が無い環境では
 * `available=false` となり、UI 側で graceful degrade に振る (button にしない等)。
 */
export function useCopyToClipboard(feedbackMs: number = COPIED_FEEDBACK_MS): {
  copied: boolean;
  available: boolean;
  copy: (value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const available =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined';

  async function copy(value: string) {
    if (!available || !value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), feedbackMs);
  }

  return { copied, available, copy };
}
