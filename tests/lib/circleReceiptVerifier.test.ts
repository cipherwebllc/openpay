import { describe, it, expect } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import {
  reconcileCircleNetUsdc,
  ERC20_TRANSFER_TOPIC,
  USER_OPERATION_EVENT_TOPIC,
  type ReceiptLog,
} from '@/lib/circleReceiptVerifier';

const ENTRYPOINT = getAddress('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108');
const USDC = getAddress('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d');
const SENDER = getAddress('0x1111111111111111111111111111111111111111');
const PAYMASTER = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');
const MERCHANT = getAddress('0x4444444444444444444444444444444444444444');
const OTHER = getAddress('0x5555555555555555555555555555555555555555');
const UOH_A = `0x${'aa'.repeat(32)}` as Hex;
const UOH_B = `0x${'bb'.repeat(32)}` as Hex;

function pad(addr: Address): Hex {
  return `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}` as Hex;
}
function valueHex(v: bigint): Hex {
  return `0x${v.toString(16).padStart(64, '0')}` as Hex;
}
function opEvent(
  logIndex: number,
  userOpHash: Hex,
  sender: Address,
  paymaster: Address,
  opts: { success?: boolean; emitter?: Address } = {},
): ReceiptLog {
  // data = abi.encode(nonce, success(bool), actualGasCost, actualGasUsed) = 4 words。
  const word = (v: bigint) => v.toString(16).padStart(64, '0');
  const success = opts.success ?? true;
  const data = `0x${word(0n)}${word(success ? 1n : 0n)}${word(0n)}${word(0n)}` as Hex;
  return {
    address: opts.emitter ?? ENTRYPOINT,
    topics: [USER_OPERATION_EVENT_TOPIC, userOpHash, pad(sender), pad(paymaster)],
    data,
    logIndex,
  };
}
function transfer(
  logIndex: number,
  token: Address,
  from: Address,
  to: Address,
  value: bigint,
): ReceiptLog {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, pad(from), pad(to)],
    data: valueHex(value),
    logIndex,
  };
}

const expected = {
  userOpHash: UOH_A,
  sender: SENDER,
  paymaster: PAYMASTER,
  token: USDC,
  entryPoint: ENTRYPOINT,
};

describe('reconcileCircleNetUsdc — 単一 UserOp', () => {
  it('customer→paymaster の gas を net に計上、merchant 転送は除外', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, MERCHANT, 99_000_000n), // 決済 (除外)
      transfer(1, USDC, SENDER, PAYMASTER, 9_000n), // gas
      opEvent(2, UOH_A, SENDER, PAYMASTER),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status).toBe('verified');
    if (r.status !== 'verified') return;
    expect(r.pulledUsdc).toBe(9_000n);
    expect(r.refundedUsdc).toBe(0n);
    expect(r.netUsdc).toBe(9_000n);
  });

  it('paymaster→customer の返金を差し引く (net = pulled − refund)', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, PAYMASTER, 12_000n), // prefund 徴収
      transfer(1, USDC, PAYMASTER, SENDER, 3_000n), // 過大分 返金
      opEvent(2, UOH_A, SENDER, PAYMASTER),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status).toBe('verified');
    if (r.status !== 'verified') return;
    expect(r.netUsdc).toBe(9_000n);
    expect(r.refundedUsdc).toBe(3_000n);
  });

  it('順不同の logs でも logIndex で安定 scope する', () => {
    const logs: ReceiptLog[] = [
      opEvent(2, UOH_A, SENDER, PAYMASTER),
      transfer(1, USDC, SENDER, PAYMASTER, 7_000n),
      transfer(0, USDC, SENDER, MERCHANT, 1n),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status === 'verified' && r.netUsdc).toBe(7_000n);
  });
});

describe('reconcileCircleNetUsdc — bundle 内 2 UserOp 同一 sender (C2 per-UserOp scope)', () => {
  // UserOp A (gas 100) → UserOpEvent(idx2)、UserOp B (gas 200, refund 20) → UserOpEvent(idx6)
  const bundle: ReceiptLog[] = [
    transfer(0, USDC, SENDER, MERCHANT, 50_000_000n), // A 決済
    transfer(1, USDC, SENDER, PAYMASTER, 100n), // A gas
    opEvent(2, UOH_A, SENDER, PAYMASTER),
    transfer(3, USDC, SENDER, MERCHANT, 60_000_000n), // B 決済
    transfer(4, USDC, SENDER, PAYMASTER, 200n), // B gas
    transfer(5, USDC, PAYMASTER, SENDER, 20n), // B 返金
    opEvent(6, UOH_B, SENDER, PAYMASTER),
  ];

  it('target=B は B scope のみ集計 (A の gas 100 を含めない)', () => {
    const r = reconcileCircleNetUsdc({
      logs: bundle,
      expected: { ...expected, userOpHash: UOH_B },
    });
    expect(r.status).toBe('verified');
    if (r.status !== 'verified') return;
    expect(r.pulledUsdc).toBe(200n);
    expect(r.refundedUsdc).toBe(20n);
    expect(r.netUsdc).toBe(180n); // 300 でも 280 でもない
  });

  it('target=A は A scope のみ (B の gas 200 を含めない)', () => {
    const r = reconcileCircleNetUsdc({
      logs: bundle,
      expected: { ...expected, userOpHash: UOH_A },
    });
    expect(r.status === 'verified' && r.netUsdc).toBe(100n);
  });
});

