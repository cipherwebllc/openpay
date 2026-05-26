// Cross-chain buyer balance query — wallet ERC20 USDC (11 chain: 6 merchant-and-buyer
// + 5 buyer-only Unichain/World Chain/Sonic/Sei/HyperEVM) + Gateway unified balance
// (Circle API) を 1 callsite で取得。
//
// Promise.allSettled で 1 chain の RPC 失敗が他 chain に波及しないようにし、
// 失敗 chain は status:'error' entry として残す (UI 側で「unavailable」を出すため)。
//
// 2026-05-26 (Phase A): 各 chain の readContract に 3 秒 timeout を追加
// (Ethereum L1 公開 RPC の hang 問題対応)。Ethereum L1 (mainnet/sepolia) のみ
// viem fallback transport で 3 endpoint chain。他 L2 chain は単一 http() のまま。

import { createPublicClient, erc20Abi, fallback, http, type Address } from 'viem';
import type { Chain } from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  hyperEvm,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sei,
  seiTestnet,
  sepolia,
  sonic,
  sonicBlazeTestnet,
  unichain,
  unichainSepolia,
  worldchain,
  worldchainSepolia,
} from 'viem/chains';
import { buyerOnlyChainForSlug, customRpcUrlForChain } from '../chains';
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

// Ethereum L1 公開 RPC の信頼性問題 (USDC.balanceOf timeout) に対応するため、
// mainnet/sepolia のみ viem fallback transport で 3 endpoint chain。
// 他 L2 chain は公開 RPC が安定なので単一 http() のまま。
// env override (NEXT_PUBLIC_ETHEREUM_RPC_URL) が設定されていればそれが primary、
// public endpoint が backup として後段に並ぶ。
const ETHEREUM_PUBLIC_FALLBACKS = [
  'https://eth.llamarpc.com',
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.ankr.com/eth',
] as const;
const SEPOLIA_PUBLIC_FALLBACKS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.ankr.com/eth_sepolia',
] as const;

function publicClientFor(chain: Chain) {
  const customUrl = customRpcUrlForChain(chain.id);

  if (chain.id === mainnet.id || chain.id === sepolia.id) {
    const fallbacks =
      chain.id === mainnet.id
        ? ETHEREUM_PUBLIC_FALLBACKS
        : SEPOLIA_PUBLIC_FALLBACKS;
    const endpoints = customUrl ? [customUrl, ...fallbacks] : [...fallbacks];
    return createPublicClient({
      chain,
      transport: fallback(endpoints.map((u) => http(u))),
    });
  }

  return createPublicClient({
    chain,
    transport: customUrl ? http(customUrl) : http(),
  });
}

// 各 chain の USDC.balanceOf 呼び出しに対する worst-case bound。
// 公開 RPC が hang した時 (Ethereum L1 で観測) 全 chain の balance fetch が
// 巻き込まれて UI が固まるのを防ぐ。timeout 後は status='error' entry として
// 残り、selectPath / pathEnumerator は該当 chain を 0 balance 扱いで routing する。
const WALLET_BALANCE_TIMEOUT_MS = 3_000;

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

// Phase A diag (2026-05-26): 実機で「Ethereum L1 USDC が認識されない」原因を
// 切り分けるための per-chain 診断ログ。ブラウザ Console に chain ごとの
// 成否 / 経過 ms / error 種別を出す。読み筋:
//   "ok in <ms>ms"          → balance fetch は成功 = 原因は下流 (selectPath/UI)
//   "FAILED ... rpc timeout" → 3s 以内に公開 RPC が応答せず (遅延/レート制限)
//   "FAILED ... HTTP/CORS"   → endpoint が CORS or HTTP error で弾いている
// NODE_ENV='test' (vitest) では抑制。原因確定後はこの関数と呼び出しを削除してよい。
function logBalanceDiag(
  chain: Chain,
  elapsedMs: number,
  outcome: { ok: true; balance: bigint } | { ok: false; error: unknown },
): void {
  if (process.env.NODE_ENV === 'test') return;
  const label = `[xchain-diag] ${chain.name} (${chain.id})`;
  if (outcome.ok) {
    console.warn(`${label}: ok in ${elapsedMs}ms balance=${outcome.balance}`);
  } else {
    const msg =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    console.warn(`${label}: FAILED after ${elapsedMs}ms — ${msg}`);
  }
}

async function readWalletBalanceOne(
  target: CrossChainTarget,
  account: Address,
  chainResolver: (chainId: number) => Chain,
): Promise<WalletUsdcBalance> {
  const chain = chainResolver(target.chainId);
  const client = publicClientFor(chain);
  const tokenAddress = resolveUsdcAddress(target.chainId);

  const balancePromise = client.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  }) as Promise<bigint>;

  // timeout 後に RPC が遅れて reject しても unhandled rejection にしない
  // (console noise 抑制、実害なし)。
  balancePromise.catch(() => {});

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(new Error(`rpc timeout (${WALLET_BALANCE_TIMEOUT_MS}ms)`)),
      WALLET_BALANCE_TIMEOUT_MS,
    ),
  );

  const start = Date.now();
  try {
    const balance = await Promise.race([balancePromise, timeoutPromise]);
    logBalanceDiag(chain, Date.now() - start, { ok: true, balance });
    return { status: 'ok', target, tokenAddress, balance };
  } catch (err) {
    logBalanceDiag(chain, Date.now() - start, { ok: false, error: err });
    throw err;
  }
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
// HyperEVM testnet は viem/chains に未収録なので lib/chains.ts の inline 定義
// (buyerOnlyChainForSlug 経由) から取り出す。
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
  // phase 4b-3: World Chain / Sonic / Sei / HyperEVM (buyer-only)
  [worldchain.id, worldchain],
  [worldchainSepolia.id, worldchainSepolia],
  [sonic.id, sonic],
  [sonicBlazeTestnet.id, sonicBlazeTestnet],
  [sei.id, sei],
  [seiTestnet.id, seiTestnet],
  [hyperEvm.id, hyperEvm],
  // HyperEVM testnet (998) は viem/chains に未収録、lib/chains.ts の defineChain
  // で inline 定義したものを buyerOnlyChainForSlug 経由で取り出す。
  // 注: mainnet env では buyerOnlyChainForSlug('hyperevm') が hyperEvm (id=999)
  // を返すので上の entry と key=999 で衝突するが Map は overwrite 許容 = no-op。
  // testnet env では hyperEvmTestnet (id=998) を返し新規 entry を追加。
  [
    buyerOnlyChainForSlug('hyperevm').id,
    buyerOnlyChainForSlug('hyperevm'),
  ],
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
