import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// テスト通知 route: 自分宛て・SIWE 必須・1 分 1 回・flag OFF 404。
// mock 戦略は push-subscribe.test.ts と同型 (hoisted holder)。

const SESSION_ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enablePushNotify: true,
  sessionOk: true,
  rateAllowed: true,
  summary: { attempted: 1, sent: 1, pruned: 0, failed: 0 },
}));

vi.mock('@/lib/env', () => ({
  env: {
    get enablePushNotify() {
      return hold.enablePushNotify;
    },
  },
}));

vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: () =>
    Promise.resolve(
      hold.sessionOk
        ? { ok: true, address: SESSION_ADDR }
        : {
            ok: false,
            response: NextResponse.json(
              { ok: false, error: 'unauthenticated' },
              { status: 401 },
            ),
          },
    ),
}));

const rateSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/relay/relayGuards', () => ({
  checkReadRateLimit: (...args: unknown[]) => {
    rateSpy(...args);
    return Promise.resolve(hold.rateAllowed);
  },
}));

vi.mock('@/lib/relay/relayRoute', () => ({
  anonymizeIp: () => 'ip-prefix',
}));

const sendSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/push/server', () => ({
  sendPushToWallet: (...args: unknown[]) => {
    sendSpy(...args);
    return Promise.resolve(hold.summary);
  },
}));

import { POST } from '@/app/api/push/test/route';

function req(): Request {
  return new Request('http://localhost/api/push/test', { method: 'POST' });
}

beforeEach(() => {
  hold.enablePushNotify = true;
  hold.sessionOk = true;
  hold.rateAllowed = true;
  hold.summary = { attempted: 1, sent: 1, pruned: 0, failed: 0 };
  rateSpy.mockClear();
  sendSpy.mockClear();
});

describe('POST /api/push/test', () => {
  it('flag OFF → 404 (inert)', async () => {
    hold.enablePushNotify = false;
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('未サインイン → 401 (session response 透過)', async () => {
    hold.sessionOk = false;
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('rate limit 超過 → 429 (1 分 1 回)', async () => {
    hold.rateAllowed = false;
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(sendSpy).not.toHaveBeenCalled();
    // key は wallet(lower)+ip・limit 1/60s
    expect(rateSpy).toHaveBeenCalledWith(
      `pushtest:${SESSION_ADDR.toLowerCase()}:ip-prefix`,
      1,
      60,
    );
  });

  it('成功 → session の address 宛てに送信し summary を返す', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; sent: number };
    expect(json.ok).toBe(true);
    expect(json.sent).toBe(1);
    // 宛先は body 等でなく session address のみ (他人へのテスト送信不可)
    expect(sendSpy.mock.calls[0][0]).toBe(SESSION_ADDR);
    // locale resolver が ja/en のテスト文言を返す
    const resolver = sendSpy.mock.calls[0][1] as (l: string) => {
      title: string;
    };
    expect(resolver('ja').title).toBe('テスト通知');
    expect(resolver('en').title).toBe('Test notification');
  });

  it('購読 0 件 (attempted=0) → 404 no_subscription', async () => {
    hold.summary = { attempted: 0, sent: 0, pruned: 0, failed: 0 };
    const res = await POST(req());
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('no_subscription');
  });
});
