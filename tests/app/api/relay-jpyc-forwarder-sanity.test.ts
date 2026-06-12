// CDX-1: handleRecover の forwarder 健全性チェック (on-chain sanity) を実 POST で検証する。
//
// env の forwarder アドレスは isAddress() 構文チェックしか経ていない。EOA や別 token/別 feeReceiver の
// コントラクトが設定されると、relayer の settle() が no-op で SUCCESS し「API 成功・着金ゼロ・
// authorization 未消費」になる (false flow)。route は submit 前に forwarder の bytecode / token() /
// feeReceiver() を読み:
//   DETERMINISTIC 無効 (bytecode 無し / token != jpyc / feeReceiver != env.feeReceiver) → fail CLOSED
//     で 503 relay_not_configured。
//   TRANSIENT (RPC throw) → ブロックしない (RPC flake で正当決済を落とさない) → 続行。
//   valid → 続行 (本テストでは残高 0n で insufficient_balance に到達 = 「チェックを通過した」証明)。
//
// seam: viem の createPublicClient のみ最小モック。getBytecode / readContract(token/feeReceiver) /
// readContract(balanceOf) を per-test で差し替える。Amoy (testnet) を使い mainnet 限定の KV/gas-ceiling を回避。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';

const JPYC = 10n ** 18n;
const AMOY = 80002;
// route の jpycAddressFor が解決する Amoy JPYC アドレス (vitest.config の NEXT_PUBLIC_JPYC_TESTNET_ADDRESS)。
// forwarder の token() がこれと一致するかを route が照合するため、解決値と完全一致させる必要がある。
// 署名は不要 (forwarder チェックは署名 recover より前に到達する)。
const JPYC_AMOY = getAddress('0x0000000000000000000000000000000000000abc');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const WRONG_ADDR = getAddress('0x9999999999999999999999999999999999999999');
const CUSTOMER = getAddress('0x0000000000000000000000000000000000000def');
const MERCHANT = getAddress('0x0000000000000000000000000000000000001a2b');

// per-test で挙動を差し替える forwarder read のシナリオ。
type Scenario = {
  getBytecode: () => Promise<Hex | undefined>;
  token: () => Promise<string>;
  feeReceiver: () => Promise<string>;
};
let scenario: Scenario;

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      // CDX-1 forwarder sanity の seam。
      getBytecode: (args: { address: string }) => {
        // forwarder アドレスのみ scenario を適用 (他アドレスは code 有り扱い)。
        if (getAddress(args.address) === FORWARDER) return scenario.getBytecode();
        return Promise.resolve('0x1234' as Hex);
      },
      readContract: (args: { functionName: string }) => {
        if (args.functionName === 'token') return scenario.token();
        if (args.functionName === 'feeReceiver') return scenario.feeReceiver();
        if (args.functionName === 'balanceOf') return Promise.resolve(0n);
        if (args.functionName === 'authorizationState') return Promise.resolve(false);
        return Promise.resolve(0n);
      },
      // self-host IO (submit 経路) が触りうるメソッド (valid ケースは残高 0 で submit 前に弾かれる)。
      getBalance: () => Promise.resolve(0n),
      estimateGas: () => Promise.resolve(21000n),
      getTransactionCount: () => Promise.resolve(0),
      waitForTransactionReceipt: () =>
        Promise.resolve({ status: 'success', transactionHash: `0x${'0'.repeat(64)}` }),
      sendRawTransaction: () => Promise.resolve(`0x${'0'.repeat(64)}`),
    }),
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// self-host relayer 有効化 + Amoy forwarder 設定 + fee receiver (import 前に env を立てる)。
vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = '0x' + '1'.repeat(64);
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY =
    '0x752b7aad0089286eb7b553d84d05233d80c9fcb4';
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, feeReceiver: FEE_RECEIVER, feeReceiverConfigured: true },
  };
});

// recoverFeeValue は実物 (bps=0 → フロア 2 JPYC)。feeValue=2 JPYC を送って fee 検証を通す。
// 署名は recover より前 (feeReceiver/feeValue/merchantValue) を通過後に呼ばれるが、forwarder チェックは
// その更に後・残高チェックの直前にある。よって forwarder チェックの結果を観測するには署名検証も通す
// 必要がある… ではなく、本 route は forwarder チェックを deps 構築前 (署名検証の forwarderRecover 呼出前)
// に置く。実装上 verifyRecoverForwarder は handleRecover 内・recoverViaForwarder 呼出前に走るため、
// 無効 forwarder は署名に到達せず 503 になる。valid のときのみ recoverViaForwarder へ進み、そこで署名
// 検証 (signature 'b'*130 は無効) で弾かれるが、本テストは forwarder チェックの 503/通過のみを見る。

