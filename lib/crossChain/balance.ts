// Cross-chain buyer balance query — 2 系統の balance を 1 fetcher で扱う:
//
//   1. on-chain wallet USDC balance (各 chain の ERC20.balanceOf, 並列 RPC)
//      → 直接 path / CCTP V2 path の意思決定で使う
//      → phase 1 demo では「buyer が target chain と異なる chain に USDC を
//         持っているか」を可視化するのに利用
//
//   2. Gateway unified balance (Circle attestation API POST /v1/balances)
//      → Gateway path の意思決定 + UI 表示で使う
//      → 同じ depositor に対する各 source domain の available balance を
//         一度に取得 (sources array で複数 domain 同時 query 可能)
//
// 設計判断:
//   - on-chain balance は viem の createPublicClient + balanceOf を並列実行。
//     既存 customRpcUrlForChain (lib/chains.ts) を経由して env-override 可
//   - Gateway balance は public attestation API。API key 不要、fetch のみ
//   - 失敗時の挙動: 1 chain だけ落ちても他 chain の balance は返す
//     (Promise.allSettled で fulfilled の値を集計、rejected は status: 'error'
//     で entry を保持して UI に「unavailable」表示の判断材料を渡す)
//
// セキュリティ:
//   - fetch する URL は config の whitelist (CIRCLE_GATEWAY_API_BASE_URL) 経由のみ
//   - depositor address は API request body の中に入るが、これは public 情報

import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import type { Chain } from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
} from 'viem/chains';
import { customRpcUrlForChain } from '../chains';
import { resolveDeployment } from '../tokens';
import {
  CIRCLE_GATEWAY_API_BASE_URL,
  CROSS_CHAIN_TARGETS,
} from './config';
import type {
  BalanceQueryRequest,
  BalanceQueryResponse,
  BalanceQuerySource,
  CircleDomain,
  CrossChainTarget,
  FetchLike,
} from './types';

// 1 chain あたり on-chain balance query の結果。`status: 'error'` のときは
// balance が undefined になる (UI 側で「取得できず」と表示する)。
export type WalletUsdcBalance =
  | {
      status: 'ok';
      target: CrossChainTarget;
      tokenAddress: Address;
      /** raw atomic units (USDC: 6 decimals) */
      balance: bigint;
    }
  | {
      status: 'error';
      target: CrossChainTarget;
      tokenAddress: Address;
      error: string;
    };

export interface MultiChainBalances {
  /** 各 chain の wallet ERC20 USDC.balanceOf 結果 (chain ごとに success/error 個別) */
  wallet: WalletUsdcBalance[];
  /** Gateway unified balance (深 chain で pre-deposit された available USDC) */
  gateway: GatewayUnifiedBalance;
}

export type GatewayUnifiedBalance =
  | {
      status: 'ok';
      depositor: Address;
      /** domain → balance (atomic, USDC 6 decimals)。問合せた sources 全件を入れる */
      perDomain: Map<CircleDomain, bigint>;
      /** 全 domain 合算 (UX で "unified" として表示する値) */
      total: bigint;
    }
  | {
      status: 'error';
      depositor: Address;
      error: string;
    };

// chain ごとに publicClient を組み立てる (env override → public RPC fallback)。
// viem の Chain object に rpcUrls.default.http が含まれるため、env override が
// 無ければ Chain object の default URL を使う。
function publicClientFor(chain: Chain) {
  const url = customRpcUrlForChain(chain.id);
  return createPublicClient({
    chain,
    transport: url ? http(url) : http(),
  });
}

// USDC TokenDeployment を resolveDeployment で引く (lib/tokens.ts 経由)。
// 4 chain 全てに USDC deployment が存在することは TOKEN_DEPLOYMENTS で保証済
// (USDC_CHAINS の全 chain で deployment あり)。
function resolveUsdcAddress(chainId: number): Address {
  const dep = resolveDeployment('usdc', chainId);
  if (!dep) {
    // resolveDeployment の戻り型は optional だが、CROSS_CHAIN_TARGETS は
    // OpenPay USDC 4 chain 限定なので到達不能。lint 用に narrowing で throw。
    throw new Error(
      `USDC deployment not found for chainId=${chainId} ` +
        `(CROSS_CHAIN_TARGETS と TOKEN_DEPLOYMENTS が同期していません)`,
    );
  }
  return dep.address;
}

// 各 chain の publicClient + USDC deployment を CrossChainTarget から build。
// テストから差替できるよう、内部関数として export せず callable factory のみ。
async function readWalletBalanceOne(
  target: CrossChainTarget,
  account: Address,
  chainResolver: (chainId: number) => Chain,
): Promise<WalletUsdcBalance> {
  const chain = chainResolver(target.chainId);
  const client = publicClientFor(chain);
  const tokenAddress = resolveUsdcAddress(target.chainId);
  const balance = (await client.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })) as bigint;
  return { status: 'ok', target, tokenAddress, balance };
}

