// JPYC EIP-3009 relay の **provider 解決 + free モード deps 構築** を両 route で共有する層。
// 決済 relay (/api/relay/jpyc handleFree) と CSV パス購入 relay (/api/csv-pass/relay) は、同じ
// relayer ウォレット・同じ submit/poll・同じ chain client を使う。違うのは「何を検証して何宛に送るか」
// (route 固有) と「idempotency prefix」だけ。よって provider/IO/deps の組み立てをここに集約する。
//
// 送信 provider は **module load で1回確定** する (within-request の failover はしない — broadcast 後の
// 曖昧な状態で別経路に流すと二重送金しうるため・Codex #5):
//   RELAYER_PRIVATE_KEY あり → self-host (運営 EOA が直接 submit・POL 負担。既定)
//   なければ GELATO_SPONSOR_API_KEY あり → gelato (sponsoredCall。deploy 単位の rollback 用)
//   どちらも無し → null (client は standard へ fallback)
//
// 抽出元は app/api/relay/jpyc/route.ts の同名定義。**free 経路の挙動は完全に同一** (決済 route の
// 既存テストが無改変で green であることが受け入れ条件)。recover (forwarder) 経路は決済 route 固有の
// ため route 側に残す (本モジュールは free authorization の relay deps のみを提供する)。

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  erc20Abi,
  keccak256,
  type Account,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  polygon,
  polygonAmoy,
  kaia,
  kairos,
  avalanche,
  avalancheFuji,
} from 'viem/chains';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { resolveDeployment } from '@/lib/tokens';
import { isRecoverRequiredChain } from './forwarderConfig';
import type { Eip3009Authorization } from '@/lib/jpycEip3009';
import {
  relayJpycAuthorization,
  type RelayDeps,
  type RelayResult,
  type RelayTaskOutcome,
} from './jpycRelay';
import {
  submitSelfHost,
  pollSelfHost,
  RELAYER_RECEIPT_TIMEOUT_MS,
  type SelfHostIo,
} from './selfHostRelayer';
import {
  checkRateLimit,
  checkGasBudget,
  refundGasBudget,
  makeIdempotency,
} from './relayGuards';

const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
const GELATO_API_KEY = process.env.GELATO_SPONSOR_API_KEY;
const GELATO_BASE =
  process.env.GELATO_RELAY_BASE_URL ?? 'https://api.gelato.digital';

// provider を起動時に1回確定 (within-request failover はしない)。
export const PROVIDER: 'self-host' | 'gelato' | null = RELAYER_PRIVATE_KEY
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
export const MAX_VALUE = (() => {
  const raw = process.env.RELAY_MAX_JPYC ?? process.env.GELATO_RELAY_MAX_JPYC;
  const human = raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 50_000n;
  return human * 10n ** 18n;
})();
// B5: 1 tx の native (POL) gas コスト上限 (wei)。これを超える高騰時は relay せず standard へ倒す
// (赤字防止)。未設定 (0) はスキップ — testnet 既定。mainnet は回収 fee 相当に合わせて設定。
export const RELAY_MAX_GAS_COST_WEI = (() => {
  const raw = process.env.RELAY_MAX_GAS_COST_WEI;
  return raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 0n;
})();
// per-chain の native gas 上限 (wei)。⚠️ native の価値が桁違い (AVAX ~$15-40 vs POL/KAIA ~$0.1-0.5)
// のため、同じ wei 上限を全 chain 共有すると AVAX で USD 換算 ~100倍 緩くなり高騰時に赤字を素通しする。
// Avalanche は専用上限を必須にする (server 専用 env なので動的キーでなく静的テーブルで列挙)。
const PER_CHAIN_MAX_GAS_COST_WEI_ENV: Record<number, string | undefined> = {
  [avalanche.id]: process.env.RELAY_MAX_GAS_COST_WEI_AVALANCHE,
  [avalancheFuji.id]: process.env.RELAY_MAX_GAS_COST_WEI_FUJI,
};
// chainId の native gas 上限 (wei)。per-chain env → グローバル RELAY_MAX_GAS_COST_WEI → 0n (未設定)。
// 0n は「上限なし」(testnet 既定)。mainnet self-host は route が 0n を 503 で弾く (B5 hardening)。
// ⚠️ Avalanche mainnet はグローバル fallback (POL/KAIA 調整値) では緩すぎるため、必ず
// RELAY_MAX_GAS_COST_WEI_AVALANCHE を AVAX 用に設定すること (.env.local.example 参照)。
export function relayMaxGasCostWei(chainId: number): bigint {
  const perChain = PER_CHAIN_MAX_GAS_COST_WEI_ENV[chainId];
  if (perChain && /^[0-9]+$/.test(perChain)) return BigInt(perChain);
  // recover-required chain (Avalanche) は global fallback を **使わない**: POL/KAIA 用に調整した
  // グローバル wei 上限は AVAX には過大 (USD 換算 ~100倍 緩い) で赤字を素通しする。per-chain 未設定
  // なら 0n を返し、mainnet self-host の B5 gate (route の === 0n) が gas_ceiling_required で点灯を
  // 止める (Codex P1: グローバル fallback による silent な過大上限を防ぐ)。
  if (isRecoverRequiredChain(chainId)) return 0n;
  return RELAY_MAX_GAS_COST_WEI;
}
// relayer の native 残高がこれ未満で submit 前に事前警告 (枯渇=relayer_unfunded の手前で Sentry 通知し
// operator が補充できるように)。既定 0.1 native (1e17)。補充 cadence に応じ env で調整・0 で無効。
export const RELAY_LOW_BALANCE_ALERT_WEI = (() => {
  const raw = process.env.RELAY_LOW_BALANCE_ALERT_WEI;
  return raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 10n ** 17n;
})();

