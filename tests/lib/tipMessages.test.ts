import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const kv = vi.hoisted(() => ({
  lists: new Map<string, string[]>(),
  ttls: new Map<string, number>(),
  evalSpy: vi.fn(),
  rangeSpy: vi.fn(),
  delSpy: vi.fn(),
  evalFailure: false,
  rangeFailure: false,
  delFailure: false,
  evalThrows: false,
  rangeThrows: false,
  delThrows: false,
}));

vi.mock('@/lib/kv', () => ({
  kvEval: async (script: string, keys: string[], args: string[]) => {
    kv.evalSpy(script, keys, args);
    if (kv.evalThrows) throw new Error('eval failed');
    if (kv.evalFailure) {
      return { ok: false as const, reason: 'network_error' as const };
    }
    const key = keys[0];
    const rows = kv.lists.get(key) ?? [];
    const duplicate = rows.some((raw) => {
      try {
        const item = JSON.parse(raw) as {
          chainId?: unknown;
          txHash?: unknown;
        };
        return (
          item.chainId === Number(args[3]) &&
          typeof item.txHash === 'string' &&
          item.txHash.toLowerCase() === args[4].toLowerCase()
        );
      } catch {
        return false;
      }
    });
    if (duplicate) return { ok: true as const, value: 0 };
    const record = JSON.stringify({
      from: args[0],
      to: args[1],
      amountWei: args[2],
      chainId: Number(args[3]),
      txHash: args[4],
      message: args[5],
      ts: Number(args[6]),
    });
    kv.lists.set(key, [record, ...rows].slice(0, 200));
    kv.ttls.set(key, Number(args[7]));
    return { ok: true as const, value: 1 };
  },
  kvLrange: async (key: string, start: number, stop: number) => {
    kv.rangeSpy(key, start, stop);
    if (kv.rangeThrows) throw new Error('range failed');
    if (kv.rangeFailure) {
      return { ok: false as const, reason: 'timeout' as const };
    }
    const rows = kv.lists.get(key) ?? [];
    return { ok: true as const, value: rows.slice(start, stop + 1) };
  },
  kvDel: async (key: string) => {
    kv.delSpy(key);
    if (kv.delThrows) throw new Error('delete failed');
    if (kv.delFailure) {
      return { ok: false as const, reason: 'http_error' as const };
    }
    const removed = kv.lists.delete(key) ? 1 : 0;
    kv.ttls.delete(key);
    return { ok: true as const, value: removed };
  },
}));

import {
  TIP_MESSAGE_LIST_MAX,
  TIP_MESSAGE_MAX_CODE_POINTS,
  TIP_MESSAGE_MIN_AMOUNT_WEI,
  TIP_MESSAGE_TTL_SEC,
  deleteTipMessages,
  listTipMessages,
  parseStoredTipMessage,
  sanitizeTipMessage,
  storeTipMessage,
  tipMessageInboxKey,
  type StoredTipMessage,
} from '@/lib/tipMessages';

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x9999999999999999999999999999999999999999';
const TX = `0x${'a'.repeat(64)}`;

function stored(
  over: Partial<StoredTipMessage> = {},
): StoredTipMessage {
  return {
    from: FROM,
    to: TO,
    amountWei: TIP_MESSAGE_MIN_AMOUNT_WEI.toString(),
    chainId: 137,
    txHash: TX,
    message: '質問です',
    ts: 1_700_000_000_000,
    ...over,
  } as StoredTipMessage;
}

beforeEach(() => {
  kv.lists.clear();
  kv.ttls.clear();
  kv.evalSpy.mockClear();
  kv.rangeSpy.mockClear();
  kv.delSpy.mockClear();
  kv.evalFailure = false;
  kv.rangeFailure = false;
  kv.delFailure = false;
  kv.evalThrows = false;
  kv.rangeThrows = false;
  kv.delThrows = false;
});

describe('sanitizeTipMessage', () => {
  it('改行を保持し、CRLF/CR を LF に正規化して前後だけ trim する', () => {
    expect(sanitizeTipMessage('  1行目\r\n2行目\r3行目  ')).toBe(
      '1行目\n2行目\n3行目',
    );
  });

  it('制御文字・zero-width・bidi・不対 surrogate を除去する', () => {
    expect(
      sanitizeTipMessage(
        `A\u0000\t\u007f\u0085\u200b\u200d\u202e\u2066\ud800B`,
      ),
    ).toBe('AB');
  });

  it('300 Unicode code point は受理し、301 は切り捨てず無視する', () => {
    expect(sanitizeTipMessage('🎉'.repeat(TIP_MESSAGE_MAX_CODE_POINTS))).toBe(
      '🎉'.repeat(TIP_MESSAGE_MAX_CODE_POINTS),
    );
    expect(
      sanitizeTipMessage('🎉'.repeat(TIP_MESSAGE_MAX_CODE_POINTS + 1)),
    ).toBeUndefined();
  });

  it('空・除去後空・非 string は undefined', () => {
    expect(sanitizeTipMessage(' \u200b\u202e ')).toBeUndefined();
    expect(sanitizeTipMessage('')).toBeUndefined();
    expect(sanitizeTipMessage(42)).toBeUndefined();
  });
});

