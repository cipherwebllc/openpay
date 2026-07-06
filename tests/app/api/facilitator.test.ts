// x402 facilitator route の end-to-end テスト (/supported /verify /settle)。
// recover e2e (relay-jpyc-recover-e2e.test.ts) と同型: viem は createPublicClient のみ最小モック
// (forwarder 健全性 getBytecode/token/feeReceiver + balanceOf + authorizationState) し、署名 recover
// (recoverTypedDataAddress) は実物。顧客署名は privateKeyToAccount(...).signTypedData(...) で本物を作る
// (buildReceiveWithAuthorizationTypedData = hook/facilitator と同式)。submit/poll は selfHostRelayer を
// モックして success に倒す。Amoy(80002・testnet) を使い MAINNET_CHAINS の KV/gas-ceiling 前提を回避。

import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Hex } from 'viem';
import {
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';

const JPYC = 10n ** 18n;
const AMOY = 80002;
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const MERCHANT = getAddress('0x1234567890123456789012345678901234567890');
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const BIG_BALANCE = 1_000_000n * JPYC;

// 残高/健全性/authState だけ stub: viem は importOriginal で実物を保ち (recoverTypedDataAddress は実物)、
// createPublicClient のみ差し替える。createWalletClient は実物 (selfHostIoFor が組むが submit はモック)。
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBytecode: async () => '0x60' as `0x${string}`,
      readContract: async (args: { functionName?: string }) => {
        if (args.functionName === 'token') return JPYC_AMOY;
        if (args.functionName === 'feeReceiver') return FEE_RECEIVER;
        if (args.functionName === 'authorizationState') return false;
        return BIG_BALANCE; // balanceOf → 残高十分 (success/verify を通す)
      },
      getBalance: async () => 10n ** 18n,
      estimateGas: async () => 21000n,
      getTransactionCount: async () => 0,
      waitForTransactionReceipt: async () => ({
        status: 'success',
        transactionHash: TX_HASH,
      }),
      sendRawTransaction: async () => TX_HASH,
    }),
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// submit/poll は success に倒す (selfHostIoFor が組む io は submitSelfHost モックが無視する)。
vi.mock('@/lib/relay/selfHostRelayer', () => ({
  submitSelfHost: vi.fn(async () => ({ taskId: TX_HASH })),
  pollSelfHost: vi.fn(async () => ({ state: 'success', txHash: TX_HASH })),
  RELAYER_RECEIPT_TIMEOUT_MS: 1000,
}));

const CUSTOMER_PK = `0x${'a1'.repeat(32)}` as Hex;
const RELAYER_PK = `0x${'11'.repeat(32)}` as Hex;
const WRONG_PK = `0x${'b2'.repeat(32)}` as Hex;
const customerAccount = privateKeyToAccount(CUSTOMER_PK);
const wrongAccount = privateKeyToAccount(WRONG_PK);
const CUSTOMER = getAddress(customerAccount.address);
const RECEIPT_PK = `0x${'c3'.repeat(32)}` as Hex;
const RECEIPT_SIGNER = getAddress(privateKeyToAccount(RECEIPT_PK).address);

async function signReceive(
  params: ForwarderSettleParams,
  signer = customerAccount,
): Promise<Hex> {
  const typed = buildReceiveWithAuthorizationTypedData(
    params,
    AMOY,
    JPYC_AMOY,
    FORWARDER,
  );
  return signer.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
}

type Handlers = {
  supported: () => Promise<Response>;
  verify: (req: Request) => Promise<Response>;
  settle: (req: Request) => Promise<Response>;
  verifyReceipt: (req: Request) => Promise<Response>;
};

