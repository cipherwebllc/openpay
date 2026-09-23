import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';

type Receipt = {
  status: 'success' | 'reverted';
  logs: Array<{ address: Address; topics: Hex[]; data: Hex }>;
};

const h = vi.hoisted(() => ({
  enabled: true,
  provider: 'self-host' as 'self-host' | 'gelato' | null,
  rateAllowed: true,
  idem: { state: 'missing' } as
    | { state: 'missing' }
    | { state: 'hash'; txHash: Hex }
    | { state: 'indeterminate' },
  used: false,
  logHash: null as Hex | null,
  rpcThrows: false,
  receipt: { status: 'success', logs: [] } as Receipt,
  receipts: new Map<Hex, Receipt | Error>(),
  getReceipt: vi.fn(),
  forwarder: null as Address | null,
  signer: '0x1111111111111111111111111111111111111111' as Address,
}));

vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: () => ({ getTransactionReceipt: h.getReceipt }),
}));
vi.mock('@/lib/chains', () => ({
  chainObjectForId: () => ({ id: 80002 }),
  transportForChain: () => ({}),
}));
vi.mock('@/lib/env', () => ({
  env: {
    get enableJpycEip3009() {
      return h.enabled;
    },
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: vi.fn(async () => h.rateAllowed),
  readIdempotency: vi.fn(async () => h.idem),
}));
vi.mock('@/lib/relay/relayProvider', () => ({
  get PROVIDER() {
    return h.provider;
  },
  SUPPORTED_CHAINS: { 80002: {} },
  jpycAddressFor: () =>
    '0x2222222222222222222222222222222222222222' as Address,
  readAuthorizationUsed: vi.fn(async () => {
    if (h.rpcThrows) throw new Error('rpc down');
    return h.used;
  }),
  findAuthorizationUsedTransactionHash: vi.fn(async () => h.logHash),
}));
vi.mock('@/lib/relay/forwarderConfig', () => ({
  jpycForwarderFor: () => h.forwarder,
}));
vi.mock('@/lib/relay/forwarderSettleService', () => ({
  feeReceiverFor: () =>
    '0x3333333333333333333333333333333333333333' as Address,
}));
vi.mock('@/lib/jpycEip3009', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycEip3009')>(
    '@/lib/jpycEip3009',
  );
  return {
    ...actual,
    recoverTransferAuthorizationSigner: vi.fn(async () => h.signer),
  };
});
vi.mock('@/lib/relay/forwarderSettle', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/relay/forwarderSettle')
  >('@/lib/relay/forwarderSettle');
  return {
    ...actual,
    recoverReceiveWithAuthorizationSigner: vi.fn(async () => h.signer),
  };
});

import {
  checkIpRateLimit,
  readIdempotency,
} from '@/lib/relay/relayGuards';
import {
  readAuthorizationUsed,
  findAuthorizationUsedTransactionHash,
} from '@/lib/relay/relayProvider';
import { recoverTransferAuthorizationSigner } from '@/lib/jpycEip3009';
import { logger } from '@/lib/logger';
import { POST } from '@/app/api/relay/jpyc/status/route';

