// lib/entitlementStatusRoute.ts の順序不変条件。
// このシェルの価値は「flag / 設定確認を認証より前に、利用権ストア読み出しを認証成功後に」
// 揃えることそのものなので、応答だけでなく **副作用の呼び出し順** を assert する。
// (flag OFF なのにセッションを引く = 未点灯機能の存在をセッション有無で漏らす、
//  認証前にストアを読む = 未認証者にストア I/O を踏ませる、のどちらも回帰させない。)

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

type SessionResult =
  | { ok: true; address: string }
  | { ok: false; response: unknown };

const hold = vi.hoisted(() => ({
  order: [] as string[],
  session: { ok: true, address: '0x' } as SessionResult,
}));

vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () => {
    hold.order.push('requireSession');
    return hold.session;
  },
}));

import { handleEntitlementStatus } from '@/lib/entitlementStatusRoute';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

function config(over: {
  enabled?: boolean;
  configured?: boolean;
} = {}) {
  return {
    enabled: () => {
      hold.order.push('enabled');
      return over.enabled ?? true;
    },
    disabledError: 'not_found',
    configured: () => {
      hold.order.push('configured');
      return over.configured ?? true;
    },
    misconfiguredError: 'misconfigured',
    getStatus: async (wallet: string) => {
      hold.order.push(`getStatus:${wallet}`);
      return { active: true } as const;
    },
    mapResult: (status: { active: boolean }) => ({ active: status.active }),
  };
}

beforeEach(() => {
  hold.order = [];
  hold.session = { ok: true, address: WALLET };
});

describe('handleEntitlementStatus', () => {
  it('flag OFF → 認証にもストアにも触れずに 404', async () => {
    const res = await handleEntitlementStatus(config({ enabled: false }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
    expect(hold.order).toEqual(['enabled']);
  });

  it('設定不備 → 認証前に 503 (未設定の存在は隠さないが認証は要求しない)', async () => {
    const res = await handleEntitlementStatus(config({ configured: false }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'misconfigured' });
    expect(hold.order).toEqual(['enabled', 'configured']);
  });

  it('未認証 → ストア読み出し前に 401 を素通しする', async () => {
    hold.session = {
      ok: false,
      response: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }),
    };

    const res = await handleEntitlementStatus(config());

    expect(res.status).toBe(401);
    expect(hold.order).toEqual(['enabled', 'configured', 'requireSession']);
  });

  it('全て通過して初めてストアをセッション wallet で読む', async () => {
    const res = await handleEntitlementStatus(config());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, active: true });
    expect(hold.order).toEqual([
      'enabled',
      'configured',
      'requireSession',
      `getStatus:${WALLET}`,
    ]);
  });
});
