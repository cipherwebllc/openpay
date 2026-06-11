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
  keccak256,
  type Account,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy, kaia, kairos } from 'viem/chains';
import {
  kvLpush,
  kvLrange,
  kvLtrim,
  kvSet,
  kvGet,
  kvIncr,
  kvExpire,
  kvDel,
  isKvConfigured,
} from '@/lib/kv';
import { logger } from '@/lib/logger';
import { recordRelayedVolume } from '@/lib/billingMeter';
import { isGaslessRelayBlocked } from '@/lib/feeGate';
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
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
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
// B4: chain 日次の relay 件数上限 (Sybil による POL 枯渇 griefing の circuit breaker)。
const RELAY_DAILY_TX_CAP = (() => {
  const raw = process.env.RELAY_DAILY_TX_CAP;
  return raw && /^[0-9]+$/.test(raw) ? Number(raw) : 500;
})();
// B5: 1 tx の native (POL) gas コスト上限 (wei)。これを超える高騰時は relay せず standard へ倒す
// (赤字防止)。未設定 (0) はスキップ — testnet 既定。mainnet は回収 fee 相当に合わせて設定。
const RELAY_MAX_GAS_COST_WEI = (() => {
  const raw = process.env.RELAY_MAX_GAS_COST_WEI;
  return raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 0n;
})();
// relayer の native 残高がこれ未満で submit 前に事前警告 (枯渇=relayer_unfunded の手前で Sentry 通知し
// operator が補充できるように)。既定 0.1 native (1e17)。補充 cadence に応じ env で調整・0 で無効。
const RELAY_LOW_BALANCE_ALERT_WEI = (() => {
  const raw = process.env.RELAY_LOW_BALANCE_ALERT_WEI;
  return raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 10n ** 17n;
})();

// 対応 chain (Polygon mainnet/Amoy + Kaia mainnet/Kairos)。JPYC v3 は全 chain 同一アドレス。
// Kaia は Gelato 非対応だが自前 relayer (KAIA gas) で中継可能。RPC 未設定時は viem の default を使う。
const SUPPORTED_CHAINS: Record<number, { chain: Chain; rpc?: string }> = {
  [polygon.id]: { chain: polygon, rpc: process.env.NEXT_PUBLIC_POLYGON_RPC_URL },
  [polygonAmoy.id]: {
    chain: polygonAmoy,
    rpc: process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL,
  },
  [kaia.id]: { chain: kaia, rpc: process.env.NEXT_PUBLIC_KAIA_RPC_URL },
  [kairos.id]: { chain: kairos, rpc: process.env.NEXT_PUBLIC_KAIROS_RPC_URL },
};

// mainnet chain (実マネー)。recover の self-host hardening (KV + gas-cost ceiling 必須) を強制する
// 判定に使う。testnet (Amoy/Kairos) は緩く運用可。新規 mainnet chain を SUPPORTED_CHAINS に
// 足したら、ここにも追加して silent な fail-open を防ぐこと。
const MAINNET_CHAINS: ReadonlySet<number> = new Set([polygon.id, kaia.id]);

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
  Object.keys(SUPPORTED_CHAINS).some(
    (id) => jpycForwarderFor(Number(id)) !== null,
  )
) {
  logger.warn('relay.jpyc.misconfig', {
    reason:
      'forwarder configured but PROVIDER is not self-host; recover requires self-host',
  });
}