describe('reconcileCircleNetUsdc — binding 不変条件 (C3深)', () => {
  it('expected userOpHash の event が無ければ unreconciled', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, PAYMASTER, 9_000n),
      opEvent(1, UOH_B, SENDER, PAYMASTER), // 別 userOpHash
    ];
    const r = reconcileCircleNetUsdc({ logs, expected }); // expected=UOH_A
    expect(r.status).toBe('unreconciled');
  });

  it('receipt の sender が pending record と不一致なら unreconciled', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, OTHER, PAYMASTER, 9_000n),
      opEvent(1, UOH_A, OTHER, PAYMASTER), // sender が OTHER
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status).toBe('unreconciled');
    if (r.status === 'unreconciled') expect(r.reason).toMatch(/sender/);
  });

  it('receipt の paymaster が expected と不一致なら unreconciled (誤 paymaster 検出)', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, OTHER, 9_000n),
      opEvent(1, UOH_A, SENDER, OTHER), // paymaster が OTHER
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status).toBe('unreconciled');
    if (r.status === 'unreconciled') expect(r.reason).toMatch(/paymaster/);
  });
});

describe('reconcileCircleNetUsdc — 汚染耐性', () => {
  it('同 scope の無関係 token / 第三者宛 Transfer は計上しない', () => {
    const FAKE = getAddress('0x9999999999999999999999999999999999999999');
    const logs: ReceiptLog[] = [
      transfer(0, FAKE, SENDER, PAYMASTER, 1_000_000n), // 別 token (除外)
      transfer(1, USDC, SENDER, OTHER, 5_000n), // 第三者宛 (除外)
      transfer(2, USDC, SENDER, PAYMASTER, 9_000n), // 真の gas
      transfer(3, USDC, OTHER, SENDER, 1n), // 無関係 in (除外)
      opEvent(4, UOH_A, SENDER, PAYMASTER),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status === 'verified' && r.netUsdc).toBe(9_000n);
  });
});

describe('reconcileCircleNetUsdc — EntryPoint 発火元 + success 検証 (Codex BUG-2/D)', () => {
  const FAKE_EP = getAddress('0x000000000000000000000000000000000000dEaD');

  it('UserOperationEvent が EntryPoint 以外から出ていたら無視 (scope 汚染防止)', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, PAYMASTER, 9_000n),
      // 攻撃者 contract が同名 event を expected userOpHash で偽装発火
      opEvent(1, UOH_A, SENDER, PAYMASTER, { emitter: FAKE_EP }),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status).toBe('unreconciled'); // EntryPoint 由来の event が無い
  });

  it('正規 EntryPoint event のみ採用し偽装 event を混ぜても汚染されない', () => {
    const logs: ReceiptLog[] = [
      opEvent(0, UOH_A, SENDER, PAYMASTER, { emitter: FAKE_EP }), // 偽装 (無視)
      transfer(1, USDC, SENDER, PAYMASTER, 9_000n),
      opEvent(2, UOH_A, SENDER, PAYMASTER), // 正規 (ENTRYPOINT)
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status === 'verified' && r.netUsdc).toBe(9_000n);
  });

  it('UserOp success=false (revert) なら unreconciled', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, PAYMASTER, 9_000n),
      opEvent(1, UOH_A, SENDER, PAYMASTER, { success: false }),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status).toBe('unreconciled');
    if (r.status === 'unreconciled') expect(r.reason).toMatch(/success=false/);
  });
});

describe('reconcileCircleNetUsdc — 構造化 kind + no-charge guard (hardening)', () => {
  it('binding-paymaster 不一致は kind=binding-paymaster (RED FLAG)', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, OTHER, 9_000n),
      opEvent(1, UOH_A, SENDER, OTHER),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status === 'unreconciled' && r.kind).toBe('binding-paymaster');
  });

  it('sender 不一致は kind=binding-sender', () => {
    const logs: ReceiptLog[] = [opEvent(1, UOH_A, OTHER, PAYMASTER)];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status === 'unreconciled' && r.kind).toBe('binding-sender');
  });

  it('event 不在は kind=event-absent', () => {
    const logs: ReceiptLog[] = [opEvent(1, UOH_B, SENDER, PAYMASTER)];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status === 'unreconciled' && r.kind).toBe('event-absent');
  });

  it('success=false は kind=reverted', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, PAYMASTER, 9_000n),
      opEvent(1, UOH_A, SENDER, PAYMASTER, { success: false }),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status === 'unreconciled' && r.kind).toBe('reverted');
  });

  it('paymaster 徴収が scope に無い (collector≠paymaster/無償) は kind=no-charge で verified にしない', () => {
    const logs: ReceiptLog[] = [
      transfer(0, USDC, SENDER, MERCHANT, 99_000_000n), // 決済のみ・gas 徴収なし
      opEvent(1, UOH_A, SENDER, PAYMASTER),
    ];
    const r = reconcileCircleNetUsdc({ logs, expected });
    expect(r.status).toBe('unreconciled');
    if (r.status === 'unreconciled') expect(r.kind).toBe('no-charge');
  });
})