async function loadFacilitator(opts?: {
  flag?: string;
  relayerKey?: string;
  forwarder?: string; // '' で forwarder 未設定 (not-ready 枝の検証用)
}): Promise<Handlers> {
  vi.stubEnv(
    'NEXT_PUBLIC_ENABLE_X402_FACILITATOR',
    opts?.flag === undefined ? '1' : opts.flag,
  );
  vi.stubEnv('RELAYER_PRIVATE_KEY', opts?.relayerKey ?? RELAYER_PK);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', opts?.forwarder ?? FORWARDER);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  vi.stubEnv('X402_FEE_BPS', '100'); // 1%
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2'); // 2 JPYC floor
  vi.stubEnv('X402_RECEIPT_SIGNING_KEY', RECEIPT_PK); // receipt 署名鍵
  vi.resetModules();
  // 自己検証: route が解決する JPYC アドレスが署名 domain と一致 (ずれると署名検証が通らず LARP)。
  const { resolveDeployment } = await import('@/lib/tokens');
  const resolved = resolveDeployment('jpyc', AMOY);
  if (!resolved || getAddress(resolved.address) !== JPYC_AMOY) {
    throw new Error(`JPYC address drift: ${resolved?.address} != ${JPYC_AMOY}`);
  }
  const supported = await import('@/app/api/facilitator/supported/route');
  const verify = await import('@/app/api/facilitator/verify/route');
  const settle = await import('@/app/api/facilitator/settle/route');
  const verifyReceipt = await import(
    '@/app/api/facilitator/verify-receipt/route'
  );
  return {
    supported: supported.GET as () => Promise<Response>,
    verify: verify.POST as (req: Request) => Promise<Response>,
    settle: settle.POST as (req: Request) => Promise<Response>,
    verifyReceipt: verifyReceipt.POST as (req: Request) => Promise<Response>,
  };
}

