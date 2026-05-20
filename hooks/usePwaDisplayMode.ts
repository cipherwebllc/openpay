'use client';

// PWA が standalone (home screen からの起動) で動作しているかを reactive に判定。
//
// 用途: 「ホーム画面に追加してください」hint の表示制御。standalone なら hint は
// 邪魔なので非表示。display-mode change は app 内で発火し得る (PWA install 直後
// など) ため listener を貼っておく。
//
// 互換性: matchMedia('(display-mode: standalone)') は Safari 13+ / Chromium で
// PWA 実装。古い iOS は navigator.standalone (vendor-prefixed) を持つので OR 判定。

import { useEffect, useState } from 'react';

function readStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

export function usePwaDisplayMode(): { isStandalone: boolean } {
  // SSR と client first hydration render の両方で false を返す stable な初期値。
  // useState(readStandalone) の lazy init を使うと SSR は false (window 不在)、
  // client hydration 時は matchMedia/navigator.standalone から true を返してしまい、
  // SSR HTML には PwaInstallHint が描画されているのに client は即 null を返す
  // React hydration mismatch を /scan の PWA standalone 起動 path で発生させていた
  // (GPT-5.5 review で発覚)。実 PWA install 利用者の hint 表示制御が壊れる本物
  // バグなので useEffect で hydrate 後に setIsStandalone する SSR-safe pattern に変更。
  const [isStandalone, setIsStandalone] = useState<boolean>(false);

  useEffect(() => {
    const mql = window.matchMedia('(display-mode: standalone)');
    const handler = () => setIsStandalone(readStandalone());
    mql.addEventListener('change', handler);
    handler(); // hydrate 後に真の値へ更新 (上記初期値は SSR 一致のため意図的に false)
    return () => mql.removeEventListener('change', handler);
  }, []);

  return { isStandalone };
}
