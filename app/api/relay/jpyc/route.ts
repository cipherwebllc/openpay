// JPYC EIP-3009 relay endpoint (Phase 1: Polygon / Amoy)。
//
// 顧客が transferWithAuthorization に EIP-712 署名 (eth_signTypedData_v4・任意ウォレットで可) →
// ここで検証 (署名 recover==from / 残高 / rate-limit / authorizationState) → relayer が submit →
// poll → {txHash}。委任不要なので現行 7702 経路より到達が広い。詳細・段階計画は memory:jpyc-eip3009。
//
// 送信 provider は "起動時に1回" 確定する (within-request の failover はしない — broadcast 後の
// 曖昧な状態で別経路に流すと二重送金しうるため・Codex #5):
//   RELAYER_PRIVATE_KEY あり → self-host (運営 EOA が直接 submit・POL 負担。既定)
//   なければ GELATO_SPONSOR_API_KEY あり → gelato (sponsoredCall。deploy 単位の rollback 用)
//   どちらも無し → relay_not_configured (client は 7702/standard へ fallback)
//
// 実依存 (viem / Gelato fetch / KV rate-limit) を inject して lib/relay/jpycRelay の純コアに委譲
// (分岐は unit test で担保)。

import { NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  erc20Abi,
  isAddress,
  isHex,
  getAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { kvLpush, kvLrange, kvLtrim, kvSet, isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { resolveDeployment } from '@/lib/tokens';
import {
  relayJpycAuthorization,
  type RelayDeps,
  type RelayResult,
  type RelayTaskOutcome,
} from '@/lib/relay/jpycRelay';
import {
  submitSelfHost,
  pollSelfHost,
  RELAYER_RECEIPT_TIMEOUT_MS,
  type SelfHostIo,
} from '@/lib/relay/selfHostRelayer';
import {
  recoverViaForwarder,
  type ForwarderRecoverDeps,
} from '@/lib/relay/forwarderRecover';
import type { ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import { jpycForwarderFor, relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
const GELATO_API_KEY = process.env.GELATO_SPONSOR_API_KEY;
const GELATO_BASE =
  process.env.GELATO_RELAY_BASE_URL ?? 'https://api.gelato.digital';

// provider を起動時に1回確定 (within-request failover はしない)。
const PROVIDER: 'self-host' | 'gelato' | null = RELAYER_PRIVATE_KEY
  ? 'self-host'
  : GELATO_API_KEY
    ? 'gelato'
    : null;
// 不正鍵は module load で fail-fast (全リクエスト 500 になり設定ミスが顕在化する)。
const RELAYER_ACCOUNT: Account | null = RELAYER_PRIVATE_KEY
  ? privateKeyToAccount(RELAYER_PRIVATE_KEY)
  : null;

// relay 単発の上限 (濫用ガード + 立替を少額に限定して資金移動的に見えにくくする)。
// RELAY_MAX_JPYC は human JPYC (アルファ既定 5 万)。旧 GELATO_RELAY_MAX_JPYC からリネーム
// (provider 非依存の上限なので Gelato 名は外す)。旧名も後方互換で読む。
const MAX_VALUE = (() => {
  const raw = process.env.RELAY_MAX_JPYC ?? process.env.GELATO_RELAY_MAX_JPYC;
  const human = raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 50_000n;
  return human * 10n ** 18n;
})();
const RL_MAX = 5; // window 内の最大 relay 回数 (per key)
const RL_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 4 * 1024;

// 対応 chain (Polygon mainnet + Amoy testnet)。同一 JPYC アドレス。Kaia は将来自前 relayer 拡張。
const SUPPORTED_CHAINS: Record<number, { chain: Chain; rpc?: string }> = {
  [polygon.id]: { chain: polygon, rpc: process.env.NEXT_PUBLIC_POLYGON_RPC_URL },
  [polygonAmoy.id]: {
    chain: polygonAmoy,
    rpc: process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL,
  },
};

// JPYC (FiatToken) の EIP-3009 使用済フラグ。submit 前に読み guaranteed-revert を避ける。
const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

// recover モード config は client/server 共有 (lib/relay/forwarderConfig)。forwarder アドレスが
// chain に設定されていれば recover モード (= 立替+回収)、無ければ free (Phase A 直接 transfer)。
const forwarderFor = jpycForwarderFor;
// forwarder の immutable feeReceiver と一致させる回収先 (= OpenPay fee receiver)。
function feeReceiverFor(_chainId: number): Address | null {
  return isAddress(env.feeReceiver) ? getAddress(env.feeReceiver) : null;
}
const FLAT_FEE_VALUE = relayGasFeeValue();
const MAX_VALIDITY_WINDOW_SEC = 20 * 60;

// recover (forwarder 設定) は self-host relayer 前提 (recover 経路は forwarder.settle を自前 EOA で
// submit する)。client は PROVIDER を見えないため forwarder 設定だけで recover payload を送る。
// forwarder を設定したのに self-host でない構成は誤設定 (client の recover payload を handleFree が
// 弾き 400 になる) → 起動時に警告。invariant: forwarder 設定 ⟹ RELAYER_PRIVATE_KEY 設定。
if (
  PROVIDER !== 'self-host' &&
  (jpycForwarderFor(polygon.id) !== null ||
    jpycForwarderFor(polygonAmoy.id) !== null)
) {
  logger.warn('relay.jpyc.misconfig', {
    reason:
      'forwarder configured but PROVIDER is not self-host; recover requires self-host',
  });
}

function transportFor(chainId: number) {
  const cfg = SUPPORTED_CHAINS[chainId];
  return http(cfg.rpc ?? cfg.chain.rpcUrls.default.http[0]);
}

function jpycAddressFor(chainId: number): Address | null {
  if (!(chainId in SUPPORTED_CHAINS)) return null;
  const d = resolveDeployment('jpyc', chainId);
  return d ? d.address : null;
}

async function getBalance(
  chainId: number,
  token: Address,
  owner: Address,
): Promise<bigint> {
  const client = createPublicClient({
    chain: SUPPORTED_CHAINS[chainId].chain,
    transport: transportFor(chainId),
  });
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
}

async function readAuthorizationUsed(
  chainId: number,
  token: Address,
  from: Address,
  nonce: Hex,
): Promise<boolean> {
  const client = createPublicClient({
    chain: SUPPORTED_CHAINS[chainId].chain,
    transport: transportFor(chainId),
  });
  return client.readContract({
    address: token,
    abi: AUTHORIZATION_STATE_ABI,
    functionName: 'authorizationState',
    args: [from, nonce],
  });
}

// self-host: relayer EOA / chain client から SelfHostIo を組む (chainId は対応済前提)。
function selfHostIoFor(chainId: number): SelfHostIo {
  const cfg = SUPPORTED_CHAINS[chainId];
  const transport = transportFor(chainId);
  const account = RELAYER_ACCOUNT as Account;
  const publicClient = createPublicClient({ chain: cfg.chain, transport });
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport });
  return {
    getBalance: () => publicClient.getBalance({ address: account.address }),
    estimateGas: (target, data) =>
      publicClient.estimateGas({ account, to: target, data }),
    sendTransaction: (target, data, gas) =>
      walletClient.sendTransaction({
        account,
        chain: cfg.chain,
        to: target,
        data,
        gas,
      }),
    waitForReceipt: async (hash) => {
      const r = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: RELAYER_RECEIPT_TIMEOUT_MS,
      });
      return { status: r.status };
    },
  };
}

