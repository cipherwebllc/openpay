'use client';

// wagmi connectors のうち、実際に provider を持つもの (injected で provider 不在の
// connector を除外) + 同名 connector の dedup を返す。ConnectButton.tsx と
// WalletBadge.tsx が共通して使う。

import { useEffect, useState } from 'react';
import type { Connector } from 'wagmi';
import { logger } from '@/lib/logger';

export function useVisibleConnectors(raw: readonly Connector[]): Connector[] {
  const [visible, setVisible] = useState<Connector[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    async function probe() {
      const accepted: Connector[] = [];
      const seen = new Set<string>();
      for (const c of raw) {
        if (ctrl.signal.aborted) return;
        if (c.type === 'injected') {
          try {
            const p = await c.getProvider();
            if (!p) continue;
          } catch (err) {
            logger.debug('connector.provider_unavailable', { name: c.name, err });
            continue;
          }
        }
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        accepted.push(c);
      }
      if (!ctrl.signal.aborted) setVisible(accepted);
    }
    probe();
    return () => ctrl.abort();
  }, [raw]);

  return visible;
}
