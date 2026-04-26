import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Address,
} from 'viem';
import { base, mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

// ENS (.eth) は Ethereum mainnet の Universal Resolver で解決。
// viem の mainnet chain 定義に ensUniversalResolver が組込み済 (0xeEeE…eEee)。
const ensClient = createPublicClient({
  chain: mainnet,
  transport: http('https://cloudflare-eth.com'),
});

// Basenames (.base.eth) は Base mainnet の Universal Resolver で解決。
// 同じ deterministic CREATE2 アドレス (0xeEeE…eEee) が Base にもデプロイ済。
const BASE_UNIVERSAL_RESOLVER: Address =
  '0xeEeEeEee14D718C2B47D9923Deab1335E144EeEe';
const basenamesClient = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org'),
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
