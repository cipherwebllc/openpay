import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';

const h = vi.hoisted(() => ({
  parsed: null as unknown,
  signer: '0x1111111111111111111111111111111111111111' as Address,
  idem: { state: 'missing' } as
    | { state: 'missing' }
    | { state: 'hash'; txHash: Hex }
    | { state: 'indeterminate' },
  used: false,
  logHash: null as Hex | null,
  receipt: { status: 'success', logs: [] } as {
    status: 'success' | 'reverted';
    logs: Array<{ address: string; topics: string[]; data: string }>;
  },
  receiptOverrides: new Map<
    string,
    {
      status: 'success' | 'reverted';
      logs: Array<{ address: string; topics: string[]; data: string }>;
    }
  >(),
  receiptThrows: false,
}));

vi.mock('@/lib/x402/facilitatorSettle', () => ({
  parseFacilitatorRequest: vi.fn(() => h.parsed),
}));
vi.mock('@/lib/relay/relayProvider', () => ({
  jpycAddressFor: () =>
    '0x2222222222222222222222222222222222222222' as Address,
  readAuthorizationUsed: vi.fn(async () => h.used),
  findAuthorizationUsedTransactionHash: vi.fn(async () => h.logHash),
}));
vi.mock('@/lib/relay/forwarderConfig', () => ({
  configuredJpycForwarderFor: () =>
    '0x3333333333333333333333333333333333333333' as Address,
}));
vi.mock('@/lib/relay/forwarderSettleService', () => ({
  feeReceiverFor: () =>
    '0x5555555555555555555555555555555555555555' as Address,
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  readIdempotency: vi.fn(async () => h.idem),
}));
vi.mock('@/lib/relay/forwarderSettle', () => ({
  recoverReceiveWithAuthorizationSigner: vi.fn(async () => h.signer),
}));
vi.mock('@/lib/chains', () => ({
  chainObjectForId: () => ({ id: 80002 }),
  transportForChain: () => ({}),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (h.receiptThrows) throw new Error('rpc unavailable');
        return h.receiptOverrides.get(hash) ?? h.receipt;
      },
    }),
  };
});

import {
  findAuthorizationUsedTransactionHash,
  readAuthorizationUsed,
} from '@/lib/relay/relayProvider';
import { readIdempotency } from '@/lib/relay/relayGuards';
import { resolveFacilitatorPaymentStatus } from '@/lib/x402/facilitatorStatus';

const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const TOKEN = getAddress('0x2222222222222222222222222222222222222222');
const FORWARDER = getAddress('0x3333333333333333333333333333333333333333');
const MERCHANT = getAddress('0x4444444444444444444444444444444444444444');
const FEE_RECEIVER = getAddress('0x5555555555555555555555555555555555555555');
const HASH = `0x${'a'.repeat(64)}` as Hex;
const LOG_HASH = `0x${'b'.repeat(64)}` as Hex;
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SETTLED_TOPIC = keccak256(
  toHex('Settled(address,bytes32,address,uint256,address,uint256)'),
);
const params: ForwarderSettleParams = {
  from: PAYER,
  merchant: MERCHANT,
  merchantValue: 100n,
  feeReceiver: FEE_RECEIVER,
  feeValue: 2n,
  validAfter: 0n,
  validBefore: 9999999999n,
  intentSalt: `0x${'1'.repeat(64)}`,
};

function topic(address: Address): Hex {
  return `0x${address.slice(2).padStart(64, '0')}` as Hex;
}

function transfer(from: Address, to: Address, value: bigint) {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, topic(from), topic(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
  };
}

function settledEvent(
  overrides: {
    emitter?: Address;
    from?: Address;
    nonce?: Hex;
    merchant?: Address;
    merchantValue?: bigint;
    feeReceiver?: Address;
    feeValue?: bigint;
  } = {},
) {
  const from = overrides.from ?? params.from;
  const nonce =
    overrides.nonce ?? buildForwarderNonce(params, 80002, FORWARDER);
  const merchant = overrides.merchant ?? params.merchant;
  const merchantValue = overrides.merchantValue ?? params.merchantValue;
  const feeReceiver = overrides.feeReceiver ?? params.feeReceiver;
  const feeValue = overrides.feeValue ?? params.feeValue;
  return {
    address: overrides.emitter ?? FORWARDER,
    topics: [SETTLED_TOPIC, topic(from), nonce, topic(merchant)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
      [merchantValue, feeReceiver, feeValue],
    ),
  };
}