function reqOf(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function facilitatorBody(
  params: ForwarderSettleParams,
  signature: Hex,
  network = 'eip155:80002',
): Record<string, unknown> {
  return {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact',
      network,
      payload: {
        signature,
        authorization: {
          from: params.from,
          validAfter: params.validAfter.toString(),
          validBefore: params.validBefore.toString(),
          intentSalt: params.intentSalt,
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network,
      maxAmountRequired: (params.merchantValue + params.feeValue).toString(),
      resource: 'https://api.example.jp/paid/translate',
      description: 'test',
      mimeType: '',
      payTo: FORWARDER,
      maxTimeoutSeconds: 600,
      asset: JPYC_AMOY,
      extra: {
        name: 'JPY Coin',
        version: '1',
        decimals: 18,
        assetTransferMethod: 'eip3009',
        openpay: {
          mode: 'forwarder-split',
          forwarder: FORWARDER,
          merchant: params.merchant,
          merchantValue: params.merchantValue.toString(),
          feeReceiver: params.feeReceiver,
          feeValue: params.feeValue.toString(),
          commitVersion: `0x${'00'.repeat(32)}`,
        },
      },
    },
  };
}

const validBefore = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const SALT = `0x${'22'.repeat(32)}` as Hex;

// merchantValue=1000 JPYC → x402FeeValue = max(2, 1%×1000=10) = 10 JPYC。
function goodParams(feeValueOverride?: bigint): ForwarderSettleParams {
  return {
    from: CUSTOMER,
    merchant: MERCHANT,
    merchantValue: 1000n * JPYC,
    feeReceiver: FEE_RECEIVER,
    feeValue: feeValueOverride ?? 10n * JPYC,
    validAfter: 0n,
    validBefore: validBefore(),
    intentSalt: SALT,
  };
}

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('x402 facilitator /supported', () => {
  it('flag OFF → 404 (完全 inert)', async () => {
    const { supported } = await loadFacilitator({ flag: '' });
    const res = await supported();
    expect(res.status).toBe(404);
  });

  it('flag ON → kinds に JPYC exact / eip155:80002 / forwarder 分割記述子', async () => {
    const { supported } = await loadFacilitator();
    const res = await supported();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      x402Version: number;
      receiptSigner: string;
      kinds: Array<{
        scheme: string;
        network: string;
        asset: string;
        extra: {
          assetTransferMethod: string;
          feeModel: { bps: number };
          openpay: { forwarder: string; feeReceiver: string };
        };
      }>;
    };
    expect(body.kinds).toHaveLength(1);
    const k = body.kinds[0];
    expect(k.scheme).toBe('exact');
    expect(k.network).toBe('eip155:80002');
    expect(getAddress(k.asset)).toBe(JPYC_AMOY);
    expect(k.extra.assetTransferMethod).toBe('eip3009');
    expect(k.extra.feeModel.bps).toBe(100);
    expect(getAddress(k.extra.openpay.forwarder)).toBe(FORWARDER);
    expect(getAddress(k.extra.openpay.feeReceiver)).toBe(FEE_RECEIVER);
    // 受領証明の公開 signer (オフライン検証の期待値)。
    expect(getAddress(body.receiptSigner)).toBe(RECEIPT_SIGNER);
  });
});

describe('x402 facilitator /verify', () => {
  it('flag OFF → 404', async () => {
    const { verify } = await loadFacilitator({ flag: '' });
    const res = await verify(reqOf('http://x/verify', {}));
    expect(res.status).toBe(404);
  });

  it('正しい署名 + 正しい fee + 残高十分 → isValid:true + payer', async () => {
    const { verify } = await loadFacilitator();
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await verify(reqOf('http://x/verify', facilitatorBody(params, sig)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: CUSTOMER });
  });

  it('誤った fee (5 JPYC) → isValid:false fee_value_mismatch (server 権威)', async () => {
    const { verify } = await loadFacilitator();
    const params = goodParams(5n * JPYC); // expected は 10 JPYC
    const sig = await signReceive(params);
    const res = await verify(reqOf('http://x/verify', facilitatorBody(params, sig)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      isValid: false,
      invalidReason: 'fee_value_mismatch',
      payer: CUSTOMER,
    });
  });

  it('別鍵で署名 → isValid:false signature_mismatch (実 recover が走る)', async () => {
    const { verify } = await loadFacilitator();
    const params = goodParams();
    const sig = await signReceive(params, wrongAccount);
    const res = await verify(reqOf('http://x/verify', facilitatorBody(params, sig)));
    expect(await res.json()).toEqual({
      isValid: false,
      invalidReason: 'signature_mismatch',
      payer: CUSTOMER,
    });
  });

  it('対象外 network → isValid:false unsupported_network', async () => {
    const { verify } = await loadFacilitator();
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await verify(
      reqOf('http://x/verify', facilitatorBody(params, sig, 'eip155:1')),
    );
    expect(await res.json()).toMatchObject({
      isValid: false,
      invalidReason: 'unsupported_network',
    });
  });

  it('不正 JSON → 400 invalid_json', async () => {
    const { verify } = await loadFacilitator();
    const bad = new Request('http://x/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await verify(bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ isValid: false, invalidReason: 'invalid_json' });
  });

  it('facilitator 未準備 (forwarder 未設定) → 503 forwarder_unconfigured', async () => {
    const { verify } = await loadFacilitator({ forwarder: '' });
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await verify(reqOf('http://x/verify', facilitatorBody(params, sig)));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      isValid: false,
      invalidReason: 'forwarder_unconfigured',
    });
  });
});

