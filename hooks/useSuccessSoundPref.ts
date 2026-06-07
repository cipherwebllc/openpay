'use client';

import { useCallback, useEffect, useState } from 'react';
import { isSuccessSoundEnabled, setSuccessSoundEnabled } from '@/lib/soundPref';

// 決済完了音 ON/OFF を localStorage と同期する hook。トグル UI 表示用。
// hydration mismatch を避けるため初期値は既定 (true) 固定で、mount 後に
// 永続値を反映する (SuccessOverlay は成功後にしか出ないため実害はない)。
export function useSuccessSoundPref(): readonly [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setEnabled(isSuccessSoundEnabled());
  }, []);

  const set = useCallback((v: boolean) => {
    setEnabled(v);
    setSuccessSoundEnabled(v);
  }, []);

  return [enabled, set] as const;
}
