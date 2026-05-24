// Cross-chain buyer balance query — wallet ERC20 USDC (7 chain: 5 merchant +
// 2 buyer-only Avalanche/Unichain) + Gateway unified balance (Circle API) を
// 1 callsite で取得。
//
// Promise.allSettled で 1 chain の RPC 失敗が他 chain に波及しないようにし、
// 失敗 chain は status:'error' entry として残す (UI 側で「unavailable」を出すため)。

import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import type { Chain } from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
  unichain,
  unichainSepolia,
} from 'viem/chains';
import { customRpcUrlForChain } from '../chains';
import { resolveDeployment } from '../tokens';
import {
  BUYER_SOURCE_TARGETS,
  CIRCLE_GATEWAY_API_BASE_URL,
} from './config';
import type {
  BalanceQueryRequest,
  BalanceQueryResponse,
  BalanceQuerySource,
  CircleDomain,
  CrossChainTarget,
  FetchLike,
} from './types';

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
  wallet: WalletUsdcBalance[];
  gateway: GatewayUnifiedBalance;
}

export type GatewayUnifiedBalance =
  | {
      status: 'ok';
      depositor: Address;
      /** problem source domain → atomic balance (USDC 6 decimals) */
      perDomain: Map<CircleDomain, bigint>;
      /** 全 domain 合算 (UX の "unified" 表示用) */
      total: bigint;
    }
  | {
      status: 'error';
      depositor: Address;
      error: string;
    };

function publicClientFor(chain: Chain) {
  const url = customRpcUrlForChain(chain.id);
  return createPublicClient({
    chain,
    transport: url ? http(url) : http(),
  });
}

// BUYER_SOURCE_TARGETS / TOKEN_DEPLOYMENTS の同期漏れを検出するための guard
// (両 const を更新せずに chain を追加すると silent に 0 balance を返してしまう)。
function resolveUsdcAddress(chainId: number): Address {
  const dep = resolveDeployment('usdc', chainId);
  if (!dep) {
    throw new Error(
      `USDC deployment not found for chainId=${chainId} ` +
        `(BUYER_SOURCE_TARGETS と TOKEN_DEPLOYMENTS が同期していません)`,
    );
  }
  return dep.address;
}

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

// BUYER_SOURCE_TARGETS の全 chain で USDC.balanceOf を並列 query。1 chain の失敗は
// 該当 entry を status:'error' で返すのみで他 chain に波及しない (allSettled)。
// chainResolver は test injection のため (production は default で十分)。
export async function readMultiChainWalletBalances(
  account: Address,
  chainResolver: (chainId: number) => Chain = chainResolveFromTargets,
): Promise<WalletUsdcBalance[]> {
  const settled = await Promise.allSettled(
    BUYER_SOURCE_TARGETS.map((t) =>
      readWalletBalanceOne(t, account, chainResolver),
    ),
  );
  return settled.map((r, idx) => {
    const target = BUYER_SOURCE_TARGETS[idx];
    if (r.status === 'fulfilled') return r.value;
    const tokenAddress = resolveUsdcAddress(target.chainId);
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return { status: 'error', target, tokenAddress, error };
  });
}

// chain 追加時は BUYER_SOURCE_TARGETS と本 Map の 2 箇所を更新する。
const CHAIN_BY_ID = new Map<number, Chain>([
  [polygon.id, polygon],
  [polygonAmoy.id, polygonAmoy],
  [base.id, base],
  [baseSepolia.id, baseSepolia],
  [arbitrum.id, arbitrum],
  [arbitrumSepolia.id, arbitrumSepolia],
  [optimism.id, optimism],
  [optimismSepolia.id, optimismSepolia],
  [mainnet.id, mainnet],
  [sepolia.id, sepolia],
  // phase 4b-1: buyer-only chain (merchant 受信 chain には出さないが balance fetch 対象)
  [avalanche.id, avalanche],
  [avalancheFuji.id, avalancheFuji],
  [unichain.id, unichain],
  [unichainSepolia.id, unichainSepolia],
]);

function chainResolveFromTargets(chainId: number): Chain {
  const c = CHAIN_BY_ID.get(chainId);
  if (!c) {
    throw new Error(
      `chainResolveFromTargets: unknown chainId ${chainId} ` +
        `(BUYER_SOURCE_TARGETS と viem/chains の同期確認が必要)`,
    );
  }
  return c;
}

// POST /v1/balances で domain ごとの Gateway unified balance を取得。
// domains は省略時 BUYER_SOURCE_TARGETS 全件 (5 chain) を 1 リクエストで問合せ。
export async function readGatewayUnifiedBalance(
  depositor: Address,
  domains: CircleDomain[] = BUYER_SOURCE_TARGETS.map((t) => t.domain),
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
  // balance は raw atomic string (uint256 max まで取り得る → BigInt)
  const perDomain = new Map<CircleDomain, bigint>();
  let total = 0n;
  for (const entry of json.balances) {
    const v = BigInt(entry.balance);
    perDomain.set(entry.domain, v);
    total += v;
  }
  return { status: 'ok', depositor, perDomain, total };
}

// wallet ERC20 + Gateway unified を 1 callsite で並列取得 (CrossChainHint /
// demo の primary entry point)。
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
