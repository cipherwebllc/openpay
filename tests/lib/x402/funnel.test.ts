// x402 購入ファネルの日次カウンタ (lib/x402/funnel.ts)。計測は付帯処理 — 失敗しても throw しない (掟 13)。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
const kv = vi.hoisted(() => ({ evalMock: vi.fn() }));
vi.mock('@/lib/kv', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv');
  return { ...actual, kvEval: kv.evalMock };
});
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  FUNNEL_STAGES,
  FUNNEL_CHALLENGE_SAMPLE_RATE,
  FUNNEL_TTL_SEC,
  funnelDay,
  funnelField,
  funnelKey,
  funnelResourcePath,
  recordFunnel,
  recordFunnelAfterResponse,
} from '@/lib/x402/funnel';

beforeEach(() => {
  kv.evalMock.mockReset();
  warn.mockReset();
  kv.evalMock.mockResolvedValue({ ok: true, value: 1 });
});

describe('x402 funnel counters', () => {
  it('key は UTC 日・field は stage|rail|pathname (query は落とす = field の種類を有界に)', () => {
    expect(funnelDay(Date.UTC(2026, 8, 17, 23, 59))).toBe('2026-09-17');
    expect(funnelKey('2026-09-17')).toBe('x402:funnel:2026-09-17');
    expect(funnelResourcePath('https://open-pay.jp/api/paid/usdc/jpyc/balance?address=0xabc&chain=polygon')).toBe(
      '/api/paid/usdc/jpyc/balance',
    );
    expect(funnelField('settled', 'arc-gateway', 'https://open-pay.jp/api/paid/hello')).toBe(
      'settled|arc-gateway|/api/paid/hello',
    );
    expect(funnelResourcePath('not a url')).toBe('not a url');
    expect(funnelResourcePath(`https://x.test/${'a'.repeat(300)}`).length).toBe(120);
  });

  it('stage の一覧は固定 (レポートの列と一致させる)', () => {
    expect(FUNNEL_STAGES).toEqual([
      'challenge',
      'invalid_payload',
      'verify_failed',
      'conflict',
      'content_error',
      'settle_failed',
      'facilitator_unavailable',
      'settled',
    ]);
  });

  it('recordFunnel: 1 EVAL で HINCRBY + 初回 TTL (180 日)・Lua に補間なし', async () => {
    await recordFunnel('settled', 'base', 'https://open-pay.jp/api/paid/hello');
    expect(kv.evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, args] = kv.evalMock.mock.calls[0];
    expect(script).toContain("redis.call('HINCRBY', KEYS[1], ARGV[1], tonumber(ARGV[3]))");
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], ARGV[2])");
    expect(script).not.toContain('${');
    expect(keys).toEqual([funnelKey(funnelDay())]);
    expect(args).toEqual(['settled|base|/api/paid/hello', String(FUNNEL_TTL_SEC), '1']);
  });

  it('challenge は 10 件に 1 件だけ記録して 10 を足す (KV 予算・期待値は同じ)', async () => {
    await recordFunnel('challenge', 'none', 'https://open-pay.jp/api/paid/hello', () => 0.5);
    expect(kv.evalMock).not.toHaveBeenCalled();
    await recordFunnel('challenge', 'none', 'https://open-pay.jp/api/paid/hello', () => 0.09);
    expect(kv.evalMock).toHaveBeenCalledTimes(1);
    expect(kv.evalMock.mock.calls[0][2]).toEqual([
      'challenge|none|/api/paid/hello', String(FUNNEL_TTL_SEC), String(FUNNEL_CHALLENGE_SAMPLE_RATE),
    ]);
  });

  it('支払いを試みた後の段階は乱数に関係なく全件 1 ずつ記録する', async () => {
    for (const stage of ['invalid_payload', 'verify_failed', 'conflict', 'content_error', 'settle_failed', 'facilitator_unavailable', 'settled'] as const) {
      await recordFunnel(stage, 'base', 'https://open-pay.jp/api/paid/hello', () => 0.99);
    }
    expect(kv.evalMock).toHaveBeenCalledTimes(7);
    expect(kv.evalMock.mock.calls.every((call) => call[2][2] === '1')).toBe(true);
  });

  it('KV 未構成は黙る・構成済みの失敗は warn・例外も throw しない', async () => {
    kv.evalMock.mockResolvedValueOnce({ ok: false, reason: 'unconfigured' });
    await recordFunnel('settled', 'base', 'https://open-pay.jp/api/paid/hello');
    expect(warn).not.toHaveBeenCalled();

    kv.evalMock.mockResolvedValueOnce({ ok: false, reason: 'network_error' });
    await recordFunnel('settled', 'base', 'https://open-pay.jp/api/paid/hello');
    expect(warn).toHaveBeenCalledWith('x402.funnel.record_failed', { stage: 'settled', rail: 'base' });

    kv.evalMock.mockRejectedValueOnce(new Error('boom'));
    await expect(recordFunnel('settled', 'base', 'https://open-pay.jp/api/paid/hello')).resolves.toBeUndefined();
  });

  it('recordFunnelAfterResponse: リクエストスコープ外 (after が throw) でも計上される', async () => {
    recordFunnelAfterResponse('verify_failed', 'arc-gateway', 'https://open-pay.jp/api/paid/hello');
    await new Promise((r) => setTimeout(r, 0));
    expect(kv.evalMock).toHaveBeenCalledTimes(1);
    expect(kv.evalMock.mock.calls[0][2][0]).toBe('verify_failed|arc-gateway|/api/paid/hello');
  });
});
