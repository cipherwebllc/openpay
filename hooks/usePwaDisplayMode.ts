'use client';

// PWA が standalone (home screen からの起動) で動作しているかを reactive に判定。
//
// 用途: 「ホーム画面に追加してください」hint の表示制御。standalone なら hint は
// 邪魔なので非表示にする。display-mode change イベントは PWA を install してから
// app 内で発火し得るため (rare だが) listener を貼っておく。
//
// 互換性:
//   - matchMedia('(display-mode: standalone)') は iOS Safari / Chromium で
//     PWA 実装。Safari 13+ で利用可能。
//   - 古い iOS は navigator.standalone (vendor-prefixed) を持つので OR で判定する。
//
// SSR 安全性: window が無い (SSR) 環境では false を返す。初期 render では
// 'use client' でも server で 1 度走るため、useState の初期値は SSR-safe な
// closure を渡す。

import { useEffect, useState } from 'react';

function readStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  // iOS Safari の vendor-prefixed プロパティ。Spec には無いため型 cast で読む。
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

export function usePwaDisplayMode(): { isStandalone: boolean } {
  const [isStandalone, setIsStandalone] = useState<boolean>(() =>
    readStandalone(),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(display-mode: standalone)');
    const handler = () => setIsStandalone(readStandalone());
    // addEventListener は Safari 14+。古い iOS は addListener しか無いが、
    // 動作対象が 16+ なので spec 準拠 API のみ使う。
    mql.addEventListener('change', handler);
    // mount 後にも 1 度同期 (state init とイベント発火のレースを潰す)。
    handler();
    return () => mql.removeEventListener('change', handler);
  }, []);

  return { isStandalone };
}
