import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Address,
} from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { env } from './env';

// ENS (.eth) も Basenames (.base.eth) も Ethereum mainnet の ENS Universal
// Resolver で解決する。Basenames は L2 (Base) の Registry / Resolver を
// 直接叩く必要はなく、mainnet UR が CCIP-Read (ERC-3668) で Base 上の
// resolver を呼び出して address を返す (`jesse.base.eth` 等で 2026-05-14 実証)。
//
// CCIP-Read 対応 RPC が必須:
// cloudflare-eth.com 等は非対応で "Internal error" を返す。既定は
// publicnode (対応確認済)、上書きは NEXT_PUBLIC_MAINNET_RPC_URL。
const ensClient = createPublicClient({
  chain: mainnet,
  transport: http(env.rpc.mainnet ?? 'https://ethereum-rpc.publicnode.com'),
});

const NAME_PATTERN = /\.eth$/i;

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

  if (NAME_PATTERN.test(trimmed)) {
    const name = normalize(trimmed);
    const address = await ensClient.getEnsAddress({ name });
    if (!address) {
      throw new Error(`${trimmed} は登録されていません`);
    }
    return { address: getAddress(address), name: trimmed };
  }

  throw new Error('0x アドレスまたは .eth / .base.eth を入力してください');
}
