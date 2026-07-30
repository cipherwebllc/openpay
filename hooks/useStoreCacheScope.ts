'use client';

// creator store の React Query cache ('store' 配下) を、wallet / SIWE セッションの
// 切替時に即時破棄する store 専用 hook。query key は sessionAddress を含むため
// 別アドレスのデータが描画されることはないが、購入済み本文 (content value) を
// 旧アドレスのままメモリに残さないための防御。
//
// useSiweSession には入れない: あちらは /pay 等の決済ページも読む共有 hook で、
// store 専用の cache 破棄を足すと無関係ページの bundle と挙動に波及する
// (実害: /pay が bundle 予算 436kB を超過)。store の UI surface だけが mount する。

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';

const STORE_KEY = ['store'] as const;

/**
 * 接続中 wallet アドレスと SIWE セッションアドレスのどちらかが変わった時点で
 * removeQueries(['store']) する。初回 mount では消さない (購入 modal の追加 mount 等が
 * 進行中の cache を壊さないため)。
 */
export function useStoreCacheScope(sessionAddress: string | null): void {
  const { address } = useAccount();
  const qc = useQueryClient();
  const scope = `${address?.toLowerCase() ?? 'none'}|${
    sessionAddress?.toLowerCase() ?? 'none'
  }`;
  const scopeRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (scopeRef.current === undefined) {
      scopeRef.current = scope;
      return;
    }
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    qc.removeQueries({ queryKey: STORE_KEY });
  }, [scope, qc]);
}