const FROM = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'a'.repeat(64)}` as Hex;
const LOG_HASH = `0x${'b'.repeat(64)}` as Hex;
const NONCE = `0x${'1'.repeat(64)}` as Hex;
const TOKEN = '0x2222222222222222222222222222222222222222';
const FEE_RECEIVER = '0x3333333333333333333333333333333333333333';
const MERCHANT = '0x4444444444444444444444444444444444444444';
const FORWARDER = '0x5555555555555555555555555555555555555555';
const OTHER = '0x9999999999999999999999999999999999999999';
const OTHER_NONCE = `0x${'9'.repeat(64)}` as Hex;
const intent = {
  chainId: 80002,
  from: FROM,
  to: '0x4444444444444444444444444444444444444444',
  value: '1000000000000000000',
  validAfter: '0',
  validBefore: '9999999999',
  nonce: NONCE,
  signature: `0x${'2'.repeat(130)}`,
};
const forwarderIntent = {
  chainId: 80002,
  from: FROM,
  merchant: MERCHANT,
  merchantValue: intent.value,
  feeValue: '2000000000000000000',
  validAfter: intent.validAfter,
  validBefore: intent.validBefore,
  intentSalt: `0x${'3'.repeat(64)}` as Hex,
  signature: intent.signature,
} as const;
const FORWARDER_NONCE = buildForwarderNonce({
  ...forwarderIntent,
  merchantValue: BigInt(forwarderIntent.merchantValue),
  feeValue: BigInt(forwarderIntent.feeValue),
  feeReceiver: FEE_RECEIVER,
  validAfter: BigInt(forwarderIntent.validAfter),
  validBefore: BigInt(forwarderIntent.validBefore),
}, 80002, FORWARDER);
const EVENTS = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

function authorizationEvent(overrides: {
  emitter?: Address;
  authorizer?: Address;
  nonce?: Hex;
  eventName?: 'AuthorizationUsed' | 'AuthorizationCanceled';
} = {}): Receipt['logs'][number] {
  return {
    address: overrides.emitter ?? TOKEN,
    topics: encodeEventTopics({
      abi: EVENTS,
      eventName: overrides.eventName ?? 'AuthorizationUsed',
      args: { authorizer: overrides.authorizer ?? FROM, nonce: overrides.nonce ?? NONCE },
    }) as Hex[],
    data: '0x',
  };
}

function transfer(overrides: {
  emitter?: Address;
  from?: Address;
  to?: Address;
  value?: bigint;
} = {}): Receipt['logs'][number] {
  return {
    address: overrides.emitter ?? TOKEN,
    topics: encodeEventTopics({
      abi: EVENTS,
      eventName: 'Transfer',
      args: { from: overrides.from ?? FROM, to: overrides.to ?? MERCHANT },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [overrides.value ?? BigInt(intent.value)]),
  };
}

function settledEvent(overrides: {
  emitter?: Address;
  from?: Address;
  nonce?: Hex;
  merchant?: Address;
  merchantValue?: bigint;
  feeReceiver?: Address;
  feeValue?: bigint;
} = {}): Receipt['logs'][number] {
  return {
    address: overrides.emitter ?? FORWARDER,
    topics: encodeEventTopics({
      abi: EVENTS,
      eventName: 'Settled',
      args: {
        from: overrides.from ?? FROM,
        nonce: overrides.nonce ?? FORWARDER_NONCE,
        merchant: overrides.merchant ?? MERCHANT,
      },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
      [
        overrides.merchantValue ?? BigInt(forwarderIntent.merchantValue),
        overrides.feeReceiver ?? FEE_RECEIVER,
        overrides.feeValue ?? BigInt(forwarderIntent.feeValue),
      ],
    ),
  };
}

function nonceIntent(nonce: Hex = NONCE) {
  return { lookup: 'nonce', chainId: 80002, from: FROM, nonce };
}

function req(body: unknown = intent) {
  return new Request('http://localhost/api/relay/jpyc/status', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IP_HASH_SECRET', 'status-test-secret-32-bytes-long!!');
  h.enabled = true;
  h.provider = 'self-host';
  h.rateAllowed = true;
  h.idem = { state: 'missing' };
  h.used = false;
  h.logHash = null;
  h.rpcThrows = false;
  h.receipt = { status: 'success', logs: [authorizationEvent(), transfer()] };
  h.receipts.clear();
  h.getReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
    const receipt = h.receipts.get(hash) ?? h.receipt;
    if (receipt instanceof Error) throw receipt;
    return receipt;
  });
  h.forwarder = null;
  h.signer = FROM;
});

describe('POST /api/relay/jpyc/status', () => {
  it('署名が from に recover しなければ 400', async () => {
    h.signer = '0x9999999999999999999999999999999999999999';
    const res = await POST(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'signature_mismatch' });
  });

  it.each(['signed', 'nonce'] as const)('KV hash + authorization 未使用は %s lookup でも indeterminate', async (lookup) => {
    h.idem = { state: 'hash', txHash: HASH };
    const res = await POST(req(lookup === 'nonce' ? nonceIntent() : intent));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
    expect(readAuthorizationUsed).toHaveBeenCalledOnce();
  });

  it('KV 無し + authorization used + ログ発見で settled txHash', async () => {
    h.used = true;
    h.logHash = LOG_HASH;
    const res = await POST(req());
    expect(await res.json()).toEqual({
      ok: true,
      state: 'settled',
      txHash: LOG_HASH,
    });
  });

  it('used/cancelled だが有界ログ走査で見つからなければ indeterminate', async () => {
    h.used = true;
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });

  it('authorization unused を返す', async () => {
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, state: 'unused' });
  });

  it('nonce lookup は署名なしで同じ read-only 状態を照会する', async () => {
    h.used = true;
    h.logHash = LOG_HASH;
    const res = await POST(
      req({
        lookup: 'nonce',
        chainId: 80002,
        from: FROM,
        nonce: NONCE,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      state: 'settled',
      txHash: LOG_HASH,
    });
    expect(readIdempotency).toHaveBeenCalledWith(
      'relay:idem:',
      80002,
      FROM,
      NONCE,
    );
    expect(readAuthorizationUsed).toHaveBeenCalledWith(
      80002,
      expect.any(String),
      FROM,
      NONCE,
    );
    expect(findAuthorizationUsedTransactionHash).toHaveBeenCalledWith(
      80002,
      expect.any(String),
      FROM,
      NONCE,
    );
    expect(recoverTransferAuthorizationSigner).not.toHaveBeenCalled();
  });

  it.each([
    [{ lookup: 'nonce', chainId: 1, from: FROM, nonce: NONCE }],
    [{ lookup: 'nonce', chainId: 80002, from: 'not-an-address', nonce: NONCE }],
    [{ lookup: 'nonce', chainId: 80002, from: FROM, nonce: '0x1234' }],
  ])('不正な nonce lookup は 400', async (body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(readIdempotency).not.toHaveBeenCalled();
  });

  it('RPC 障害は HTTP 200 indeterminate', async () => {
    h.rpcThrows = true;
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });

  it('構成済み KV の read 障害は HTTP 200 indeterminate', async () => {
    h.idem = { state: 'indeterminate' };
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });

  it('recover payload も relay route と同形で署名確認して判定する', async () => {
    h.forwarder = '0x5555555555555555555555555555555555555555';
    const res = await POST(
      req({
        chainId: 80002,
        from: FROM,
        merchant: '0x4444444444444444444444444444444444444444',
        merchantValue: '1000000000000000000',
        feeValue: '2000000000000000000',
        validAfter: '0',
        validBefore: '9999999999',
        intentSalt: `0x${'3'.repeat(64)}`,
        signature: `0x${'2'.repeat(130)}`,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'unused' });
  });

  it('relay-status 30/60 の IP rate limit を適用する', async () => {
    h.rateAllowed = false;
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'ip_rate_limited' });
    expect(checkIpRateLimit).toHaveBeenCalledWith(
      'relay-status',
      expect.anything(),
      30,
      60,
    );
  });

  it('既存 JPYC EIP-3009 flag OFF は 404', async () => {
    h.enabled = false;
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('relay status の成功 on-chain 証拠 (A1)', () => {
  beforeEach(() => {
    h.used = true;
    h.idem = { state: 'hash', txHash: HASH };
  });

  it.each(['signed', 'nonce'] as const)('KV hash でも %s lookup の成功 receipt と対象 authorization を確認する', async (lookup) => {
    const res = await POST(req(lookup === 'nonce' ? nonceIntent() : intent));
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: HASH });
    expect(h.getReceipt).toHaveBeenCalledWith({ hash: HASH });
    expect(readAuthorizationUsed).toHaveBeenCalledOnce();
    expect(findAuthorizationUsedTransactionHash).not.toHaveBeenCalled();
  });

  it.each(['KV', 'log'] as const)('%s hash の reverted receipt は settled にしない', async (source) => {
    if (source === 'log') h.idem = { state: 'missing' };
    h.logHash = LOG_HASH;
    h.receipt.status = 'reverted';
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });

  it.each(['TransactionReceiptNotFoundError', 'rpc unavailable'])(
    'receipt が読めない (%s) 場合は KV hash に fallback しない',
    async (reason) => {
      h.logHash = LOG_HASH;
      const error = new Error(reason);
      error.name = reason;
      h.getReceipt.mockRejectedValue(error);
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
      expect(logger.warn).toHaveBeenCalledTimes(2);
      for (const txHash of [HASH, LOG_HASH]) {
        expect(logger.warn).toHaveBeenCalledWith(
          'relay.jpyc.status.receipt_unreadable',
          { chainId: 80002, txHash, error },
        );
      }
    },
  );

  it('KV hash があっても authorizationState の RPC 障害は indeterminate', async () => {
    h.rpcThrows = true;
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });

  it.each(['different payment', 'missing receipt'] as const)(
    'KV の %s を使わず AuthorizationUsed log の成功 receipt へ回復する',
    async (reason) => {
      h.logHash = LOG_HASH;
      h.receipts.set(HASH, reason === 'missing receipt'
        ? new Error('receipt not found')
        : { status: 'success', logs: [authorizationEvent({ nonce: OTHER_NONCE }), transfer()] });
      const res = await POST(req());
      expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: LOG_HASH });
      expect(h.getReceipt).toHaveBeenCalledWith({ hash: LOG_HASH });
      if (reason === 'missing receipt') {
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledWith(
          'relay.jpyc.status.receipt_unreadable',
          { chainId: 80002, txHash: HASH, error: h.receipts.get(HASH) },
        );
      } else {
        expect(logger.warn).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['no events', () => []],
    ['transfer only', () => [transfer()]],
    ['authorization only', () => [authorizationEvent()]],
    ['cancelled + unrelated transfer', () => [authorizationEvent({ eventName: 'AuthorizationCanceled' }), transfer()]],
    ['other nonce at same merchant', () => [authorizationEvent({ nonce: OTHER_NONCE }), transfer()]],
    ['other authorizer', () => [authorizationEvent({ authorizer: OTHER }), transfer()]],
    ['fake AuthorizationUsed emitter', () => [authorizationEvent({ emitter: OTHER }), transfer()]],
    ['wrong token transfer', () => [authorizationEvent(), transfer({ emitter: OTHER })]],
    ['wrong sender transfer', () => [authorizationEvent(), transfer({ from: OTHER })]],
  ] as const)('%s は signed / nonce lookup のどちらも成功証拠にしない', async (_reason, logs) => {
    h.receipt.logs = logs();
    h.logHash = LOG_HASH;
    for (const body of [intent, nonceIntent()]) {
      const res = await POST(req(body));
      expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
    }
  });

  it.each([
    ['recipient', { to: OTHER }],
    ['amount too low', { value: BigInt(intent.value) - 1n }],
    ['amount too high', { value: BigInt(intent.value) + 1n }],
  ] as const)('signed free intent の %s 不一致は settled にしない', async (_field, override) => {
    h.receipt.logs = [authorizationEvent(), transfer(override)];
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });

  it('free batch 内に同じ宛先への別 Transfer があっても対象送金を照合する', async () => {
    h.receipt.logs.push(authorizationEvent({ nonce: OTHER_NONCE }), transfer());
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: HASH });
  });

  it.each(['signed', 'nonce'] as const)('forwarder の %s lookup は一致する Settled event で成功する', async (lookup) => {
    h.forwarder = FORWARDER;
    h.receipt.logs = [settledEvent({ nonce: OTHER_NONCE }), settledEvent()];
    const res = await POST(req(lookup === 'nonce' ? nonceIntent(FORWARDER_NONCE) : forwarderIntent));
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: HASH });
    expect(h.getReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it('forwarder は AuthorizationUsed log から再解決した receipt も照合する', async () => {
    h.forwarder = FORWARDER;
    h.logHash = LOG_HASH;
    h.receipts.set(HASH, { status: 'success', logs: [settledEvent({ nonce: OTHER_NONCE })] });
    h.receipt.logs = [settledEvent()];
    const res = await POST(req(forwarderIntent));
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: LOG_HASH });
  });

  it.each([
    ['other nonce', () => [settledEvent({ nonce: OTHER_NONCE })]],
    ['other payer', () => [settledEvent({ from: OTHER })]],
    ['fake emitter', () => [settledEvent({ emitter: OTHER })]],
    ['direct transfer without Settled', () => [
      authorizationEvent({ nonce: FORWARDER_NONCE }),
      transfer({ to: FORWARDER, value: BigInt(intent.value) + BigInt(forwarderIntent.feeValue) }),
      transfer({ from: FORWARDER }),
    ]],
  ] as const)('forwarder %s は signed / nonce lookup のどちらも成功証拠にしない', async (_reason, logs) => {
    h.forwarder = FORWARDER;
    h.receipt.logs = logs();
    h.logHash = LOG_HASH;
    for (const body of [forwarderIntent, nonceIntent(FORWARDER_NONCE)]) {
      const res = await POST(req(body));
      expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
    }
  });

  it.each([
    ['merchant', { merchant: OTHER }],
    ['merchantValue', { merchantValue: 1n }],
    ['feeReceiver', { feeReceiver: OTHER }],
    ['feeValue', { feeValue: 1n }],
  ] as const)('signed forwarder intent の %s 不一致は settled にしない', async (_field, override) => {
    h.forwarder = FORWARDER;
    h.receipt.logs = [settledEvent(override)];
    const res = await POST(req(forwarderIntent));
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });

  it('Settled event が一致しても forwarder receipt が reverted なら indeterminate', async () => {
    h.forwarder = FORWARDER;
    h.receipt = { status: 'reverted', logs: [settledEvent()] };
    const res = await POST(req(forwarderIntent));
    expect(await res.json()).toEqual({ ok: true, state: 'indeterminate' });
  });
});