let POST: (req: Request) => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  // 既定 = valid forwarder。
  scenario = {
    getBytecode: () => Promise.resolve('0x6080' as Hex),
    token: () => Promise.resolve(JPYC_AMOY),
    feeReceiver: () => Promise.resolve(FEE_RECEIVER),
  };
  const mod = await import('@/app/api/relay/jpyc/route');
  POST = mod.POST as (req: Request) => Promise<Response>;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(over: Record<string, unknown> = {}): Promise<Response> {
  return POST(
    new Request('http://localhost/api/relay/jpyc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chainId: AMOY,
        from: CUSTOMER,
        merchant: MERCHANT,
        merchantValue: (1_000n * JPYC).toString(),
        feeValue: (2n * JPYC).toString(), // bps=0 → フロア 2 JPYC (fee 検証を通す)
        gasMode: 'customer',
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        intentSalt: '0x' + '22'.repeat(32),
        signature: '0x' + 'b'.repeat(130),
        ...over,
      }),
    }),
  );
}

describe('CDX-1: handleRecover forwarder 健全性チェック', () => {
  it('valid forwarder (code 有り・token/feeReceiver 一致) → 503 にならず先へ進む (署名/残高で弾かれる)', async () => {
    const res = await post();
    // forwarder チェックを通過 → recoverViaForwarder へ進み、無効署名 (signature_mismatch) 等で
    // 弾かれる。重要なのは relay_not_configured (503) を返さないこと。
    expect(res.status).not.toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('relay_not_configured');
  });

  it('no bytecode (forwarder が EOA) → 503 relay_not_configured (DETERMINISTIC fail CLOSED・キャッシュ)', async () => {
    // EOA: getBytecode は undefined。getBytecode を先に確定するので getter は読まない (読めば throw)。
    scenario.getBytecode = () => Promise.resolve(undefined);
    scenario.token = () => Promise.reject(new Error('no contract code at address'));
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  it('token() 不一致 (別 token コントラクト) → 503 relay_not_configured', async () => {
    scenario.token = () => Promise.resolve(WRONG_ADDR);
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  it('feeReceiver() 不一致 (別 feeReceiver) → 503 relay_not_configured', async () => {
    scenario.feeReceiver = () => Promise.resolve(WRONG_ADDR);
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  // 設計の核心 (Codex 4 round 最終形): 「肯定的に検証できた時だけ submit」。getter/RPC が **どんな**
  // 理由で throw しても (別コントラクトの revert でも・transport flake でも) submit しない = 503。
  // これにより「token() が偽の文言で revert しつつ settle() が no-op success する悪意コントラクト」も
  // 構造的に塞ぐ (検証成功時しか先へ進まないため)。エラー文字列の分類は一切しない。
  it('getter が contract revert (別コントラクト) → 503 (検証不能=submit しない)', async () => {
    const outer = new Error('returned no data ("0x")');
    outer.name = 'ContractFunctionExecutionError';
    scenario.token = () => Promise.reject(outer);
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  it('getter が "timeout" 文言で revert する悪意/別コントラクト → それでも 503 (false-success を塞ぐ)', async () => {
    // 以前の error 分類方式だと "timeout" を含む revert は transport 誤判定で素通りしえた。
    // 肯定的検証方式では理由を問わず submit しないので、この攻撃面が消える。
    scenario.token = () => Promise.reject(new Error('execution reverted: network timeout paused'));
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  it('getBytecode が transient throw → 503 だが **キャッシュしない** → RPC 回復後に自動で recover へ戻る', async () => {
    // 1 回目: getBytecode が RPC flake → 503 (submit しない)。
    let calls = 0;
    scenario.getBytecode = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('fetch failed'));
      return Promise.resolve('0x60' as Hex); // 2 回目以降は回復
    };
    const first = await post();
    expect(first.status).toBe(503);
    // 2 回目: 回復 → 検証成功 → recover へ進む (503 にならない)。non-cache の自己回復を保証。
    const second = await post();
    expect(second.status).not.toBe(503);
    const body = (await second.json()) as { error?: string };
    expect(body.error).not.toBe('relay_not_configured');
  });

  it('positive verdict はキャッシュされる (2 回目は forwarder read を再実行しない)', async () => {
    const tokenSpy = vi.fn(() => Promise.resolve(JPYC_AMOY));
    scenario.token = tokenSpy;
    await post();
    const callsAfterFirst = tokenSpy.mock.calls.length;
    await post();
    // 2 回目はキャッシュヒットで token() を再読しない (call 数が増えない)。
    expect(tokenSpy.mock.calls.length).toBe(callsAfterFirst);
  });
});
