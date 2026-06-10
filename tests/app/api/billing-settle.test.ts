import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

const JPYC = 10n ** 18n;

const hold = vi.hoisted(() => ({
  enableBilling: true,
  feeReceiverConfigured: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  meterCount: 10,
  meterVolume: 10_000n * 10n ** 18n, // 10,000 JPYC 出来高
  verify: { ok: true } as { ok: true } | { ok: false; reason: string },
  verifyThrows: false,
  grantOk: true,
  markOk: true,
  kvSetValue: 'OK' as 'OK' | null,
  kvSetOk: true,
  kvGetValue: 'pending' as string | null,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      get enableBilling() {
        return hold.enableBilling;
      },
      get enableUsageFee() {
        return hold.enableBilling;
      },
      get feeReceiverConfigured() {
        return hold.feeReceiverConfigured;
      },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    hold.session.ok
      ? hold.session
      : {
          ok: false,
          response: NextResponse.json(
            { ok: false, error: 'unauthenticated' },
            { status: 401 },
          ),
        },
}));
vi.mock('@/lib/feeVerify', () => ({
  verifyJpycFeeOnChain: vi.fn(async () => {
    if (hold.verifyThrows) throw new Error('rpc down');
    return hold.verify;
  }),
}));
// インボイスは loadUsageInvoice (export) を差し替えて制御する (route はこの export を直接 import)。
// feeWei = 出来高 × 1% を mock 内で再現し、0 で nothingDue を起こす。
vi.mock('@/lib/billingMeter', () => ({
  loadUsageInvoice: async (period: string) => {
    const feeWei = hold.meterVolume / 100n; // 1%
    return {
      period,
      count: hold.meterCount,
      volumeWei: hold.meterVolume,
      rateBps: feeWei === 0n ? 0 : 100,
      feeWei,
      free: feeWei === 0n,
    };
  },
}));
const grantSpy = vi.hoisted(() => vi.fn());
const markSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/feeCurrent', () => ({
  isFeeCurrent: async () => false,
  grantFeeCurrent: (...args: unknown[]) => {
    grantSpy(...args);
    return Promise.resolve({ ok: hold.grantOk, expiresAt: 999_000 });
  },
  markPeriodPaid: (...args: unknown[]) => {
    markSpy(...args);
    return Promise.resolve({ ok: hold.markOk });
  },
}));
const kvSetSpy = vi.hoisted(() => vi.fn());
const kvDelSpy = vi.hoisted(() => vi.fn());
const kvGetSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  kvSet: (...args: unknown[]) => {
    kvSetSpy(...args);
    return Promise.resolve(
      hold.kvSetOk
        ? { ok: true, value: hold.kvSetValue }
        : { ok: false, reason: 'unconfigured' },
    );
  },
  kvGet: (...args: unknown[]) => {
    kvGetSpy(...args);
    return Promise.resolve({ ok: true, value: hold.kvGetValue });
  },
  kvDel: (...args: unknown[]) => {
    kvDelSpy(...args);
    return Promise.resolve({ ok: true, value: 1 });
  },
}));

import { POST } from '@/app/api/billing/settle/route';
import { previousPeriod, owedCandidatePeriods } from '@/lib/feeGate';

const TXHASH = `0x${'1'.repeat(64)}`;
const AMOY = 80002;
// テスト基準時刻。lookback の範囲検証を実時刻に依存させないため固定する。
const NOW = Date.UTC(2026, 6, 15); // 2026-07-15 → previousPeriod = 2026-06

