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
  const [isStandalone, setIsStandalone] = useState<boolean>(readStandalone);

  useEffect(() => {
    const mql = window.matchMedia('(display-mode: standalone)');
    const handler = () => setIsStandalone(readStandalone());
    mql.addEventListener('change', handler);
    // mount 後にも 1 度同期 (SSR/hydration 間で値が確定するレースを潰す)。
    handler();
    return () => mql.removeEventListener('change', handler);
  }, []);

  return { isStandalone };
}
