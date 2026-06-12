// L1 (LARP 修正): recover 経路の **手数料強制を実署名で end-to-end** 検証する。
//
// 既存の relay-jpyc-recover.test.ts は recoverViaForwarder と recoverFeeValue を **境界モック** し、
// deps.expectedFeeValue を捕捉するだけだった。つまり「server が間違った feeValue を実際に REJECT する」
// 経路は route を通して一度も実行されていなかった (LARP)。このファイルは:
//   - lib/relay/forwarderRecover (recoverViaForwarder) を **モックしない** (実検証ロジック)。
//   - lib/relay/forwarderSettle (viem の EIP-712 署名 recover) も **モックしない** (実 recover)。
//   - lib/relay/recoverFee も **モックしない** (env から実 bps を読む)。
//   - lib/env も **モックしない** (process.env を stub して実物に読ませる)。
//   - 顧客署名を viem で **本物** に作る (privateKeyToAccount(...).signTypedData(...))。hook
//     (useJpycEip3009Payment) と完全同一の buildReceiveWithAuthorizationTypedData を使う。
// これにより「wrong fee → 400 fee_value_mismatch」が route 実走で証明され、money path のガードが
// 飾りでないことを固定する。
//
// 検証順序 (lib/relay/forwarderRecover.ts):
//   feeReceiver 一致 → feeValue===expectedFeeValue → merchantValue>0 → … → 署名 recover → 残高。
//   fee_value_mismatch は **どの network 呼び出しよりも前** に発火する (negative case は RPC 不要)。
//   署名 recover は残高チェックの **前** にある (Case 2b の signature_mismatch は残高に到達せず判定)。
//
// Amoy (80002・testnet) を使い、route の mainnet 限定前提 (MAINNET_CHAINS={137,8217} の KV/gas-ceiling)
// を回避する (POST の MAINNET_CHAINS.has(chainId) 分岐を確認済)。
//
// Case 2 の seam (REPORT 参照): viem の createPublicClient のみ最小モック (readContract→0n)。
// 正しい fee + 正しい署名のときだけ残高チェックに到達し 0n により insufficient_balance になる
// → 「実署名で fee 検証を通過した」ことの証明。fee_value_mismatch / signature_mismatch は
// 残高より前で発火するためこの stub の影響を受けない。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Hex } from 'viem';
import {
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';

// 残高境界だけを stub: viem は importOriginal で **すべて実物** を保ち (recoverTypedDataAddress
// 等の署名 recover も実物)、唯一 createPublicClient だけ差し替えて readContract (balanceOf) が
// 0n を返す。signTypedData / privateKeyToAccount は viem/accounts (別モジュール) なので実物。
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      // CDX-1 forwarder 健全性チェック (submit 前) を通すため getBytecode + token()/feeReceiver() を
      // valid 相当に。これらが取れないと route は検証不能で 503 に倒す (= 本テストの fee/署名/残高の
      // 検証点に到達できない)。token=JPYC_AMOY / feeReceiver=FEE_RECEIVER は下で定義する解決値と一致。
      getBytecode: async () => '0x60' as `0x${string}`,
      readContract: async (args: { functionName?: string }) => {
        if (args.functionName === 'token') return JPYC_AMOY;
        if (args.functionName === 'feeReceiver') return FEE_RECEIVER;
        return 0n; // balanceOf → 0n (残高不足で submit 前に弾く)
      },
      getBalance: async () => 0n,
      estimateGas: async () => 21000n,
      getTransactionCount: async () => 0,
      waitForTransactionReceipt: async () => ({
        status: 'success',
        transactionHash: `0x${'0'.repeat(64)}`,
      }),
      sendRawTransaction: async () => `0x${'0'.repeat(64)}`,
    }),
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const JPYC = 10n ** 18n;
const AMOY = 80002;
// Amoy 上の JPYC アドレス。署名 domain の verifyingContract は route の jpycAddressFor が解決する
// アドレス (= resolveDeployment('jpyc', 80002).address) と **一致** させる必要がある。vitest.config の
// グローバル env (NEXT_PUBLIC_JPYC_TESTNET_ADDRESS) が testnet JPYC を上書きするため、本テストでは
// その env を決定論値に固定し、同じ値で署名する (ハードコード前提に依存しない・乖離ゼロ)。
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
// 実 Amoy forwarder (memory:jpyc-eip3009・Phase2 Amoy E2E 済)。
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
// 固定テスト fee receiver (route の feeReceiverFor が env.feeReceiver を読む)。
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const MERCHANT = getAddress('0x1234567890123456789012345678901234567890');

