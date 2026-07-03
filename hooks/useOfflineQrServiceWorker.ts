'use client';

// flag ON の /create 訪問で Service Worker ('/sw.js') を登録し、SW 側に offline-enable
// マーカー (専用 Cache Storage の合成レスポンス) を書かせる。これで SW の fetch handler が
// narrow なパターンに限って介入するようになる (マーカー不在 = 完全素通し)。
//
// flag OFF のときは **登録しない**。既存の登録 (PushNotifyPanel が張った同一 '/sw.js') が
// あれば disable message を送ってマーカーを消す — これで push だけ使う利用者に fetch 介入が
// 残らない。登録が無ければ何もしない (no-op)。
//
// push (PushNotifyPanel) と同一 script ゆえ register は冪等・衝突しない。

import { useEffect } from 'react';
import { env } from '@/lib/env';

export function useOfflineQrServiceWorker(): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const sw = navigator.serviceWorker;

    if (!env.enableOfflineQr) {
      // flag OFF: 既存登録があれば marker を消す。未登録なら getRegistration() は
      // undefined を返し no-op。register は絶対にしない (SW を新設しない)。
      void sw
        .getRegistration()
        .then((reg) => {
          reg?.active?.postMessage({ type: 'openpay:offline-disable' });
        })
        .catch(() => undefined);
      return;
    }

    // flag ON: 登録 (冪等) → active worker に enable marker を書かせる。初回 install 直後は
    // reg.active が null のことがあるため sw.ready で active を待ってからも送る。
    let cancelled = false;
    void sw
      .register('/sw.js')
      .then((reg) => {
        if (cancelled) return undefined;
        reg.active?.postMessage({ type: 'openpay:offline-enable' });
        return sw.ready.then((ready) => {
          if (!cancelled) {
            ready.active?.postMessage({ type: 'openpay:offline-enable' });
          }
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);
}
