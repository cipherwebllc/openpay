// parseFacilitatorRequest の入力検証 (境界 + 無効入力) を網羅する。/verify・/settle 共通の
// 「ボディ → ForwarderSettleParams 再構成」ゲートで、ここが緩むと改竄 requirements が money-path に
// 入りうる。testnet (Amoy 80002・bps=100/floor=2) で各 invalidReason を撃ち、valid は params 再構成 +
// server 権威 expectedFeeValue を検査する。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getAddress } from 'viem';

const JPY = 10n ** 18n;
const CUSTOMER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const MERCHANT = getAddress('0x1234567890123456789012345678901234567890');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const SALT = `0x${'22'.repeat(32)}`;
const SIG = `0x${'11'.repeat(65)}`;

type ParseFn = typeof import('@/lib/x402/facilitatorSettle').parseFacilitatorRequest;
type FeeFn = typeof import('@/lib/x402/fee').x402FeeValue;
let parseFacilitatorRequest: ParseFn;
let x402FeeValue: FeeFn;

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'testnet'); // facilitator chainId = Amoy 80002
  vi.stubEnv('X402_FEE_BPS', '100'); // 1%
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2'); // floor 2 JPYC
  vi.resetModules();
  ({ parseFacilitatorRequest } = await import('@/lib/x402/facilitatorSettle'));
  ({ x402FeeValue } = await import('@/lib/x402/fee'));
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

type Auth = { from: string; validAfter: string; validBefore: string; intentSalt: string };
type Openpay = { merchant: string; merchantValue: string; feeReceiver: string; feeValue: string };
type Body = {
  x402Version: number;
  paymentPayload: { scheme: string; network: string; payload: { signature: string; authorization: Auth } };
  paymentRequirements: { network: string; extra: { openpay: Openpay } };
};

// Amoy 宛の正当な raw ボディ。
function validRaw(): Body {
  return {
    x402Version: 1,
    paymentPayload: {
      scheme: 'exact',
      network: 'eip155:80002',
      payload: {
        signature: SIG,
        authorization: { from: CUSTOMER, validAfter: '0', validBefore: '1000', intentSalt: SALT },
      },
    },
    paymentRequirements: {
      network: 'eip155:80002',
      extra: {
        openpay: {
          merchant: MERCHANT,
          merchantValue: (1000n * JPY).toString(),
          feeReceiver: FEE_RECEIVER,
          feeValue: (10n * JPY).toString(),
        },
      },
    },
  };
}

// deep clone してから 1 箇所だけ壊す (parse は unknown を受けるので型外の代入は unknown キャストで行う)。
function broken(mutate: (b: Body) => void): unknown {
  const b = JSON.parse(JSON.stringify(validRaw())) as Body;
  mutate(b);
  return b;
}

describe('parseFacilitatorRequest valid', () => {
  it('正当ボディ → params 再構成 + server 権威 expectedFeeValue (買い手署名値は通す)', () => {
    const r = parseFacilitatorRequest(validRaw());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.chainId).toBe(80002);
    expect(getAddress(r.parsed.params.from)).toBe(CUSTOMER);
    expect(getAddress(r.parsed.params.merchant)).toBe(MERCHANT);
    expect(getAddress(r.parsed.params.feeReceiver)).toBe(FEE_RECEIVER);
    expect(r.parsed.params.merchantValue).toBe(1000n * JPY);
    expect(r.parsed.params.feeValue).toBe(10n * JPY);
    expect(r.parsed.params.validAfter).toBe(0n);
    expect(r.parsed.params.validBefore).toBe(1000n);
    expect(r.parsed.params.intentSalt).toBe(SALT);
    expect(r.parsed.signature).toBe(SIG);
    // server 権威: expectedFeeValue は merchantValue から再計算 (= max(2, 1%×1000) = 10 JPYC)。
    expect(r.parsed.expectedFeeValue).toBe(x402FeeValue(1000n * JPY));
    expect(r.parsed.expectedFeeValue).toBe(10n * JPY);
  });

  it('改竄 feeValue (5 JPYC) でも parse は通す → expectedFeeValue (server 再計算) が別途残る', () => {
    // 買い手署名値 (feeValue) はそのまま params 化し、server 権威 (expectedFeeValue) と分離する。
    // 不一致は verify/settle 層が fee_value_mismatch で弾く前提を確認。
    const r = parseFacilitatorRequest(
      broken((b) => {
        b.paymentRequirements.extra.openpay.feeValue = (5n * JPY).toString();
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.params.feeValue).toBe(5n * JPY); // 買い手署名値 (改竄)
    expect(r.parsed.expectedFeeValue).toBe(10n * JPY); // server 権威 (正)
  });
});

describe('parseFacilitatorRequest invalid', () => {
  it('非 object → invalid_body', () => {
    expect(parseFacilitatorRequest(null)).toEqual({ ok: false, reason: 'invalid_body' });
    expect(parseFacilitatorRequest(42)).toEqual({ ok: false, reason: 'invalid_body' });
    expect(parseFacilitatorRequest('x')).toEqual({ ok: false, reason: 'invalid_body' });
  });

  it.each<[string, (b: Body) => void, string]>([
    ['paymentPayload 欠落', (b) => delete (b as Partial<Body>).paymentPayload, 'invalid_body'],
    ['paymentRequirements 欠落', (b) => delete (b as Partial<Body>).paymentRequirements, 'invalid_body'],
    ['scheme≠exact', (b) => (b.paymentPayload.scheme = 'upto'), 'unsupported_scheme'],
    [
      'network 非 CAIP-2',
      (b) => {
        b.paymentPayload.network = 'foo';
        b.paymentRequirements.network = 'foo';
      },
      'invalid_network',
    ],
    [
      '対象外 chain (eip155:1)',
      (b) => {
        b.paymentPayload.network = 'eip155:1';
        b.paymentRequirements.network = 'eip155:1';
      },
      'unsupported_network',
    ],
    ['network 不一致', (b) => (b.paymentRequirements.network = 'eip155:137'), 'network_mismatch'],
    [
      'payload.payload 非 object',
      (b) => ((b.paymentPayload as { payload: unknown }).payload = 'x'),
      'invalid_payload',
    ],
    ['signature 非 hex', (b) => (b.paymentPayload.payload.signature = 'nothex'), 'invalid_signature'],
    [
      'authorization 非 object',
      (b) => ((b.paymentPayload.payload as { authorization: unknown }).authorization = 'x'),
      'invalid_authorization',
    ],
    [
      'openpay 非 object',
      (b) => ((b.paymentRequirements.extra as { openpay: unknown }).openpay = 'x'),
      'invalid_requirements',
    ],
    ['auth.from が非アドレス', (b) => (b.paymentPayload.payload.authorization.from = 'notaddr'), 'invalid_authorization'],
    ['validAfter が非 10進', (b) => (b.paymentPayload.payload.authorization.validAfter = '1e3'), 'invalid_authorization'],
    ['intentSalt が bytes32 でない', (b) => (b.paymentPayload.payload.authorization.intentSalt = '0x1234'), 'invalid_authorization'],
    ['openpay.merchant が非アドレス', (b) => (b.paymentRequirements.extra.openpay.merchant = 'notaddr'), 'invalid_requirements'],
    ['merchantValue が非 10進', (b) => (b.paymentRequirements.extra.openpay.merchantValue = '12.5'), 'invalid_requirements'],
  ])('%s → %s', (_label, mutate, reason) => {
    expect(parseFacilitatorRequest(broken(mutate))).toEqual({ ok: false, reason });
  });
});
