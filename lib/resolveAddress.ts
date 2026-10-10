import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Address,
} from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { env } from './env';
import { ResolveAddressError } from './resolveAddressError';

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
const INPUT_FORMAT_MESSAGE = '0x アドレスまたは .eth / .base.eth を入力してください';

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
    // 名前として正規化できない (空のラベル `a..eth`・使えない文字) のは入力の形の誤りで、何度試しても同じ。
    // 一時的な失敗 (RPC・CCIP-Read) と区別できるよう、形式違いと同じ ResolveAddressError にする
    // (hooks/useResolveAddress は ResolveAddressError を再試行しない)。
    let name: string;
    try {
      name = normalize(trimmed);
    } catch {
      throw new ResolveAddressError(INPUT_FORMAT_MESSAGE);
    }
    let address: Address | null;
    try {
      address = await ensClient.getEnsAddress({ name, strict: true });
    } catch (err) {
      if (isDefinitelyUnregistered(err)) throw new ResolveAddressError(`${trimmed} は登録されていません`);
      throw err;
    }
    if (!address) {
      throw new ResolveAddressError(`${trimmed} は登録されていません`);
    }
    return { address: getAddress(address), name: trimmed };
  }

  throw new ResolveAddressError(INPUT_FORMAT_MESSAGE);
}

// viem の既定 (strict でない) の getEnsAddress は、Universal Resolver の HttpError (CCIP-Read のゲートウェイの失敗) や
// ResolverError (resolver 自身の revert) まで「登録されていない = null」にする。それでは一時的な失敗 (ゲートウェイの 5xx・
// 429・404 (ERC-3668: その sender に対応しないゲートウェイも 404 を返す)・Basenames の CCIP proof の期限切れ) が確定した
// 失敗 (ResolveAddressError = 再試行しない) に化け、会計中の QR を閉じる。strict で例外を受け、名前に resolver が無い・
// resolver が契約でない・addr に対応しない、の「無い」と確かめられるものだけを確定とする (他は再試行に回す)。
const UNREGISTERED_RESOLVER_ERRORS = new Set([
  'ResolverNotContract',
  'ResolverNotFound',
  'UnsupportedResolverProfile',
]);

function isDefinitelyUnregistered(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const cause = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(cause instanceof ContractFunctionRevertedError)) return false;
  const errorName = cause.data?.errorName;
  return errorName !== undefined && UNREGISTERED_RESOLVER_ERRORS.has(errorName);
}
