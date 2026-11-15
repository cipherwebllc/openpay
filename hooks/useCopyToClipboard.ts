'use client';

import { useEffect, useRef, useState } from 'react';

export const COPIED_FEEDBACK_MS = 1500;

/**
 * `navigator.clipboard.writeText` をラップし、コピー直後 `feedbackMs` 間
 * `copied=true` を返す。HTTPS/localhost 外で `clipboard` が無い環境では
 * `available=false` となり、UI 側で graceful degrade に振る (button にしない等)。
 *
 * `copy` は成否を boolean で返す (失敗時は `copied` を立てない)。
 *
 * `resetOnAttempt` (既定 false): true にすると `copied` を最新の試行の結果に合わせる。試行を始めたら前の成功の
 * `copied` と timer を消し、その試行が成功して、かつ最新の試行のときだけ立てる (成功の直後に押し直して失敗したとき・
 * 試行が重なって古い方が後から成功したときに、前の「コピーしました」を出さない)。既定のままでは、押し直しても
 * 成功の表示を保つ (ボタンの名前を `copied` で切り替える部品で、成功 → 通常 → 成功 と名前を揺らさない)。
 */
export function useCopyToClipboard(
  feedbackMs: number = COPIED_FEEDBACK_MS,
  { resetOnAttempt = false }: { resetOnAttempt?: boolean } = {},
): {
  copied: boolean;
  available: boolean;
  copy: (value: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // mount 中か。書き込みの完了前に unmount したとき、後から timer を作ったり state を更新したりしないため。
  const mountedRef = useRef(false);
  // 何番目の試行か (resetOnAttempt のときだけ見る)。新しい試行が始まった後に完了した古い試行は、表示を変えない。
  const attemptRef = useRef(0);
  const available =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined';

  // unmount 後に setCopied が走らない (かつ timer が残らない) よう後始末する。
  // StrictMode の mount → unmount → mount でも、最後の mount で true に戻す。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  async function copy(value: string): Promise<boolean> {
    if (!available || !value) return false;
    const attempt = ++attemptRef.current;
    if (resetOnAttempt) {
      // 試行ごとに、前の成功の表示を消してから結果を待つ。消すのは押した時の更新、立てるのは書き込みの完了の後の
      // 別の更新なので、続けて成功しても copied は false → true と変わる (読み上げの欄の文を入れ直す)。
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      setCopied(false);
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // ブラウザ API の失敗 (権限拒否・非フォーカス document 等) を呼び出し元の
      // UI へ波及させない。unhandled rejection を出さず false を返し、
      // 「コピーしました」表示も出さない (偽成功を作らない)。
      return false;
    }
    // 書き込みの完了前に unmount した (画面を離れた) ときは、成功だけを返し、timer も state も作らない。
    if (!mountedRef.current) return true;
    // resetOnAttempt のとき、この試行の後に新しい試行が始まっていれば、成功だけを返し表示は新しい試行に任せる。
    if (resetOnAttempt && attempt !== attemptRef.current) return true;
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

/**
 * SSR される client component 用: `available` は server では常に false・ブラウザでは通常 true なので、
 * そのまま出し分けに使うと server の HTML と初回の client 描画が食い違い、hydration エラーになる
 * (React がツリーを client で作り直す)。mount までは「使える」前提 (圧倒的多数の環境) で server と同じ
 * 描画にし、mount 後に実際の値へ切り替える。mount 前のボタンはまだ操作できないので偽の操作面にはならない。
 */
export function useHydrationSafeAvailable(available: boolean): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted ? available : true;
}
