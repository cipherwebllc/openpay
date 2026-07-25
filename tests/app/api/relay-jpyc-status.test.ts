import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

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
  forwarder: null as Address | null,
  signer: '0x1111111111111111111111111111111111111111' as Address,
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
import { POST } from '@/app/api/relay/jpyc/status/route';

const FROM = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'a'.repeat(64)}` as Hex;
const LOG_HASH = `0x${'b'.repeat(64)}` as Hex;
const NONCE = `0x${'1'.repeat(64)}` as Hex;
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

  it('KV に txHash があれば settled を返し RPC を読まない', async () => {
    h.idem = { state: 'hash', txHash: HASH };
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: HASH });
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

  it('used だが有界ログ走査で見つからなければ settled null', async () => {
    h.used = true;
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: true, state: 'settled', txHash: null });
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