describe('x402 facilitator /settle', () => {
  it('flag OFF → 404', async () => {
    const { settle } = await loadFacilitator({ flag: '' });
    const res = await settle(reqOf('http://x/settle', {}));
    expect(res.status).toBe(404);
  });

  it('relayer 鍵なし (PROVIDER!=self-host) → 503 relay_not_configured', async () => {
    const { settle } = await loadFacilitator({ relayerKey: '' });
    const res = await settle(reqOf('http://x/settle', {}));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      success: false,
      errorReason: 'relay_not_configured',
    });
  });

  it('不正 JSON → 400 invalid_json', async () => {
    const { settle } = await loadFacilitator();
    const bad = new Request('http://x/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await settle(bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, errorReason: 'invalid_json' });
  });

  it('巨大ボディ (>4KB) → 413 payload_too_large', async () => {
    const { settle } = await loadFacilitator();
    const big = new Request('http://x/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'a'.repeat(5000) }), // MAX_BODY_BYTES=4096 超
    });
    const res = await settle(big);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ success: false, errorReason: 'payload_too_large' });
  });

  it('正しい署名 + 正しい fee → success + receipt 発行 → verify-receipt が valid', async () => {
    const { settle, verifyReceipt } = await loadFacilitator();
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await settle(reqOf('http://x/settle', facilitatorBody(params, sig)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      transaction: string;
      network: string;
      payer: string;
      receipt: {
        signature: string;
        amount: string;
        fee: string;
        payTo: string;
        txHash: string;
      } | null;
    };
    expect(body.success).toBe(true);
    expect(body.transaction).toBe(TX_HASH);
    expect(body.network).toBe('eip155:80002');
    expect(body.payer).toBe(CUSTOMER);
    // 受領証明: seller=表示額(1000)・手数料(10)・実 seller・on-chain tx を束ねて署名。
    expect(body.receipt).not.toBeNull();
    expect(body.receipt!.amount).toBe((1000n * JPYC).toString());
    expect(body.receipt!.fee).toBe((10n * JPYC).toString());
    expect(getAddress(body.receipt!.payTo)).toBe(MERCHANT);
    expect(body.receipt!.txHash).toBe(TX_HASH);
    expect(body.receipt!.signature).toBeTruthy();
    // round-trip: 発行された receipt を verify-receipt が valid と判定 (signer = 公開 facilitator signer)。
    const vr = await verifyReceipt(
      reqOf('http://x/verify-receipt', {
        receipt: body.receipt,
        signature: body.receipt!.signature,
      }),
    );
    expect(await vr.json()).toEqual({ valid: true, signer: RECEIPT_SIGNER });
  });

  it('誤った fee → 400 fee_value_mismatch (改竄 requirements は broadcast しない)', async () => {
    const { settle } = await loadFacilitator();
    const params = goodParams(5n * JPYC);
    const sig = await signReceive(params);
    const res = await settle(reqOf('http://x/settle', facilitatorBody(params, sig)));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'fee_value_mismatch',
    });
  });

  // fund-safety (server 権威・最重要): 悪意の resource-server が requirements.extra.openpay.feeReceiver を
  // 攻撃者アドレスにし、買い手がその上に **本物の署名** をしても、facilitator は params.feeReceiver !==
  // server の feeReceiver で broadcast 前に拒否する (手数料 1% は攻撃者へ流れない)。署名は有効でも settle
  // されないので買い手資金は安全。
  it('改竄 feeReceiver (攻撃者) + 実署名 → 400 fee_receiver_mismatch (broadcast しない)', async () => {
    const { settle } = await loadFacilitator();
    const ATTACKER = getAddress('0x9999999999999999999999999999999999999999');
    const params = { ...goodParams(), feeReceiver: ATTACKER };
    const sig = await signReceive(params); // 攻撃者 feeReceiver を含む split の上に本物で署名
    const res = await settle(reqOf('http://x/settle', facilitatorBody(params, sig)));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'fee_receiver_mismatch',
    });
  });

  it('構造不正ボディ → 400 invalid_body (broadcast しない)', async () => {
    const { settle } = await loadFacilitator();
    const res = await settle(reqOf('http://x/settle', { paymentPayload: 'nope' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, errorReason: 'invalid_body' });
  });

  it('facilitator 未準備 (forwarder 未設定) → 503 forwarder_unconfigured', async () => {
    const { settle } = await loadFacilitator({ forwarder: '' });
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await settle(reqOf('http://x/settle', facilitatorBody(params, sig)));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'forwarder_unconfigured',
    });
  });

  // on-chain 確定が revert: broadcast 済 tx を添えて success:false (再送不可) を 200 で返す。
  it('settle が reverted → 200 success:false errorReason:reverted + transaction', async () => {
    const { settle } = await loadFacilitator();
    const relayer = await import('@/lib/relay/selfHostRelayer');
    (relayer.pollSelfHost as unknown as Mock).mockResolvedValueOnce({
      state: 'reverted',
      txHash: TX_HASH,
    });
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await settle(reqOf('http://x/settle', facilitatorBody(params, sig)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'reverted',
      transaction: TX_HASH,
      network: 'eip155:80002',
      payer: CUSTOMER,
    });
  });

  // broadcast 済だが未確定 → 202 (client は再送してはならない = 二重支払い防止)。
  it('settle が pending → 202 success:false errorReason:pending', async () => {
    const { settle } = await loadFacilitator();
    const relayer = await import('@/lib/relay/selfHostRelayer');
    (relayer.pollSelfHost as unknown as Mock).mockResolvedValueOnce({
      state: 'pending',
      txHash: TX_HASH,
    });
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await settle(reqOf('http://x/settle', facilitatorBody(params, sig)));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'pending',
      transaction: TX_HASH,
    });
  });

  // poll が確実な失敗 (未送信) → 502 relay_error。
  it('settle の poll が error → 502 relay_error', async () => {
    const { settle } = await loadFacilitator();
    const relayer = await import('@/lib/relay/selfHostRelayer');
    (relayer.pollSelfHost as unknown as Mock).mockResolvedValueOnce({
      state: 'error',
      detail: 'rpc_unavailable',
    });
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await settle(reqOf('http://x/settle', facilitatorBody(params, sig)));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: false, errorReason: 'relay_error' });
  });

  // submit (broadcast) 自体が throw → broadcast 前失敗 → 502 relay_error。
  it('settle の submit が throw → 502 relay_error (broadcast 前失敗)', async () => {
    const { settle } = await loadFacilitator();
    const relayer = await import('@/lib/relay/selfHostRelayer');
    (relayer.submitSelfHost as unknown as Mock).mockRejectedValueOnce(
      new Error('rpc down'),
    );
    const params = goodParams();
    const sig = await signReceive(params);
    const res = await settle(reqOf('http://x/settle', facilitatorBody(params, sig)));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: false, errorReason: 'relay_error' });
  });
});

