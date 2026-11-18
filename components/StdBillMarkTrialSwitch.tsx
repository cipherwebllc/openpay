'use client';

// マイページの「その端末だけの試しのスイッチ」(K4b・通常決済の送金に会計の印を付ける・lib/stdBillMarkTrial.ts)。
// マイページを `?stdmark=on` で開くと ON・`?stdmark=off` で OFF にする (ほかの値・無いときは変えない)。ON の間だけ 1 行を出す
// (運営者が、試している端末だと分かるように)。スイッチを書くのはこの部品だけ (支払いの画面は読むだけ)。
// URL は mount の後に window.location から読む (useSearchParams を使わない = /me の静的な描画のまま・Suspense の境界を足さない)。
// 文は server (app/[locale]/me/page.tsx) が渡す (client の messages を増やさない)。

import { useEffect, useState } from 'react';
import { STD_BILL_MARK_TRIAL_KEY, isStdBillMarkTrialOn } from '@/lib/stdBillMarkTrial';

export function StdBillMarkTrialSwitch({ label }: { label: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('stdmark');
    try {
      if (value === 'on') window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, '1');
      else if (value === 'off') window.localStorage.removeItem(STD_BILL_MARK_TRIAL_KEY);
    } catch {
      // 断つ波及 (掟 13): 保存の使えないブラウザで、マイページが止まること。保存できなければ OFF のまま (下の読みも OFF)。
    }
    setOn(isStdBillMarkTrialOn());
  }, []);
  if (!on) return null;
  return (
    <p className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
      {label}
    </p>
  );
}