function exactSettlementLogs() {
  return [
    transfer(FORWARDER, MERCHANT, params.merchantValue),
    transfer(FORWARDER, FEE_RECEIVER, params.feeValue),
    settledEvent(),
  ];
}

function batchedSettlementLogs() {
  const otherParams = {
    ...params,
    intentSalt: `0x${'9'.repeat(64)}` as Hex,
  };
  return [
    transfer(FORWARDER, MERCHANT, otherParams.merchantValue),
    transfer(FORWARDER, FEE_RECEIVER, otherParams.feeValue),
    settledEvent({
      nonce: buildForwarderNonce(otherParams, 80002, FORWARDER),
    }),
    ...exactSettlementLogs(),
  ];
}

function parsedWith(
  paramsOverride: Partial<ForwarderSettleParams> = {},
  expectedFeeValue = params.feeValue,
) {
  return {
    ok: true,
    parsed: {
      chainId: 80002,
      params: { ...params, ...paramsOverride },
      signature: `0x${'2'.repeat(130)}` as Hex,
      expectedFeeValue,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.parsed = parsedWith();
  h.signer = PAYER;
  h.idem = { state: 'missing' };
  h.used = false;
  h.logHash = null;
  h.receipt = { status: 'success', logs: exactSettlementLogs() };
  h.receiptOverrides.clear();
  h.receiptThrows = false;
});

describe('resolveFacilitatorPaymentStatus', () => {
  it('構造不正は invalid_payload', async () => {
    h.parsed = { ok: false, reason: 'invalid_body' };
    expect(await resolveFacilitatorPaymentStatus({})).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
  });

  it('署名者が payer と不一致なら signature_mismatch', async () => {
    h.signer = '0x9999999999999999999999999999999999999999';
    expect(await resolveFacilitatorPaymentStatus({})).toEqual({
      ok: false,
      error: 'signature_mismatch',
    });
  });

  it('server 権威と異なる feeValue は settled とせず fee_value_mismatch', async () => {
    h.parsed = parsedWith({ feeValue: 1n }, 2n);
    expect(await resolveFacilitatorPaymentStatus({})).toEqual({
      ok: false,
      error: 'fee_value_mismatch',
    });
  });

  it('server 権威と異なる feeReceiver は settled とせず fee_receiver_mismatch', async () => {
    h.parsed = parsedWith({
      feeReceiver:
        '0x9999999999999999999999999999999999999999' as Address,
    });
    expect(await resolveFacilitatorPaymentStatus({})).toEqual({
      ok: false,
      error: 'fee_receiver_mismatch',
    });
  });

  it('KV hash があっても authorization 未使用なら indeterminate', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    const status = await resolveFacilitatorPaymentStatus({});
    expect(status).toMatchObject({ ok: true, state: 'indeterminate' });
    expect(readAuthorizationUsed).toHaveBeenCalledOnce();
  });

  it('KV hash + authorization used + exact 分割 receipt のみ settled', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    h.used = true;
    const status = await resolveFacilitatorPaymentStatus({});
    expect(status).toEqual({
      ok: true,
      chainId: 80002,
      payer: PAYER,
      state: 'settled',
      txHash: HASH,
    });
    expect(readIdempotency).toHaveBeenCalledWith(
      'x402fac:idem:',
      80002,
      PAYER,
      expect.stringMatching(/^0x[0-9a-f]{64}$/),
    );
    expect(findAuthorizationUsedTransactionHash).not.toHaveBeenCalled();
  });

  it('token 直送で authorization used でも分割 receipt 不在なら解錠しない', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    h.used = true;
    h.receipt.logs = [
      transfer(PAYER, FORWARDER, params.merchantValue + params.feeValue),
    ];
    expect(await resolveFacilitatorPaymentStatus({})).toMatchObject({
      ok: true,
      state: 'indeterminate',
    });
  });

  it('同一 receipt の別 nonce による同一 split settle を対象 payment に誤帰属しない', async () => {
    h.used = true;
    h.logHash = LOG_HASH;
    const otherNonce = buildForwarderNonce(
      { ...params, intentSalt: `0x${'9'.repeat(64)}` },
      80002,
      FORWARDER,
    );
    h.receipt.logs = [
      transfer(FORWARDER, MERCHANT, params.merchantValue),
      transfer(FORWARDER, FEE_RECEIVER, params.feeValue),
      settledEvent({ nonce: otherNonce }),
    ];
    expect(await resolveFacilitatorPaymentStatus({})).toMatchObject({
      ok: true,
      state: 'indeterminate',
    });
  });

  it('Settled の発火元が expected forwarder でなければ解錠しない', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    h.used = true;
    h.receipt.logs = [
      transfer(FORWARDER, MERCHANT, params.merchantValue),
      transfer(FORWARDER, FEE_RECEIVER, params.feeValue),
      settledEvent({
        emitter: getAddress('0x6666666666666666666666666666666666666666'),
      }),
    ];
    expect(await resolveFacilitatorPaymentStatus({})).toMatchObject({
      ok: true,
      state: 'indeterminate',
    });
  });

  it.each([
    [
      'payer',
      {
        from: getAddress('0x7777777777777777777777777777777777777777'),
      },
    ],
    [
      'merchant',
      {
        merchant: getAddress(
          '0x8888888888888888888888888888888888888888',
        ),
      },
    ],
    ['merchantValue', { merchantValue: params.merchantValue + 1n }],
    [
      'feeReceiver',
      {
        feeReceiver: getAddress(
          '0x9999999999999999999999999999999999999999',
        ),
      },
    ],
    ['feeValue', { feeValue: params.feeValue + 1n }],
  ])('Settled の %s が不一致なら解錠しない', async (_field, mismatch) => {
    h.idem = { state: 'hash', txHash: HASH };
    h.used = true;
    h.receipt.logs = [
      transfer(FORWARDER, MERCHANT, params.merchantValue),
      transfer(FORWARDER, FEE_RECEIVER, params.feeValue),
      settledEvent(mismatch),
    ];
    expect(await resolveFacilitatorPaymentStatus({})).toMatchObject({
      ok: true,
      state: 'indeterminate',
    });
  });

  it('KV hash 経路は同一 receipt の複数 settle を Transfer 合算せず対象 event で解錠する', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    h.used = true;
    h.receipt.logs = batchedSettlementLogs();
    expect(await resolveFacilitatorPaymentStatus({})).toEqual({
      ok: true,
      chainId: 80002,
      payer: PAYER,
      state: 'settled',
      txHash: HASH,
    });
  });

  it('分割 log が揃っていても reverted receipt は解錠しない', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    h.used = true;
    h.receipt.status = 'reverted';
    expect(await resolveFacilitatorPaymentStatus({})).toMatchObject({
      ok: true,
      state: 'indeterminate',
    });
  });

  it('KV hash 無し + authorization used は AuthorizationUsed log の tx を検証する', async () => {
    h.used = true;
    h.logHash = LOG_HASH;
    const status = await resolveFacilitatorPaymentStatus({});
    expect(status).toMatchObject({
      ok: true,
      state: 'settled',
      txHash: LOG_HASH,
    });
    expect(findAuthorizationUsedTransactionHash).toHaveBeenCalledOnce();
  });

  it('AuthorizationUsed 再解決経路も複数 settle batch の対象 event で解錠する', async () => {
    h.used = true;
    h.logHash = LOG_HASH;
    h.receipt.logs = batchedSettlementLogs();
    expect(await resolveFacilitatorPaymentStatus({})).toEqual({
      ok: true,
      chainId: 80002,
      payer: PAYER,
      state: 'settled',
      txHash: LOG_HASH,
    });
  });

  it('KV の旧 hash が不成立なら AuthorizationUsed event の replacement tx を exact 検証する', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    h.used = true;
    h.logHash = LOG_HASH;
    h.receiptOverrides.set(HASH, { status: 'reverted', logs: [] });
    const status = await resolveFacilitatorPaymentStatus({});
    expect(status).toMatchObject({
      ok: true,
      state: 'settled',
      txHash: LOG_HASH,
    });
    expect(findAuthorizationUsedTransactionHash).toHaveBeenCalledOnce();
  });

  it('KV hash 無し + authorization unused は unused', async () => {
    expect(await resolveFacilitatorPaymentStatus({})).toMatchObject({
      ok: true,
      state: 'unused',
    });
  });

  it('receipt RPC 障害は既存処理へ throw せず indeterminate', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    h.used = true;
    h.receiptThrows = true;
    expect(await resolveFacilitatorPaymentStatus({})).toMatchObject({
      ok: true,
      state: 'indeterminate',
    });
  });
});
