'use client';

import { useEffect, useRef } from 'react';
import { useSwitchChain } from 'wagmi';

/**
 * URL 指定の chain と wallet が乖離していたら初回 1 回だけ自動切替を試みる。
 * 拒否や手動で別 chain に戻した場合に popup ループしないよう requiredChainId 単位で gate。
 */
export function useAutoSwitchChain(
  requiredChainId: number,
  wrongChain: boolean,
): void {
  const { switchChain, isPending } = useSwitchChain();
  const autoSwitchedTo = useRef<number | null>(null);
  useEffect(() => {
    if (
      wrongChain &&
      !isPending &&
      autoSwitchedTo.current !== requiredChainId
    ) {
      autoSwitchedTo.current = requiredChainId;
      switchChain({ chainId: requiredChainId });
    }
  }, [wrongChain, isPending, switchChain, requiredChainId]);
}