// recover (forwarder 立替+回収) と a1 利用料 (NEXT_PUBLIC_ENABLE_USAGE_FEE) は併用不可。
// recover 経路 (handleRecover) は isGaslessRelayBlocked の延滞遮断も recordRelayedVolume の
// 出来高メーターも通らないため、同時設定は (1) 延滞店主のガスレスが止まらない (ゲートの
// teeth 喪失) (2) recover 経路の出来高が a1 メーターに乗らず undercount、を黙って起こす。
// 誤設定はデプロイ時に即死 (route 全体 500・client は relay 不可で standard へ誘導) させ、
// ゲート素通りのまま運用される事故を防ぐ。
if (
  env.enableUsageFee &&
  Object.keys(SUPPORTED_CHAINS).some(
    (id) => jpycForwarderFor(Number(id)) !== null,
  )
) {
  throw new Error(
    'relay.jpyc misconfig: NEXT_PUBLIC_JPYC_FORWARDER_* (recover) と ' +
      'NEXT_PUBLIC_ENABLE_USAGE_FEE=1 (a1 利用料) は併用できません。' +
      'recover 経路は利用料ゲート/出来高メーターを通らないため、どちらか一方を解除してください。',
  );
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
    getPendingNonce: () =>
      publicClient.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      }),
    // pre-sign: prepare (fees/type を RPC で補完) → sign → keccak256 で txHash 確定。
    // maxFeePerGas は B5 ceiling 判定用に「実際に署名された fee」を返す (legacy chain は gasPrice)。
    signTx: async (target, data, gas, nonce) => {
      const request = await walletClient.prepareTransactionRequest({
        account,
        chain: cfg.chain,
        to: target,
        data,
        gas,
        nonce,
      });
      const raw = await walletClient.signTransaction(request);
      const maxFeePerGas =
        request.maxFeePerGas ?? request.gasPrice ?? 0n;
      return { raw, hash: keccak256(raw), maxFeePerGas };
    },
    sendRawTransaction: (raw) =>
      publicClient.sendRawTransaction({ serializedTransaction: raw }),
    waitForReceipt: async (hash) => {
      const r = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: RELAYER_RECEIPT_TIMEOUT_MS,
      });
      // transactionHash は replacement 検出用 (pollSelfHost が待った hash と照合)。
      return { status: r.status, transactionHash: r.transactionHash };
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