function req(body: unknown): Request {
  return new Request('http://localhost/api/billing/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW); // route 内の Date.now() を固定 (period 範囲検証を決定的に)
  hold.enableBilling = true;
  hold.feeReceiverConfigured = true;
  hold.session = { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' };
  hold.meterCount = 10;
  hold.meterVolume = 10_000n * JPYC;
  hold.verify = { ok: true };
  hold.verifyThrows = false;
  hold.grantOk = true;
  hold.markOk = true;
  hold.kvSetValue = 'OK';
  hold.kvSetOk = true;
  hold.kvGetValue = 'pending';
  // lookback 内のどの期間も選べるよう、十分古い startPeriod を点灯する。
  process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2025-01';
  grantSpy.mockClear();
  markSpy.mockClear();
  kvSetSpy.mockClear();
  kvGetSpy.mockClear();
  kvDelSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
});

describe('POST /api/billing/settle', () => {
  it('billing OFF → 404', async () => {
    hold.enableBilling = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(404);
  });

  it('FEE_RECEIVER 未設定 → 503・付与しない', async () => {
    hold.feeReceiverConfigured = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(401);
  });

  it('請求 0 (前月出来高 0) → nothingDue・付与もロックもしない (P1: 0円期間で current を得る余地なし)', async () => {
    hold.meterVolume = 0n;
    hold.meterCount = 0;
    const res = await POST(req({ chainId: AMOY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, nothingDue: true, feeWei: '0' });
    expect(grantSpy).not.toHaveBeenCalled();
    expect(kvSetSpy).not.toHaveBeenCalled();
  });

  it('正常: 出来高 1% を検証→決定的 expiry で fee-current 付与', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, expiresAt: 999_000 });
    expect(json.feeWei).toBe((100n * JPYC).toString()); // 10,000 × 1%
    expect(json.period).toMatch(/^\d{4}-\d{2}$/);
    // grant は txHash + 決定的 expiresAt(number) 付き。
    expect(grantSpy).toHaveBeenCalledWith(
      hold.session.ok ? hold.session.address : '',
      expect.objectContaining({ txHash: TXHASH, expiresAt: expect.any(Number) }),
    );
  });

  it('請求ありで txHash 無し → 400', async () => {
    const res = await POST(req({ chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_txhash' });
  });

  it('検証失敗 (amount_too_low) → 422・ロック解放', async () => {
    hold.verify = { ok: false, reason: 'amount_too_low' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'amount_too_low' });
    expect(kvDelSpy).toHaveBeenCalled();
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('RPC エラー → 503・ロック解放', async () => {
    hold.verify = { ok: false, reason: 'rpc_error' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(kvDelSpy).toHaveBeenCalled();
  });

  it('同 txHash 再提出 (確定済) → replay・再付与しない', async () => {
    hold.kvSetValue = null;
    hold.kvGetValue = `r:${JSON.stringify({ period: '2026-05', expiresAt: 777_000 })}`;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, replay: true, expiresAt: 777_000 });
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('処理中 (ロックのみ) → 409', async () => {
    hold.kvSetValue = null;
    hold.kvGetValue = 'pending';
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(409);
  });

  it('付与の KV 書込失敗 → 503・ロック解放', async () => {
    hold.grantOk = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'grant_failed' });
    expect(kvDelSpy).toHaveBeenCalled();
  });

  it('verify が想定外 throw → 503・ロック解放', async () => {
    hold.verifyThrows = true;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(kvDelSpy).toHaveBeenCalled();
  });

  // --- 無効入力 / エラーハンドリング ---
  it('不正な JSON body → 400 invalid_json', async () => {
    const bad = new Request('http://localhost/api/billing/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('chainId 非整数 → 400 invalid_chain', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_chain' });
  });

  it('未対応チェーン → 400 unsupported_chain', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: 999999 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unsupported_chain' });
  });

  it('請求ありで txHash の形式不正 (短い) → 400 invalid_txhash', async () => {
    const res = await POST(req({ txHash: '0xabc', chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_txhash' });
  });

  it('正常: 成功時に markPeriodPaid を grant の後・promote の前に呼ぶ (前月)', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    expect(grantSpy).toHaveBeenCalled();
    expect(markSpy).toHaveBeenCalledWith(
      hold.session.ok ? hold.session.address : '',
      previousPeriod(NOW),
      TXHASH,
    );
  });

  // --- period 引数 (古い期間の遡及清算) ---
  describe('period 引数 (古い未収の遡及清算)', () => {
    it('古い期間指定 → マーカー記録・current は付与されない (expiresAt が過去)', async () => {
      const oldPeriod = '2026-03'; // lookback 内・前月 (2026-06) より古い
      const res = await POST(
        req({ txHash: TXHASH, chainId: AMOY, period: oldPeriod }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.period).toBe(oldPeriod);
      // マーカーは指定期間で記録される。
      expect(markSpy).toHaveBeenCalledWith(
        hold.session.ok ? hold.session.address : '',
        oldPeriod,
        TXHASH,
      );
      // grant は指定期間の決定的満了 = 2026-03 の 2 か月後月初 + 猶予 → NOW (2026-07-15) より過去。
      // = 現行カバレッジは買えない (古い債務の清算であって current 購入ではない)。
      const grantArgs = grantSpy.mock.calls[0][1] as { expiresAt: number };
      expect(grantArgs.expiresAt).toBeLessThan(NOW);
    });

    it('未指定は従来どおり前月で清算 (後方互換)', async () => {
      const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.period).toBe(previousPeriod(NOW));
    });

    it('period が未来 → 400 period_out_of_range', async () => {
      const res = await POST(
        req({ txHash: TXHASH, chainId: AMOY, period: '2026-07' }), // 当月 (未閉)
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'period_out_of_range' });
      expect(grantSpy).not.toHaveBeenCalled();
    });

    it('period が startPeriod より古い → 400 period_out_of_range', async () => {
      const res = await POST(
        req({ txHash: TXHASH, chainId: AMOY, period: '2024-12' }), // start=2025-01 より前
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'period_out_of_range' });
    });

    it('period が 12 か月 lookback より古い → 400 period_out_of_range', async () => {
      // startPeriod を十分古くしても lookback (12 か月) が下限を抑える。
      process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2020-01';
      const candidates = owedCandidatePeriods(NOW, '2020-01');
      const tooOld = '2025-06'; // candidates 最古 (2025-07) より 1 か月古い
      expect(candidates).not.toContain(tooOld);
      const res = await POST(
        req({ txHash: TXHASH, chainId: AMOY, period: tooOld }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'period_out_of_range' });
    });

    it('period の形式不正 (YYYY-M) → 400 period_out_of_range', async () => {
      const res = await POST(
        req({ txHash: TXHASH, chainId: AMOY, period: '2026-3' }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'period_out_of_range' });
    });

    it('markPeriodPaid 失敗 → 503・ロック解放 (同 txHash 再試行可)', async () => {
      hold.markOk = false;
      const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'grant_failed' });
      expect(kvDelSpy).toHaveBeenCalled(); // releaseClaim
    });
  });
});
