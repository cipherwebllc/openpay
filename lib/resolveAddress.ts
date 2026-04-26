import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Address,
} from 'viem';
import { base, mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { env } from './env';

// ENS (.eth) は Ethereum mainnet の Universal Resolver で解決。
// viem の mainnet chain 定義に ensUniversalResolver が組込み済 (0xeEeE…eEee)。
//
// CCIP-Read (off-chain resolution、ERC-3668) 対応 RPC が必須:
// 多くの ENS 名前は L2 (Linea, Optimism 等) や off-chain resolver に
// migrate しており、resolveWithGateways で "Internal error" が出る場合は
// RPC が CCIP-Read 非対応 (cloudflare-eth.com は非対応で有名)。
//
// 既定: ethereum-rpc.publicnode.com (CCIP-Read 対応)
// 上書き: NEXT_PUBLIC_MAINNET_RPC_URL (Alchemy / Infura 等の有料 RPC 推奨)
const ensClient = createPublicClient({
  chain: mainnet,
  transport: http(env.rpc.mainnet ?? 'https://ethereum-rpc.publicnode.com'),
});

// Basenames (.base.eth) は Base mainnet の Universal Resolver で解決。
// 同じ deterministic CREATE2 アドレス (0xeEeE…eEee) が Base にもデプロイ済。
const BASE_UNIVERSAL_RESOLVER: Address =
  '0xeEeEeEee14D718C2B47D9923Deab1335E144EeEe';
const basenamesClient = createPublicClient({
  chain: base,
  transport: http(
    env.rpc.baseMainnet ?? env.rpc.base ?? 'https://mainnet.base.org',
  ),
});

const ENS_PATTERN = /\.eth$/i;
const BASENAMES_PATTERN = /\.base\.eth$/i;

export type ResolvedAddress = {
  address: Address;
  // 入力が ENS / Basenames だった場合のみ name を入れる。0x 直接入力なら null。
  name: string | null;
};

export async function resolveAddress(
  input: string,
): Promise<ResolvedAddress | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (isAddress(trimmed)) {
    return { address: getAddress(trimmed), name: null };
  }

  if (BASENAMES_PATTERN.test(trimmed)) {
    const name = normalize(trimmed);
    const address = await basenamesClient.getEnsAddress({
      name,
      universalResolverAddress: BASE_UNIVERSAL_RESOLVER,
    });
    if (!address) {
      throw new Error(`${trimmed} は登録されていません`);
    }
    return { address: getAddress(address), name: trimmed };
  }

  if (ENS_PATTERN.test(trimmed)) {
    const name = normalize(trimmed);
    const address = await ensClient.getEnsAddress({ name });
    if (!address) {
      throw new Error(`${trimmed} は登録されていません`);
    }
    return { address: getAddress(address), name: trimmed };
  }

  throw new Error('0x アドレスまたは .eth / .base.eth を入力してください');
}