// 対応 chain (Polygon mainnet/Amoy + Kaia mainnet/Kairos)。JPYC v3 は全 chain 同一アドレス。
// Kaia は Gelato 非対応だが自前 relayer (KAIA gas) で中継可能。RPC 未設定時は viem の default を使う。
export const SUPPORTED_CHAINS: Record<number, { chain: Chain; rpc?: string }> = {
  [polygon.id]: { chain: polygon, rpc: process.env.NEXT_PUBLIC_POLYGON_RPC_URL },
  [polygonAmoy.id]: {
    chain: polygonAmoy,
    rpc: process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL,
  },
  [kaia.id]: { chain: kaia, rpc: process.env.NEXT_PUBLIC_KAIA_RPC_URL },
  [kairos.id]: { chain: kairos, rpc: process.env.NEXT_PUBLIC_KAIROS_RPC_URL },
};
// Avalanche/Fuji は env.enableJpycAvalanche=ON のときだけ追加 (OFF=完全 inert・Codex P2: health/
// relay 列挙にも出さない)。条件付き object spread は optional-key 型になり Record に不適合のため
// 宣言後に代入する。
if (env.enableJpycAvalanche) {
  SUPPORTED_CHAINS[avalanche.id] = {
    chain: avalanche,
    rpc: process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL,
  };
  SUPPORTED_CHAINS[avalancheFuji.id] = {
    chain: avalancheFuji,
    rpc: process.env.NEXT_PUBLIC_AVALANCHE_FUJI_RPC_URL,
  };
}

// mainnet chain (実マネー)。recover の self-host hardening (KV + gas-cost ceiling 必須) を強制する
// 判定に使う。testnet (Amoy/Kairos) は緩く運用可。新規 mainnet chain を SUPPORTED_CHAINS に
// 足したら、ここにも追加して silent な fail-open を防ぐこと。
export const MAINNET_CHAINS: ReadonlySet<number> = new Set([
  polygon.id,
  kaia.id,
  // Avalanche mainnet のみ (Fuji=testnet=緩和)。flag ON のときだけ (OFF=完全 inert)。
  ...(env.enableJpycAvalanche ? [avalanche.id] : []),
]);

// JPYC (FiatToken) の EIP-3009 使用済フラグ。submit 前に読み guaranteed-revert を避ける。
const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

export function transportFor(chainId: number) {
  const cfg = SUPPORTED_CHAINS[chainId];
  return http(cfg.rpc ?? cfg.chain.rpcUrls.default.http[0]);
}

export function jpycAddressFor(chainId: number): Address | null {
  if (!(chainId in SUPPORTED_CHAINS)) return null;
  const d = resolveDeployment('jpyc', chainId);
  return d ? d.address : null;
}

export async function getBalance(
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

export async function readAuthorizationUsed(
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
export function selfHostIoFor(chainId: number): SelfHostIo {
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

// free モード (直接 transferWithAuthorization) の relay を実行する共有エントリ。decision (chain 対応・
// PROVIDER 種別・gas ceiling・低残高警告・idempotency prefix) を一箇所に集約し、決済 route の
// handleFree と CSV パス購入 route の双方から呼ぶ。idemPrefix で route ごとの冪等名前空間を分ける
// (rate-limit / 日次予算は relayGuards 内で両 route 共有キー)。
export function relayFreeAuthorization(
  chainId: number,
  auth: Eip3009Authorization,
  signature: Hex,
  rateLimitKeys: string[],
  opts: { idemPrefix: string },
): Promise<RelayResult> {
  const supported = chainId in SUPPORTED_CHAINS;
  const { claimIdempotency, recordRelayHash, releaseIdempotency } =
    makeIdempotency(opts.idemPrefix);
  const common = {
    nowSec: () => Math.floor(Date.now() / 1000),
    maxValue: MAX_VALUE,
    jpycAddressFor,
    getBalance,
    checkRateLimit,
    checkGasBudget,
    refundGasBudget,
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
          maxGasCostWei: relayMaxGasCostWei(chainId),
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
  return relayJpycAuthorization(
    { chainId, auth, signature, rateLimitKeys },
    deps,
  );
}
