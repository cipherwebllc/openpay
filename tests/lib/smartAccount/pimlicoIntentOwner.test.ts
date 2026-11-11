// 記録の「同じ intent」の定義 (lib/smartAccount/pimlicoIntentOwner.ts・第 10 回レビュー PR-02 の Codex レビュー P1)。
// 送った後の書き込み・削除は、storage の記録がこれで同じ intent のときだけ行う (hook と intent の関所の挙動は
// tests/hooks/useBatchPayment.intentOwner.test.tsx)。
import { describe, it, expect } from 'vitest';
import { isSameIntent } from '@/lib/smartAccount/pimlicoIntentOwner';

const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const OTHER_ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const SENDER = '0x9999999999999999999999999999999999999999';
const H1 = `0x${'a'.repeat(64)}`;
const H2 = `0x${'c'.repeat(64)}`;

const send = { entryPoint: ENTRY_POINT, sender: SENDER, nonceKey: '1700000000000', nonceSeq: '0' };
const ledger = { userOpHash: H1, send };

describe('isSameIntent', () => {
  it('送信の控えのある記録: EntryPoint・sender・nonce が同じなら、hash が違っても同じ intent (作り直し・hash の直し)', () => {
    expect(isSameIntent(ledger, { userOpHash: H2, send: { ...send } })).toBe(true);
  });

  it('address の大文字・小文字は区別しない', () => {
    expect(
      isSameIntent(ledger, {
        userOpHash: H1,
        send: { ...send, entryPoint: ENTRY_POINT.toLowerCase(), sender: SENDER.toUpperCase().replace('0X', '0x') },
      }),
    ).toBe(true);
  });

  it.each([
    { label: 'nonce の key', change: { nonceKey: '1700000000001' } },
    { label: 'nonce の seq', change: { nonceSeq: '1' } },
    { label: 'sender', change: { sender: '0x5555555555555555555555555555555555555555' } },
    { label: 'EntryPoint', change: { entryPoint: OTHER_ENTRY_POINT } },
  ])('$label が違えば、hash が同じでも別の intent', ({ change }) => {
    expect(isSameIntent(ledger, { userOpHash: H1, send: { ...send, ...change } })).toBe(false);
  });

  it('控えの無い記録 (MAv2 等) は hash だけで比べる', () => {
    expect(isSameIntent({ userOpHash: H1 }, { userOpHash: H1 })).toBe(true);
    expect(isSameIntent({ userOpHash: H1 }, { userOpHash: H2 })).toBe(false);
  });

  it('片方だけ控えがあれば、hash が同じでも別の intent', () => {
    expect(isSameIntent(ledger, { userOpHash: H1 })).toBe(false);
    expect(isSameIntent({ userOpHash: H1 }, ledger)).toBe(false);
  });
});