// verify-receipt の正常系 (valid:true round-trip) は /settle テストで担保。ここは入力検証の枝。
describe('x402 facilitator /verify-receipt (入力検証)', () => {
  // parseReceipt が受理する最小の正当な receipt 形 (署名検証前の形チェック用)。
  const VALID_RECEIPT = {
    txHash: TX_HASH,
    payer: CUSTOMER,
    payTo: MERCHANT,
    amount: (1000n * JPYC).toString(),
    fee: (10n * JPYC).toString(),
    asset: JPYC_AMOY,
    chainId: AMOY,
    timestamp: 1_700_000_000,
    nonce: SALT,
  };

  it('flag OFF → 404', async () => {
    const { verifyReceipt } = await loadFacilitator({ flag: '' });
    const res = await verifyReceipt(reqOf('http://x/verify-receipt', {}));
    expect(res.status).toBe(404);
  });

  it('不正 JSON → 400 invalid_json', async () => {
    const { verifyReceipt } = await loadFacilitator();
    const bad = new Request('http://x/verify-receipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await verifyReceipt(bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ valid: false, error: 'invalid_json' });
  });

  // DoS ガード (兄弟 verify/settle と同型): 無認証 route なので body 上限を前段で強制する。
  it('巨大ボディ (>4KB) → 413 payload_too_large', async () => {
    const { verifyReceipt } = await loadFacilitator();
    const big = new Request('http://x/verify-receipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'a'.repeat(5000) }), // MAX_BODY_BYTES=4096 超
    });
    const res = await verifyReceipt(big);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ valid: false, error: 'payload_too_large' });
  });

  // レート制限が route に配線され、超過時に 429 で弾く (KV 未設定の平常時は fail-open で通過 —
  // 正常系は他の verify-receipt テストが 200 応答で担保)。checkReadRateLimit を false に固定して発火させる。
  it('rate limit 超過 → 429 rate_limited', async () => {
    vi.doMock('@/lib/relay/relayGuards', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('@/lib/relay/relayGuards')>();
      return { ...actual, checkReadRateLimit: async () => false };
    });
    try {
      const { verifyReceipt } = await loadFacilitator();
      const res = await verifyReceipt(
        reqOf('http://x/verify-receipt', {
          receipt: VALID_RECEIPT,
          signature: `0x${'11'.repeat(65)}`,
        }),
      );
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ valid: false, error: 'rate_limited' });
    } finally {
      vi.doUnmock('@/lib/relay/relayGuards');
    }
  });

  it('object でない body (JSON number) → {valid:false, signer:null}', async () => {
    const { verifyReceipt } = await loadFacilitator();
    const req = new Request('http://x/verify-receipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '5',
    });
    const res = await verifyReceipt(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false, signer: null });
  });

  it('receipt 欠落/不正形 → {valid:false, signer:null}', async () => {
    const { verifyReceipt } = await loadFacilitator();
    const res = await verifyReceipt(
      reqOf('http://x/verify-receipt', { receipt: { bogus: 1 }, signature: `0x${'11'.repeat(65)}` }),
    );
    expect(await res.json()).toEqual({ valid: false, signer: null });
  });

  it('signature が hex でない → {valid:false, signer:null}', async () => {
    const { verifyReceipt } = await loadFacilitator();
    const res = await verifyReceipt(
      reqOf('http://x/verify-receipt', { receipt: VALID_RECEIPT, signature: 'not-hex' }),
    );
    expect(await res.json()).toEqual({ valid: false, signer: null });
  });

  it('壊れた署名 (recover 不能) → {valid:false, signer:null} (例外を握る)', async () => {
    const { verifyReceipt } = await loadFacilitator();
    // hex だが復元不能な署名 (r=s=0)。verifyReceipt の recover が throw → catch。
    const res = await verifyReceipt(
      reqOf('http://x/verify-receipt', {
        receipt: VALID_RECEIPT,
        signature: `0x${'00'.repeat(65)}`,
      }),
    );
    expect(await res.json()).toEqual({ valid: false, signer: null });
  });

  it('正当 receipt + 別 receipt の本物署名 → valid:false (中身と署名が不整合)', async () => {
    const { settle, verifyReceipt } = await loadFacilitator();
    // settle 成功で発行された本物 receipt を 2 つ作り、receipt 本体と署名を入れ替える。
    // 署名は本物 (facilitator 鍵) だが対象 receipt が違う → 復元 signer は別アドレス → valid:false。
    const params = goodParams();
    const settled = (await (
      await settle(reqOf('http://x/settle', facilitatorBody(params, await signReceive(params))))
    ).json()) as { receipt: Record<string, unknown> };
    const other = { ...goodParams(), intentSalt: `0x${'33'.repeat(32)}` as Hex };
    const otherSettled = (await (
      await settle(reqOf('http://x/settle', facilitatorBody(other, await signReceive(other))))
    ).json()) as { receipt: { signature: string } };
    const res = await verifyReceipt(
      reqOf('http://x/verify-receipt', {
        receipt: settled.receipt, // 中身は 1 つ目の receipt
        signature: otherSettled.receipt.signature, // 署名は 2 つ目の receipt のもの
      }),
    );
    expect(((await res.json()) as { valid: boolean }).valid).toBe(false);
  });
});
