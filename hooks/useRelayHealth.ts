'use client';

// B1 Layer B — JPYC ガスレス relayer の事前 (preflight) 健全性を /api/relay/jpyc/health から取る hook。
// /pay・/checkout の form が署名 *前* に呼び、degraded なら「通常決済へ切替」を先回り案内する。
//
// fail-OPEN: 読み込み中 / error 時は { degraded: false } を返す (健全扱い)。健全性 query の失敗で
// 利用者をガスレスから不必要に遠ざけないため。実 relayer 失敗は submit 時に Layer A が掴む。
// それゆえ retry:false (advisory・失敗は健全扱いで十分)。staleTime / refetchInterval は endpoint の
// server cache TTL (60s) と揃え、複数 form の poll が RPC を叩き続けないようにする。

import { useQuery } from '@tanstack/react-query';

export type RelayHealth = {
  degraded: boolean;
  reason?: string;
};

async function fetchRelayHealth(chainId: number): Promise<RelayHealth> {
  const res = await fetch(`/api/relay/jpyc/health?chainId=${chainId}`);
  // !res.ok は throw → React Query 側 isError → 呼出側は fail-open default を使う。
  if (!res.ok) {
    throw new Error(`relay health fetch failed: ${res.status}`);
  }
  const json = (await res.json()) as Partial<RelayHealth>;
  // shape 検証 (defense in depth)。degraded が boolean でなければ健全扱いに倒す。
  if (typeof json.degraded !== 'boolean') {
    return { degraded: false };
  }
  return {
    degraded: json.degraded,
    reason: typeof json.reason === 'string' ? json.reason : undefined,
  };
}

export function useRelayHealth({
  chainId,
  enabled,
}: {
  chainId: number;
  enabled: boolean;
}): RelayHealth {
  const query = useQuery({
    queryKey: ['relayHealth', chainId],
    queryFn: () => fetchRelayHealth(chainId),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  // fail-open: 成功した最新の読み取りがあるときだけ degraded を信用する。読み込み中 / error /
  // enabled:false (= relay 経路でない) では既定 { degraded:false } を返す。特に refetch が success
  // 後に error 化したとき、stale な degraded:true を残して preflight banner を誤って出し続けない
  // (Codex P1)。query.data ?? だと error 後も last success を保持してしまうため isSuccess で gate。
  return enabled && query.isSuccess && query.data
    ? query.data
    : { degraded: false };
}