const idemKey = (chainId: number, from: Address, nonce: Hex) =>
  `relay:idem:${chainId}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
const IDEM_TTL_SEC = 1800;

// 冪等性 claim (fail-SAFE)。SET NX:
//  - 'OK' (新規) → first (処理続行)。
//  - null (既存=重複 POST) → duplicate。記録済 txHash があれば返す (response-loss 後の explorer 追跡)。
//  - KV error/timeout (応答不確定・KV は configured) → SET が通った可能性 → duplicate (二重 submit 回避)。
//  - KV 未設定 → idempotency 無効 → first (可用性優先。最終防壁は on-chain _authorizationStates)。
async function claimIdempotency(
  chainId: number,
  from: Address,
  nonce: Hex,
): Promise<{ status: 'first' } | { status: 'duplicate'; txHash: Hex | null }> {
  if (!isKvConfigured()) return { status: 'first' };
  const key = idemKey(chainId, from, nonce);
  const r = await kvSet(key, '1', { nx: true, ttlSec: IDEM_TTL_SEC });
  if (r.ok) {
    if (r.value === null) {
      // 既存。記録済 hash を読んで同梱 (なければ null)。
      const g = await kvGet(key);
      const v = g.ok ? g.value : null;
      const txHash =
        v && v.startsWith('0x') && v.length === 66 ? (v as Hex) : null;
      return { status: 'duplicate', txHash };
    }
    return { status: 'first' };
  }
  return { status: 'duplicate', txHash: null }; // fail-safe
}

// claim 済 authorization に broadcast 済 txHash を上書き記録 (NX なし)。重複 POST が
// explorer 追跡できるように。TTL は claim と同じ。
async function recordRelayHash(
  chainId: number,
  from: Address,
  nonce: Hex,
  txHash: Hex,
): Promise<void> {
  if (!isKvConfigured()) return;
  await kvSet(idemKey(chainId, from, nonce), txHash, { ttlSec: IDEM_TTL_SEC });
}

// claim 解放。broadcast "前" の失敗 (relay_error) でのみ呼ぶ (tx 未送信なので安全)。正当な
// 再試行を 30 分 (IDEM_TTL) 待たせない (false tombstone 防止)。
async function releaseIdempotency(
  chainId: number,
  from: Address,
  nonce: Hex,
): Promise<void> {
  if (!isKvConfigured()) return;
  await kvDel(idemKey(chainId, from, nonce));
}

// B4: 日次グローバル予算 (Sybil circuit breaker)。INCR relay:budget:{chainId}:{YYYYMMDD} し、
// 初回のみ TTL 2 日。count が cap 以下なら許可。fail-open: KV 未設定/障害は許可 (rate-limit と
// 同方針・alpha は可用性優先)。近似カウンタで足りる (応答喪失の二重カウントは早めに止まる=安全側)。
async function checkGasBudget(chainId: number): Promise<boolean> {
  if (!isKvConfigured()) return true;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD (UTC)
  const key = `relay:budget:${chainId}:${day}`;
  const r = await kvIncr(key);
  if (!r.ok) {
    logger.warn('relay gas budget INCR failed (fail-open)', { chainId });
    return true;
  }
  // EXPIRE は毎回設定する (初回 EXPIRE が応答喪失すると TTL 無しの stale key が永続化するため・
  // Codex P2)。EXPIRE は冪等なので再設定は無害。
  await kvExpire(key, 2 * 24 * 3600);
  return r.value <= RELAY_DAILY_TX_CAP;
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
        // これらは Gelato が broadcast しなかったことが確実 → error (fallback 可)。
        return { state: 'error', detail: state };
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // timeout は broadcast 済か不確定 (Gelato は遅延後に submit しうる)。error にすると client が
  // standard へ fallback し二重送金しうるため pending に倒す (Codex)。txHash は不明なので省略。
  return { state: 'pending' };
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

  // mainnet (Polygon/Kaia) を self-host で relay する前提条件 (testnet は緩く運用可)。silent な
  // 無効化を避け mainnet のみ 503 で拒否する。
  if (PROVIDER === 'self-host' && MAINNET_CHAINS.has(chainId)) {
    // B5: gas-cost ceiling 未設定は赤字リスク (Codex P1)。
    if (RELAY_MAX_GAS_COST_WEI === 0n) {
      logger.error('RELAY_MAX_GAS_COST_WEI unset on mainnet self-host (B5 必須)', {
        chainId,
      });
      return NextResponse.json(
        { ok: false, error: 'gas_ceiling_required' },
        { status: 503 },
      );
    }
    // KV 必須: 未設定だと idempotency が fail-open になり、TTL 失効や重複 POST で同一 authorization の
    // 二重 submit が起こりうる (fatal+unused→relay_error→standard fallback の安全性が崩れる・Codex)。
    // mainnet では KV を必須にして fail-open 経路を塞ぐ (最終防壁の on-chain に加えた多層防御)。
    if (!isKvConfigured()) {
      logger.error('KV unconfigured on mainnet self-host (idempotency/budget 必須)', {
        chainId,
      });
      return NextResponse.json(
        { ok: false, error: 'kv_required' },
        { status: 503 },
      );
    }
  }

  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );

  // forwarder が設定された chain は recover モード (gas 相当額を JPYC 回収・self-host 限定)。
  // 無ければ free モード (Phase A・直接 transferWithAuthorization)。
  // ⚠️ recover (per-tx ガス回収) と a1 月額 OpenPay 利用料 (NEXT_PUBLIC_ENABLE_USAGE_FEE) は **排他**:
  // 両方有効にすると二重課金 + recover 経路が利用料ゲート/メーターを迂回する。a1 を点灯する chain では
  // forwarder を設定しない (= free モード固定)。詳細は docs/plans/merchant-gasless-fee-a1.md (S5/P3)。
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

  // 利用料支払い (店主→FEE_RECEIVER) かどうか。関所ゲート除外 + メーター除外で共用する。
  const feeRecv = feeReceiverFor(chainId);
  const isFeePayment =
    feeRecv !== null && auth.to.toLowerCase() === feeRecv.toLowerCase();

  // OpenPay 利用料 関所ゲート (S5): billing 点灯中、利用料が未払い (前月請求あり・猶予超過) の店主は
  // ガスレス中継を停止する。顧客は standard モード (自分でガス負担) で無料のまま決済できる。
  // billing OFF / アルファ bypass / 利用料支払い自体 は遮断しない。KV 障害時は fail-open。
  if (await isGaslessRelayBlocked(auth.to, isFeePayment)) {
    return NextResponse.json({ ok: false, error: 'fee_required' }, { status: 402 });
  }

  const supported = chainId in SUPPORTED_CHAINS;
  const common = {
    nowSec: () => Math.floor(Date.now() / 1000),
    maxValue: MAX_VALUE,
    jpycAddressFor,
    getBalance,
    checkRateLimit,
    checkGasBudget,
    claimIdempotency,
    recordRelayHash,
    releaseIdempotency,
  };
  let deps: RelayDeps;
  if (PROVIDER === 'self-host') {
    const io = supported ? selfHostIoFor(chainId) : null;
    const jpyc = jpycAddressFor(chainId);
    // collision/fatal 時に「この authorization が執行済か」を再確認し pending/fallback を判断 (P0/P1)。
    const isAuthorizationUsed =
      jpyc ? () => readAuthorizationUsed(chainId, jpyc, auth.from, auth.nonce) : undefined;
    deps = {
      ...common,
      checkAuthorizationUsed: readAuthorizationUsed,
      submitSponsoredCall: (_c, target, data) =>
        submitSelfHost(io!, target, data, {
          maxGasCostWei: RELAY_MAX_GAS_COST_WEI,
          isAuthorizationUsed,
          lowBalanceWei: RELAY_LOW_BALANCE_ALERT_WEI,
          onLowBalance: (b) =>
            logger.warn('relay.relayer.balance_low', {
              chainId,
              balanceWei: b.toString(),
            }),
        }),
      pollTask: (taskId) => pollSelfHost(io!, taskId),
    };
  } else {
    deps = { ...common, submitSponsoredCall: gelatoSubmit, pollTask: gelatoPoll };
  }
  const result = await relayJpycAuthorization(
    { chainId, auth, signature: raw.signature as Hex, rateLimitKeys: [auth.from, ipPrefix] },
    deps,
  );
  // OpenPay 利用料メーター (S1): 中継成功した gasless 決済の店主別出来高をサーバ権威で記録する
  // (将来の月次利用料 a1 の課金根拠)。merchant=auth.to / value=auth.value。点灯前から貯める
  // 設計で NEXT_PUBLIC_ENABLE_USAGE_FEE に依存しない。失敗しても決済応答は壊さない (undercount=honest)。
  // 除外: 店主が利用料を FEE_RECEIVER へ支払う tx を「売上出来高」として誤計上しない (isFeePayment 共用)。
  if (result.kind === 'success') {
    if (!isFeePayment) {
      try {
        await recordRelayedVolume({
          chainId,
          merchant: auth.to,
          value: auth.value,
          nowMs: Date.now(),
          txHash: result.txHash,
        });
      } catch (e) {
        logger.warn('billing.meter.record_failed', {
          chainId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
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
  // collision/fatal 時の authState 再確認用 (P0/P1)。recover の nonce は commitment nonce。
  const jpyc = jpycAddressFor(chainId);
  const forwarder = forwarderFor(chainId);
  const isAuthorizationUsed =
    jpyc && forwarder
      ? () =>
          readAuthorizationUsed(
            chainId,
            jpyc,
            params.from,
            buildForwarderNonce(params, chainId, forwarder),
          )
      : undefined;
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
    checkGasBudget,
    checkAuthorizationUsed: readAuthorizationUsed,
    claimIdempotency,
    recordRelayHash,
    releaseIdempotency,
    submit: (_c, target, data) =>
      submitSelfHost(io, target, data, {
        maxGasCostWei: RELAY_MAX_GAS_COST_WEI,
        isAuthorizationUsed,
        lowBalanceWei: RELAY_LOW_BALANCE_ALERT_WEI,
        onLowBalance: (b) =>
          logger.warn('relay.relayer.balance_low', {
            chainId,
            balanceWei: b.toString(),
          }),
      }),
    pollTask: (taskId) => pollSelfHost(io, taskId),
  };
  const result = await recoverViaForwarder(
    { chainId, params, signature: raw.signature as Hex, rateLimitKeys: [params.from, ipPrefix] },
    deps,
  );
  return respond(result, chainId);
}
