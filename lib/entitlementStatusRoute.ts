// 期限付き利用権の status route 共通シェル。flag / 設定確認を認証より先に行い、
// 認証成功後だけ利用権ストアを読む順序を全 entitlement で揃える。

import { NextResponse } from 'next/server';
import type { Address } from 'viem';
import { requireSession } from '@/app/api/auth/siwe/_session';

type EntitlementStatusRouteConfig<TStatus> = {
  enabled: () => boolean;
  disabledError: string;
  configured: () => boolean;
  misconfiguredError: string;
  getStatus: (wallet: Address) => Promise<TStatus>;
  mapResult: (status: TStatus) => Record<string, unknown>;
};

export async function handleEntitlementStatus<TStatus>({
  enabled,
  disabledError,
  configured,
  misconfiguredError,
  getStatus,
  mapResult,
}: EntitlementStatusRouteConfig<TStatus>): Promise<NextResponse> {
  if (!enabled()) {
    return NextResponse.json(
      { ok: false, error: disabledError },
      { status: 404 },
    );
  }
  if (!configured()) {
    return NextResponse.json(
      { ok: false, error: misconfiguredError },
      { status: 503 },
    );
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  const status = await getStatus(session.address);
  return NextResponse.json({ ok: true, ...mapResult(status) });
}