describe('storeTipMessage: atomic Lua', () => {
  it('dedupe・LPUSH・LTRIM 0 199・EXPIRE 180d を単一 EVAL に閉じる', async () => {
    await expect(
      storeTipMessage({
        from: FROM,
        to: TO,
        amountWei: TIP_MESSAGE_MIN_AMOUNT_WEI,
        chainId: 137,
        txHash: TX,
        message: '非公開の質問',
        ts: 123,
      }),
    ).resolves.toBe(true);

    expect(kv.evalSpy).toHaveBeenCalledOnce();
    const [script, keys, args] = kv.evalSpy.mock.calls[0] as [
      string,
      string[],
      string[],
    ];
    expect(keys).toEqual([tipMessageInboxKey(TO)]);
    expect(script).toContain("redis.call('LRANGE'");
    expect(script).toContain("redis.call('LPUSH'");
    expect(script).toContain("redis.call('LTRIM', KEYS[1], 0, 199)");
    expect(script).toContain("redis.call('EXPIRE'");
    expect(script).not.toContain('非公開の質問');
    expect(args[5]).toBe('非公開の質問');
    expect(args[7]).toBe(String(TIP_MESSAGE_TTL_SEC));
    expect(kv.ttls.get(tipMessageInboxKey(TO))).toBe(
      TIP_MESSAGE_TTL_SEC,
    );
  });

  it('message は独立 ARGV で渡し、制御文字除去後の改行を保存する', async () => {
    await storeTipMessage({
      from: FROM,
      to: TO,
      amountWei: TIP_MESSAGE_MIN_AMOUNT_WEI,
      chainId: 137,
      txHash: TX,
      message: ' A\u0000\r\nB\u202e ',
      ts: 123,
    });
    const [script, , args] = kv.evalSpy.mock.calls[0] as [
      string,
      string[],
      string[],
    ];
    expect(args[5]).toBe('A\nB');
    expect(script).not.toContain('A\nB');
    expect(JSON.parse(kv.lists.get(tipMessageInboxKey(TO))![0])).toMatchObject({
      message: 'A\nB',
    });
  });

  it('同じ chainId+txHash は重複保存せず、別 chainId なら保存する', async () => {
    const input = {
      from: FROM,
      to: TO,
      amountWei: TIP_MESSAGE_MIN_AMOUNT_WEI,
      chainId: 137,
      txHash: TX,
      message: 'first',
      ts: 1,
    };
    await expect(storeTipMessage(input)).resolves.toBe(true);
    await expect(
      storeTipMessage({ ...input, message: 'duplicate', ts: 2 }),
    ).resolves.toBe(false);
    await expect(
      storeTipMessage({ ...input, chainId: 80002, message: 'other', ts: 3 }),
    ).resolves.toBe(true);
    expect(kv.lists.get(tipMessageInboxKey(TO))).toHaveLength(2);
  });

  it('200件 cap は新しい側を残す', async () => {
    for (let index = 0; index <= TIP_MESSAGE_LIST_MAX; index += 1) {
      await storeTipMessage({
        from: FROM,
        to: TO,
        amountWei: TIP_MESSAGE_MIN_AMOUNT_WEI,
        chainId: 137,
        txHash: `0x${index.toString(16).padStart(64, '0')}`,
        message: `message-${index}`,
        ts: index + 1,
      });
    }
    const rows = kv.lists.get(tipMessageInboxKey(TO)) ?? [];
    expect(rows).toHaveLength(TIP_MESSAGE_LIST_MAX);
    expect(JSON.parse(rows[0]).message).toBe('message-200');
    expect(rows.some((raw) => JSON.parse(raw).message === 'message-0')).toBe(
      false,
    );
  });

  it('1 JPYC 未満・不正 txHash・301 code point は保存しない', async () => {
    const base = {
      from: FROM,
      to: TO,
      amountWei: TIP_MESSAGE_MIN_AMOUNT_WEI,
      chainId: 137,
      txHash: TX,
      message: 'valid',
      ts: 1,
    };
    await expect(
      storeTipMessage({
        ...base,
        amountWei: TIP_MESSAGE_MIN_AMOUNT_WEI - 1n,
      }),
    ).resolves.toBe(false);
    await expect(
      storeTipMessage({ ...base, txHash: '0x1234' }),
    ).resolves.toBe(false);
    await expect(
      storeTipMessage({
        ...base,
        message: 'a'.repeat(TIP_MESSAGE_MAX_CODE_POINTS + 1),
      }),
    ).resolves.toBe(false);
    expect(kv.evalSpy).not.toHaveBeenCalled();
  });

  it('KV error/throw は false に隔離して throw しない', async () => {
    const input = {
      from: FROM,
      to: TO,
      amountWei: TIP_MESSAGE_MIN_AMOUNT_WEI,
      chainId: 137,
      txHash: TX,
      message: 'valid',
      ts: 1,
    };
    kv.evalFailure = true;
    await expect(storeTipMessage(input)).resolves.toBe(false);
    kv.evalFailure = false;
    kv.evalThrows = true;
    await expect(storeTipMessage(input)).resolves.toBe(false);
  });
});