// 決定論テスト鍵 (秘密情報ではない・privateKeyToAccount が受理する有効な 0x-key)。
const CUSTOMER_PK = `0x${'a1'.repeat(32)}` as Hex;
const RELAYER_PK = `0x${'11'.repeat(32)}` as Hex;
const WRONG_PK = `0x${'b2'.repeat(32)}` as Hex;

const customerAccount = privateKeyToAccount(CUSTOMER_PK);
const wrongAccount = privateKeyToAccount(WRONG_PK);
const CUSTOMER = getAddress(customerAccount.address);

// 本物の顧客署名を hook と同式で作る (buildReceiveWithAuthorizationTypedData → signTypedData)。
// 署名 domain の token は route が解決する JPYC アドレス (JPYC_AMOY) と一致させる。
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

// route module を、指定 bps で fresh import する。env (lib/env) は module load 時に process.env を
// 読むため、stub → resetModules → import の順で実 env / 実 recoverFee を新規評価させる。
// 署名と route の domain がずれないよう、route の解決する JPYC アドレスが JPYC_AMOY と一致することを
// resolveDeployment 経由で **実物** に確認する (テストが偽の前提で緑にならない自己検証)。
async function loadRoute(bps: number): Promise<(req: Request) => Promise<Response>> {
  vi.stubEnv('RELAYER_PRIVATE_KEY', RELAYER_PK); // self-host relayer 有効化 (recover 前提)
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER); // recover モードに倒す
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER); // env.feeReceiver
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', ''); // a1 OFF (ON だと forwarder=null)
  vi.stubEnv('NEXT_PUBLIC_RECOVER_FEE_BPS', String(bps)); // 実 recoverFeeValue の bps
  vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY); // 署名 domain と一致させる
  vi.resetModules();
  // 自己検証: route が使う resolveDeployment が署名 domain と同一アドレスを返すことを確認する。
  // (これがずれていると署名検証が必ず通らず、本テストは LARP になる)。
  const { resolveDeployment } = await import('@/lib/tokens');
  const resolved = resolveDeployment('jpyc', AMOY);
  if (!resolved || getAddress(resolved.address) !== JPYC_AMOY) {
    throw new Error(
      `JPYC address drift: route resolves ${resolved?.address} but 署名 uses ${JPYC_AMOY}`,
    );
  }
  const mod = await import('@/app/api/relay/jpyc/route');
  return mod.POST as (req: Request) => Promise<Response>;
}