// KV sliding-window rate-limit (kv は list ops のみなので timestamp list で近似)。
// KV 未設定時は通す (本番は KV 設定が前提)。
async function checkRateLimit(keys: string[]): Promise<boolean> {
  if (!isKvConfigured()) return true;
  const now = Date.now();
  for (const key of keys) {
    const k = `relay:rl:${key}`;
    await kvLpush(k, String(now));
    await kvLtrim(k, 0, RL_MAX * 4);
    const r = await kvLrange(k, 0, RL_MAX * 4);
    const recent = (r.ok ? r.value : []).filter(
      (ts) => now - Number(ts) < RL_WINDOW_MS,
    );
    if (recent.length > RL_MAX) return false;
  }
  return true;
}

// 冪等性: 同一 (chainId,from,nonce) を SET NX で1回だけ claim。null = 既存(重複) → 'duplicate'。
// 'OK' = claimed → 'first'。KV error/unconfigured は fail-open ('first') — 資金の二重支払いは
// on-chain _authorizationStates が最終防壁で、ここは重複 broadcast の gas 浪費を減らす最適化。
async function claimIdempotency(
  chainId: number,
  from: Address,
  nonce: Hex,
): Promise<'first' | 'duplicate'> {
  const key = `relay:idem:${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
  const r = await kvSet(key, '1', { nx: true, ttlSec: 1800 });
  return r.ok && r.value === null ? 'duplicate' : 'first';
}

async function gelatoSubmit(
  chainId: number,
  target: Address,
  data: Hex,
): Promise<{ taskId: string }> {
  const res = await fetch(`${GELATO_BASE}/relays/v2/sponsored-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId,
      target,
      data,
      sponsorApiKey: GELATO_API_KEY,
    }),
  });
  if (!res.ok) throw new Error(`gelato_http_${res.status}`);
  const j = (await res.json()) as { taskId?: string };
  if (!j.taskId) throw new Error('gelato_no_task_id');
  return { taskId: j.taskId };
}