describe('parse/listTipMessages: KV untrusted schema', () => {
  it('write/read の txHash は厳密な 32-byte hex のみ', () => {
    expect(parseStoredTipMessage(JSON.stringify(stored()))).toEqual(stored());
    expect(
      parseStoredTipMessage(
        JSON.stringify(stored({ txHash: `0x${'a'.repeat(63)}` })),
      ),
    ).toBeNull();
    expect(
      parseStoredTipMessage(
        JSON.stringify(stored({ txHash: `0x${'g'.repeat(64)}` })),
      ),
    ).toBeNull();
  });

  it('壊れた schema は null、canonical でない message も復元しない', () => {
    expect(parseStoredTipMessage('{bad')).toBeNull();
    expect(parseStoredTipMessage(JSON.stringify({ ...stored(), from: 'x' }))).toBeNull();
    expect(
      parseStoredTipMessage(JSON.stringify({ ...stored(), amountWei: '01' })),
    ).toBeNull();
    expect(
      parseStoredTipMessage(JSON.stringify({ ...stored(), chainId: 1.5 })),
    ).toBeNull();
    expect(
      parseStoredTipMessage(JSON.stringify({ ...stored(), message: 'bad\u200b' })),
    ).toBeNull();
    expect(
      parseStoredTipMessage(JSON.stringify({ ...stored(), ts: 0 })),
    ).toBeNull();
  });

  it('不正 item と別 owner の item だけを個別 drop し、LRANGE の新しい順を保つ', async () => {
    const key = tipMessageInboxKey(TO);
    kv.lists.set(key, [
      JSON.stringify(stored({ message: 'new', ts: 3 })),
      '{bad',
      JSON.stringify(stored({ to: OTHER, message: 'other owner', ts: 2 })),
      JSON.stringify(
        stored({
          message: 'old',
          ts: 1,
          txHash: `0x${'b'.repeat(64)}`,
        }),
      ),
    ]);

    await expect(listTipMessages(TO)).resolves.toMatchObject([
      { message: 'new' },
      { message: 'old' },
    ]);
    expect(kv.rangeSpy).toHaveBeenCalledWith(
      key,
      0,
      TIP_MESSAGE_LIST_MAX - 1,
    );
  });

  it('KV failure/throw は空配列と区別して null', async () => {
    kv.rangeFailure = true;
    await expect(listTipMessages(TO)).resolves.toBeNull();
    kv.rangeFailure = false;
    kv.rangeThrows = true;
    await expect(listTipMessages(TO)).resolves.toBeNull();
  });
});

describe('deleteTipMessages', () => {
  it('owner の小文字 inbox key を DEL し、存在しない再実行も成功', async () => {
    kv.lists.set(tipMessageInboxKey(TO), [JSON.stringify(stored())]);
    await expect(deleteTipMessages(TO)).resolves.toBe(true);
    await expect(deleteTipMessages(TO)).resolves.toBe(true);
    expect(kv.delSpy).toHaveBeenNthCalledWith(1, tipMessageInboxKey(TO));
    expect(kv.delSpy).toHaveBeenNthCalledWith(2, tipMessageInboxKey(TO));
  });

  it('KV failure/throw は false', async () => {
    kv.delFailure = true;
    await expect(deleteTipMessages(TO)).resolves.toBe(false);
    kv.delFailure = false;
    kv.delThrows = true;
    await expect(deleteTipMessages(TO)).resolves.toBe(false);
  });
});