function post(
  postFn: (req: Request) => Promise<Response>,
  body: Record<string, unknown>,
): Promise<Response> {
  return postFn(
    new Request('http://localhost/api/relay/jpyc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function basePayload(
  params: ForwarderSettleParams,
  signature: Hex,
  gasMode: 'customer' | 'merchant',
): Record<string, unknown> {
  return {
    chainId: AMOY,
    from: params.from,
    merchant: params.merchant,
    merchantValue: params.merchantValue.toString(),
    feeValue: params.feeValue.toString(),
    gasMode,
    validAfter: params.validAfter.toString(),
    validBefore: params.validBefore.toString(),
    intentSalt: params.intentSalt,
    signature,
  };
}

const validBefore = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const SALT = `0x${'22'.repeat(32)}` as Hex;

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('relay route handleRecover — 実署名 end-to-end の手数料強制 (L1・bps=0)', () => {
  let POST: (req: Request) => Promise<Response>;
  beforeAll(async () => {
    POST = await loadRoute(0); // bps=0 → expectedFee は常にフロア 2 JPYC
  });

  // --- Case 1: the money assertion ---
  // bps=0 → server 権威 expectedFee = フロア 2 JPYC。payload は feeValue=1 JPYC (誤り) を主張し、
  // その (誤った) 値の上に **本物の署名** を載せる。route 実走 → fee_value_mismatch (400)。
  // これは「server が間違った fee を end-to-end で拒否する」ことの直接証明 (RPC 不要)。
  it('Case 1: wrong feeValue (1 JPYC) + 実署名 → 400 fee_value_mismatch (money path のガード)', async () => {
    const params: ForwarderSettleParams = {
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: 1000n * JPYC,
      feeReceiver: FEE_RECEIVER,
      feeValue: 1n * JPYC, // expected はフロア 2 JPYC。1 JPYC は誤り。
      validAfter: 0n,
      validBefore: validBefore(),
      intentSalt: SALT,
    };
    const signature = await signReceive(params); // 誤った feeValue の上に本物で署名
    const res = await post(POST, basePayload(params, signature, 'customer'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'fee_value_mismatch' });
  });

  // --- Case 2a (主経路: insufficient_balance) ---
  // 正しい feeValue (フロア 2 JPYC) + 本物の署名 → fee 検証 + 署名 recover を通過し、残高チェックへ
  // 到達。残高 stub (createPublicClient→readContract=0n) により insufficient_balance。これは
  // 「リクエストが実署名で fee 検証を通過した」ことの証明 (fee も署名も valid でないと残高に到達しない)。
  it('Case 2a: correct feeValue + 実署名 → fee/署名検証を通過し 400 insufficient_balance に到達', async () => {
    const params: ForwarderSettleParams = {
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: 1000n * JPYC,
      feeReceiver: FEE_RECEIVER,
      feeValue: 2n * JPYC, // bps=0 → フロア 2 JPYC (正しい)
      validAfter: 0n,
      validBefore: validBefore(),
      intentSalt: SALT,
    };
    const signature = await signReceive(params);
    const res = await post(POST, basePayload(params, signature, 'customer'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'insufficient_balance' });
  });

  // --- Case 2b (補強: signature_mismatch) ---
  // すべて正しいが **別の鍵** で署名する。署名 recover は残高チェックの前にあるため、recover した
  // signer (= WRONG アドレス) が from (= CUSTOMER) と一致せず signature_mismatch。これは route 内で
  // 本物の EIP-712 recover が走っていることの直接証明 (モックなら検出できない)。
  it('Case 2b: 正しい fee だが別鍵で署名 → 400 signature_mismatch (実 recover が in-route で走る)', async () => {
    const params: ForwarderSettleParams = {
      from: CUSTOMER, // from は CUSTOMER のまま
      merchant: MERCHANT,
      merchantValue: 1000n * JPYC,
      feeReceiver: FEE_RECEIVER,
      feeValue: 2n * JPYC,
      validAfter: 0n,
      validBefore: validBefore(),
      intentSalt: SALT,
    };
    const signature = await signReceive(params, wrongAccount); // 別鍵で署名
    const res = await post(POST, basePayload(params, signature, 'customer'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'signature_mismatch' });
  });
});

// --- Case 3: gasMode-forgery 経済性のピン留め (bps=100・実 recoverFeeValue) ---
// bps=100 のとき確定モデル:
//   customer (チップ): フロア固定 (2 JPYC・1% 非適用) — 大口でも floor。
//   merchant (決済): max(floor, billAmount × 1%) — 大口は 1%。
// 同じ額面でも gasMode で expectedFee が変わることを実署名 + 実 fee で証明する (受容残余のピン)。
describe('relay route handleRecover — Case 3: bps=100 で gasMode により expectedFee が分岐', () => {
  let POST: (req: Request) => Promise<Response>;
  beforeAll(async () => {
    POST = await loadRoute(100); // bps=100 (1%)
  });

  // customer (チップ): 大口 1000 JPYC でも fee=フロア 2 JPYC が受理される (1% = 10 JPYC は乗らない)。
  it('customer (チップ): 大口でも feeValue=フロア 2 JPYC が fee 検証を通過 (1% 非適用)', async () => {
    const params: ForwarderSettleParams = {
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: 1000n * JPYC, // customer: billAmount = merchantValue = 1000
      feeReceiver: FEE_RECEIVER,
      feeValue: 2n * JPYC, // チップはフロア固定
      validAfter: 0n,
      validBefore: validBefore(),
      intentSalt: SALT,
    };
    const signature = await signReceive(params);
    const res = await post(POST, basePayload(params, signature, 'customer'));
    expect(await res.json()).toEqual({ ok: false, error: 'insufficient_balance' });
  });

  // customer (チップ) で 1% (10 JPYC) を主張すると expected (フロア 2) と食い違い fee_value_mismatch。
  it('customer (チップ): 1% (10 JPYC) を主張すると expected=フロアと食い違い fee_value_mismatch', async () => {
    const params: ForwarderSettleParams = {
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: 1000n * JPYC,
      feeReceiver: FEE_RECEIVER,
      feeValue: 10n * JPYC, // 1% を主張 → customer では floor が期待なので不一致
      validAfter: 0n,
      validBefore: validBefore(),
      intentSalt: SALT,
    };
    const signature = await signReceive(params);
    const res = await post(POST, basePayload(params, signature, 'customer'));
    expect(await res.json()).toEqual({ ok: false, error: 'fee_value_mismatch' });
  });

  // merchant (決済): 同じ 1000 JPYC billAmount で 1% = 10 JPYC が要求される。
  // merchantValue=990 + feeValue=10 → billAmount=1000 → expected 1% = 10 JPYC で一致 (accept)。
  it('merchant (決済): mv=990 fv=10 (billAmount=1000) → 1%=10 JPYC で fee 検証を通過', async () => {
    const params: ForwarderSettleParams = {
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: 990n * JPYC, // merchant: billAmount = mv + fv = 990 + 10 = 1000
      feeReceiver: FEE_RECEIVER,
      feeValue: 10n * JPYC, // 1% of 1000
      validAfter: 0n,
      validBefore: validBefore(),
      intentSalt: SALT,
    };
    const signature = await signReceive(params);
    const res = await post(POST, basePayload(params, signature, 'merchant'));
    expect(await res.json()).toEqual({ ok: false, error: 'insufficient_balance' });
  });

  // merchant (決済) で floor (2 JPYC) を主張すると 1% (10) が期待されるので食い違い fee_value_mismatch。
  // これが customer/merchant の経済性の差を証明する: 同じ額面でも merchant は 1% を払わされる。
  it('merchant (決済): floor 2 JPYC を主張すると expected=1% (10 JPYC) と食い違い fee_value_mismatch', async () => {
    const params: ForwarderSettleParams = {
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: 998n * JPYC, // billAmount = 998 + 2 = 1000 → expected 1% = 10 JPYC
      feeReceiver: FEE_RECEIVER,
      feeValue: 2n * JPYC, // floor を主張 (merchant では不足)
      validAfter: 0n,
      validBefore: validBefore(),
      intentSalt: SALT,
    };
    const signature = await signReceive(params);
    const res = await post(POST, basePayload(params, signature, 'merchant'));
    expect(await res.json()).toEqual({ ok: false, error: 'fee_value_mismatch' });
  });
});