/**
 * Buyer の `account` address について、CROSS_CHAIN_TARGETS の全 chain の
 * USDC.balanceOf を並列 query する。1 chain ごとに success/error が独立
 * (allSettled)。
 *
 * @param account     buyer の EOA / smart wallet address
 * @param chainResolver  chainId → viem Chain を返す (test 注入用 — production は
 *                       customResolver 未指定で `viem/chains` から resolve)
 */
export async function readMultiChainWalletBalances(
  account: Address,
  chainResolver: (chainId: number) => Chain = chainResolveFromTargets,
): Promise<WalletUsdcBalance[]> {
  const settled = await Promise.allSettled(
    CROSS_CHAIN_TARGETS.map((t) =>
      readWalletBalanceOne(t, account, chainResolver),
    ),
  );
  return settled.map((r, idx) => {
    const target = CROSS_CHAIN_TARGETS[idx];
    if (r.status === 'fulfilled') return r.value;
    const tokenAddress = resolveUsdcAddress(target.chainId);
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return { status: 'error', target, tokenAddress, error };
  });
}

// CROSS_CHAIN_TARGETS から chainId → Chain を引く default resolver。
// Map で 1 度だけ初期化することで lookup を O(1)、chain 追加時の同期コストも
// 低い (本 Map と CROSS_CHAIN_TARGETS の 2 箇所更新のみ)。test から差替可能。
const CHAIN_BY_ID = new Map<number, Chain>([
  [polygon.id, polygon],
  [polygonAmoy.id, polygonAmoy],
  [base.id, base],
  [baseSepolia.id, baseSepolia],
  [arbitrum.id, arbitrum],
  [arbitrumSepolia.id, arbitrumSepolia],
  [optimism.id, optimism],
  [optimismSepolia.id, optimismSepolia],
]);

function chainResolveFromTargets(chainId: number): Chain {
  const c = CHAIN_BY_ID.get(chainId);
  if (!c) {
    throw new Error(
      `chainResolveFromTargets: unknown chainId ${chainId} ` +
        `(CROSS_CHAIN_TARGETS と viem/chains の同期確認が必要)`,
    );
  }
  return c;
}

/**
 * Circle attestation API `/v1/balances` を叩いて Gateway unified balance を
 * domain ごとに取得する。
 *
 * @param depositor  Gateway に deposit した user の address
 * @param domains    問合せ対象の domain 一覧 (省略時は CROSS_CHAIN_TARGETS 全件)
 * @param opts       fetch / baseUrl の DI (test 用)
 */
export async function readGatewayUnifiedBalance(
  depositor: Address,
  domains: CircleDomain[] = CROSS_CHAIN_TARGETS.map((t) => t.domain),
  opts: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<GatewayUnifiedBalance> {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? CIRCLE_GATEWAY_API_BASE_URL;

  const sources: BalanceQuerySource[] = domains.map((domain) => ({
    domain,
    depositor,
  }));
  const requestBody: BalanceQueryRequest = {
    token: 'USDC',
    sources,
  };

  const res = await fetchImpl(`${baseUrl}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      status: 'error',
      depositor,
      error: `Circle attestation API /v1/balances HTTP ${res.status}: ${text.slice(0, 500)}`,
    };
  }

  const json = (await res.json()) as BalanceQueryResponse;
  // balance は raw atomic string (大きい値の可能性 — BigInt で扱う)
  const perDomain = new Map<CircleDomain, bigint>();
  let total = 0n;
  for (const entry of json.balances) {
    const v = BigInt(entry.balance);
    perDomain.set(entry.domain, v);
    total += v;
  }
  return { status: 'ok', depositor, perDomain, total };
}

/**
 * Convenience: wallet ERC20 + Gateway unified を並列で取得する。phase 1 demo
 * page で 1 callsite から 2 系統まとめて呼ぶときに使う。
 */
export async function readAllCrossChainBalances(
  account: Address,
  opts: {
    fetch?: FetchLike;
    baseUrl?: string;
    chainResolver?: (chainId: number) => Chain;
  } = {},
): Promise<MultiChainBalances> {
  const [wallet, gateway] = await Promise.all([
    readMultiChainWalletBalances(account, opts.chainResolver),
    readGatewayUnifiedBalance(account, undefined, {
      fetch: opts.fetch,
      baseUrl: opts.baseUrl,
    }),
  ]);
  return { wallet, gateway };
}
