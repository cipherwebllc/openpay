// shop:live の KV I/O (readShopLive fail-open / applyShopLive 楽観 CAS) を kv モックで検証。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hold = vi.hoisted(() => ({
  configured: true,
  get: { ok: true, value: null } as { ok: true; value: string | null } | { ok: false; reason: string },
  evalResults: [1] as number[], // CAS 戻り値の列 (順に消費・1=成功 / 0=競合)
}));
const getSpy = vi.hoisted(() => vi.fn());
const evalSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.configured,
  kvGet: (...a: unknown[]) => {
    getSpy(...a);
    return Promise.resolve(hold.get);
  },
  kvEval: (...a: unknown[]) => {
    evalSpy(...a);
    return Promise.resolve({ ok: true, value: hold.evalResults.shift() ?? 0 });
  },
}));

import {
  readShopLive,
  readShopLiveStrict,
  applyShopLive,
} from '@/lib/shopLiveStore';
import { serializeShopLive, shopLiveKey } from '@/lib/shopLive';

beforeEach(() => {
  hold.configured = true;
  hold.get = { ok: true, value: null };
  hold.evalResults = [1];
  getSpy.mockClear();
  evalSpy.mockClear();
});

describe('readShopLive (fail-open)', () => {
  it('KV 未設定 → EMPTY', async () => {
    hold.configured = false;
    expect(await readShopLive('alice')).toEqual({ soldOut: [], paused: false, updatedAt: 0 });
  });
  it('kvGet 失敗 → EMPTY (fail-open)', async () => {
    hold.get = { ok: false, reason: 'network_error' };
    expect((await readShopLive('alice')).paused).toBe(false);
  });
  it('保存値を parse・小文字キーで読む', async () => {
    hold.get = { ok: true, value: serializeShopLive({ soldOut: ['x'], paused: true, updatedAt: 7 }) };
    expect(await readShopLive('Alice')).toEqual({ soldOut: ['x'], paused: true, updatedAt: 7 });
    expect(getSpy).toHaveBeenCalledWith(shopLiveKey('alice'));
  });
});

describe('readShopLiveStrict (Shops API fail-closed)', () => {
  it('未保存は EMPTY、KV 未設定/障害は null', async () => {
    expect(await readShopLiveStrict('alice')).toEqual({
      soldOut: [],
      paused: false,
      updatedAt: 0,
    });
    hold.configured = false;
    expect(await readShopLiveStrict('alice')).toBeNull();
    hold.configured = true;
    hold.get = { ok: false, reason: 'network_error' };
    expect(await readShopLiveStrict('alice')).toBeNull();
  });

  it('壊れた JSON / sanitize が必要な値は判定不能 null', async () => {
    hold.get = { ok: true, value: '{bad' };
    expect(await readShopLiveStrict('alice')).toBeNull();
    hold.get = {
      ok: true,
      value: JSON.stringify({
        soldOut: ['a', 'a'],
        paused: false,
        updatedAt: 1,
      }),
    };
    expect(await readShopLiveStrict('alice')).toBeNull();
  });
});

describe('applyShopLive (楽観 CAS + リトライ)', () => {
  it('KV 未設定 → kv_error', async () => {
    hold.configured = false;
    expect(await applyShopLive('alice', { op: 'paused', value: true }, 1)).toEqual({
      ok: false,
      reason: 'kv_error',
    });
  });
  it('kvGet 失敗 → kv_error', async () => {
    hold.get = { ok: false, reason: 'network_error' };
    expect(await applyShopLive('alice', { op: 'paused', value: true }, 1)).toMatchObject({
      ok: false,
      reason: 'kv_error',
    });
  });
  it('CAS 成功 → 確定状態を返す・未存在は sentinel "" で CAS', async () => {
    hold.get = { ok: true, value: null }; // 未存在
    hold.evalResults = [1];
    const res = await applyShopLive('alice', { op: 'paused', value: true }, 99);
    expect(res).toEqual({ ok: true, state: { soldOut: [], paused: true, updatedAt: 99 } });
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(args[0]).toBe(''); // 未存在 → expected sentinel ''
  });
  it('既存値ありの CAS は expected に旧 raw を渡す', async () => {
    const raw = serializeShopLive({ soldOut: [], paused: false, updatedAt: 1 });
    hold.get = { ok: true, value: raw };
    hold.evalResults = [1];
    await applyShopLive('alice', { op: 'paused', value: true }, 2);
    const [, , args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(args[0]).toBe(raw);
  });
  it('競合 (0) → リトライして成功', async () => {
    hold.evalResults = [0, 1];
    const res = await applyShopLive('alice', { op: 'paused', value: true }, 1);
    expect(res.ok).toBe(true);
    expect(evalSpy).toHaveBeenCalledTimes(2);
  });
  it('競合が続く → conflict (最大 3 回)', async () => {
    hold.evalResults = [0, 0, 0];
    const res = await applyShopLive('alice', { op: 'paused', value: true }, 1);
    expect(res).toEqual({ ok: false, reason: 'conflict' });
    expect(evalSpy).toHaveBeenCalledTimes(3);
  });
});