async function gelatoPoll(taskId: string): Promise<RelayTaskOutcome> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${GELATO_BASE}/tasks/status/${taskId}`);
    if (res.ok) {
      const { task } = (await res.json()) as {
        task?: { taskState?: string; transactionHash?: Hex };
      };
      const state = task?.taskState;
      if (state === 'ExecSuccess' && task?.transactionHash) {
        return { state: 'success', txHash: task.transactionHash };
      }
      if (state === 'ExecReverted') {
        return { state: 'reverted', txHash: task?.transactionHash };
      }
      if (state === 'Cancelled' || state === 'Blacklisted' || state === 'NotFound') {
        // Gelato は taskId が broadcast 前に返るため、これらは未送信扱い → fallback 可。
        return { state: 'error', detail: state };
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Gelato timeout も未確定だが taskId 段階 (broadcast 前の可能性) なので error。
  return { state: 'error', detail: 'timeout' };
}

function anonymizeIp(ip: string): string {
  const first = ip.split(',')[0].trim();
  if (first.includes(':')) return first.split(':').slice(0, 4).join(':') + '::/64';
  const p = first.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : 'unknown';
}

function isDec(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

export async function POST(req: Request): Promise<NextResponse> {
  // relay 未構成なら早期に signal (client が fallback 判定できるよう専用コード)。
  if (PROVIDER === null) {
    return NextResponse.json(
      { ok: false, error: 'relay_not_configured' },
      { status: 503 },
    );
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId)) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  const chainId = raw.chainId;
  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );

  // forwarder が設定された chain は recover モード (gas 相当額を JPYC 回収・self-host 限定)。
  // 無ければ free モード (Phase A・直接 transferWithAuthorization)。
  const recoverMode =
    PROVIDER === 'self-host' &&
    chainId in SUPPORTED_CHAINS &&
    forwarderFor(chainId) !== null;

  return recoverMode
    ? handleRecover(raw, chainId, ipPrefix)
    : handleFree(raw, chainId, ipPrefix);
}

// 結果 → HTTP 応答 (free / recover 共通)。pending は 202 で client に fallback 禁止を伝える。
function respond(result: RelayResult, chainId: number): NextResponse {
  switch (result.kind) {
    case 'success':
      return NextResponse.json({ ok: true, txHash: result.txHash });
    case 'reverted':
      logger.warn('relay.jpyc.reverted', { txHash: result.txHash, chainId });
      return NextResponse.json({ ok: false, reverted: true, txHash: result.txHash });
    case 'pending':
      // broadcast 済だが未確定。client は standard へ fallback してはならない (二重支払い防止)。
      logger.warn('relay.jpyc.pending', { txHash: result.txHash, chainId });
      return NextResponse.json(
        { ok: false, pending: true, txHash: result.txHash ?? null },
        { status: 202 },
      );
    case 'rejected':
      return NextResponse.json(
        { ok: false, error: result.reason },
        { status: result.httpStatus },
      );
    case 'relay_error':
      logger.warn('relay.jpyc.relay_error', { detail: result.detail, chainId });
      return NextResponse.json({ ok: false, error: 'relay_error' }, { status: 502 });
  }
}

// free モード: 直接 transferWithAuthorization (Phase A)。relayer が token に直接 submit。
async function handleFree(
  raw: Record<string, unknown>,
  chainId: number,
  ipPrefix: string,
): Promise<NextResponse> {
  if (
    !isAddress(raw.from as string) ||
    !isAddress(raw.to as string) ||
    !isDec(raw.value) ||
    !isDec(raw.validAfter) ||
    !isDec(raw.validBefore) ||
    typeof raw.nonce !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.nonce) ||
    typeof raw.signature !== 'string' ||
    !isHex(raw.signature)
  ) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  const auth = {
    from: getAddress(raw.from as string),
    to: getAddress(raw.to as string),
    value: BigInt(raw.value),
    validAfter: BigInt(raw.validAfter),
    validBefore: BigInt(raw.validBefore),
    nonce: raw.nonce as Hex,
  };
  const supported = chainId in SUPPORTED_CHAINS;
  const common = {
    nowSec: () => Math.floor(Date.now() / 1000),
    maxValue: MAX_VALUE,
    jpycAddressFor,
    getBalance,
    checkRateLimit,
    claimIdempotency,
  };
  let deps: RelayDeps;
  if (PROVIDER === 'self-host') {
    const io = supported ? selfHostIoFor(chainId) : null;
    deps = {
      ...common,
      checkAuthorizationUsed: readAuthorizationUsed,
      submitSponsoredCall: (_c, target, data) => submitSelfHost(io!, target, data),
      pollTask: (taskId) => pollSelfHost(io!, taskId),
    };
  } else {
    deps = { ...common, submitSponsoredCall: gelatoSubmit, pollTask: gelatoPoll };
  }
  const result = await relayJpycAuthorization(
    { chainId, auth, signature: raw.signature as Hex, rateLimitKeys: [auth.from, ipPrefix] },
    deps,
  );
  return respond(result, chainId);
}

// recover モード: forwarder.settle 経由で amount→店舗 + gas相当→feeReceiver を 1 署名分割。
// feeReceiver/feeValue は server 権威 (client 値は信用せず一致を強制)。
async function handleRecover(
  raw: Record<string, unknown>,
  chainId: number,
  ipPrefix: string,
): Promise<NextResponse> {
  if (
    !isAddress(raw.from as string) ||
    !isAddress(raw.merchant as string) ||
    !isDec(raw.merchantValue) ||
    !isDec(raw.feeValue) ||
    !isDec(raw.validAfter) ||
    !isDec(raw.validBefore) ||
    typeof raw.intentSalt !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.intentSalt) ||
    typeof raw.signature !== 'string' ||
    !isHex(raw.signature)
  ) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  const feeReceiver = feeReceiverFor(chainId);
  if (!feeReceiver) {
    return NextResponse.json(
      { ok: false, error: 'relay_not_configured' },
      { status: 503 },
    );
  }
  const params: ForwarderSettleParams = {
    from: getAddress(raw.from as string),
    merchant: getAddress(raw.merchant as string),
    merchantValue: BigInt(raw.merchantValue),
    feeReceiver, // server 権威 (client 値は使わない・nonce で client と一致を強制)
    feeValue: BigInt(raw.feeValue),
    validAfter: BigInt(raw.validAfter),
    validBefore: BigInt(raw.validBefore),
    intentSalt: raw.intentSalt as Hex,
  };
  const io = selfHostIoFor(chainId);
  const deps: ForwarderRecoverDeps = {
    nowSec: () => Math.floor(Date.now() / 1000),
    expectedFeeValue: FLAT_FEE_VALUE,
    maxValue: MAX_VALUE,
    maxValidityWindowSec: MAX_VALIDITY_WINDOW_SEC,
    jpycAddressFor,
    forwarderFor,
    feeReceiverFor,
    getBalance,
    checkRateLimit,
    checkAuthorizationUsed: readAuthorizationUsed,
    claimIdempotency,
    submit: (_c, target, data) => submitSelfHost(io, target, data),
    pollTask: (taskId) => pollSelfHost(io, taskId),
  };
  const result = await recoverViaForwarder(
    { chainId, params, signature: raw.signature as Hex, rateLimitKeys: [params.from, ipPrefix] },
    deps,
  );
  return respond(result, chainId);
}
