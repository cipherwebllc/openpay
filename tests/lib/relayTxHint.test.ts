// 中継が broadcast した tx の控え (relay:txhint:・7 日) の読み書き (lib/relay/relayTxHint.ts)。
// 控えは status の照会が tx を探す手がかりで、書き込みも読み取りも決済や照会を失敗にしない (reject しない)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const kv = vi.hoisted(() => ({
  configured: true,
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => kv.configured,
  kvGet: (...args: unknown[]) => kv.get(...args),
  kvSet: (...args: unknown[]) => kv.set(...args),
}));

import {
  RELAY_TX_HINT_READ_TIMEOUT_MS,
  RELAY_TX_HINT_TTL_SEC,
  RELAY_TX_HINT_WRITE_TIMEOUT_MS,
  readRelayTxHint,
  recordRelayTxHint,
  relayTxHintKey,
} from '@/lib/relay/relayTxHint';

const FROM = '0xAbCdEf0000000000000000000000000000000001' as Address;
const NONCE = `0x${'AB'.repeat(32)}` as Hex;
const TX = `0x${'c'.repeat(64)}` as Hex;
const KEY = `relay:txhint:137:${FROM.toLowerCase()}:${NONCE.toLowerCase()}`;

beforeEach(() => {
  kv.configured = true;
  kv.get.mockReset().mockResolvedValue({ ok: true, value: null });
  kv.set.mockReset().mockResolvedValue({ ok: true, value: 'OK' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('relayTxHintKey', () => {
  it('from と nonce を小文字にした relay:txhint: の鍵 (relay:idem: と別の名前空間)', () => {
    expect(relayTxHintKey(137, FROM, NONCE)).toBe(KEY);
    expect(RELAY_TX_HINT_TTL_SEC).toBe(7 * 24 * 60 * 60);
  });
});

describe('recordRelayTxHint', () => {
  it('7 日の TTL で上書きして書く (NX なし = 置換の tx は最新が勝つ)', async () => {
    await recordRelayTxHint(137, FROM, NONCE, TX);
    expect(kv.set).toHaveBeenCalledExactlyOnceWith(KEY, TX, { ttlSec: RELAY_TX_HINT_TTL_SEC });
  });

  it('tx hash の形でない値は書かない (先に書いた正しい控えを上書きしない)', async () => {
    await recordRelayTxHint(137, FROM, NONCE, '0x1234' as Hex);
    expect(kv.set).not.toHaveBeenCalled();
  });

  it(`KV が ${RELAY_TX_HINT_WRITE_TIMEOUT_MS} ms で答えなければ待つのをやめる (中継の応答を長く待たせない)`, async () => {
    vi.useFakeTimers();
    kv.set.mockReturnValueOnce(new Promise(() => undefined));
    let done = false;
    const write = recordRelayTxHint(137, FROM, NONCE, TX).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(RELAY_TX_HINT_WRITE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await write;
    expect(done).toBe(true);
  });

  it('KV が ok:false を返しても、投げても reject しない (中継の応答に波及させない)', async () => {
    kv.set.mockResolvedValueOnce({ ok: false, reason: 'network_error' });
    await expect(recordRelayTxHint(137, FROM, NONCE, TX)).resolves.toBeUndefined();
    kv.set.mockRejectedValueOnce(new Error('kv boom'));
    await expect(recordRelayTxHint(137, FROM, NONCE, TX)).resolves.toBeUndefined();
  });
});

describe('readRelayTxHint', () => {
  it('控えの tx hash を返す', async () => {
    kv.get.mockResolvedValueOnce({ ok: true, value: TX });
    await expect(readRelayTxHint(137, FROM, NONCE)).resolves.toBe(TX);
    expect(kv.get).toHaveBeenCalledExactlyOnceWith(KEY);
  });

  it.each([
    ['無い', { ok: true, value: null }],
    ['冪等の claim の値 (1)', { ok: true, value: '1' }],
    ['形の違う値', { ok: true, value: '0x1234' }],
    ['KV の失敗', { ok: false, reason: 'network_error' }],
  ])('%s は null (今の経路で探す)', async (_label, result) => {
    kv.get.mockResolvedValueOnce(result);
    await expect(readRelayTxHint(137, FROM, NONCE)).resolves.toBeNull();
  });

  it('KV が投げても null (照会の外側の catch = indeterminate に落とさない)', async () => {
    kv.get.mockRejectedValueOnce(new Error('kv boom'));
    await expect(readRelayTxHint(137, FROM, NONCE)).resolves.toBeNull();
  });

  it('KV が未設定なら読まずに null', async () => {
    kv.configured = false;
    await expect(readRelayTxHint(137, FROM, NONCE)).resolves.toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it(`KV が ${RELAY_TX_HINT_READ_TIMEOUT_MS} ms で答えなければ null (端末の照会の期限を使い切らせない)`, async () => {
    vi.useFakeTimers();
    kv.get.mockReturnValueOnce(new Promise(() => undefined));
    const read = readRelayTxHint(137, FROM, NONCE);
    await vi.advanceTimersByTimeAsync(RELAY_TX_HINT_READ_TIMEOUT_MS - 1);
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toBeNull();
  });
});
