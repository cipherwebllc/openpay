// EOA に EIP-7702 で設定された delegation 先を識別する。
// `eth_getCode(eoa)` の戻りが `0xef0100<20-byte-target>` 形式なら委任有り、
// その target を OpenPay が対応している既知 implementation の表と照合する。
//
// HashPort wallet (EXPO2025 公式、1M+ ユーザ) は内部で Alchemy Smart Wallets
// を使うため初回利用時に EOA を Alchemy MAv2 へ委任する。MAv2 アドレスは
// Polygon/Base/Arbitrum/Optimism mainnet + testnet すべて同一 (CREATE2 deterministic)。
import { getAddress, type Address, type PublicClient } from 'viem';

export const PIMLICO_SIMPLE7702_ADDRESS: Address = getAddress(
  '0xe6Cae83BdE06E4c305530e199D7217f42808555B',
);
export const ALCHEMY_MAV2_ADDRESS: Address = getAddress(
  '0x69007702764179F14f51cdcE752f4F775d74E139',
);

const EIP7702_PREFIX = '0xef0100';

export type AccountKind =
  | 'none' // EOA pristine, code 空
  | 'pimlico-simple-7702' // 0xef0100 + Pimlico SimpleAccount
  | 'alchemy-mav2-7702' // 0xef0100 + Alchemy Modular Account v2
  | 'unknown'; // 0xef0100 + 別 implementation、または non-7702 contract code

/**
 * EOA address の `eth_getCode` を読み、AccountKind を返す。
 * RPC 失敗時は throw (呼び出し元が retry / UI 表示の判断をする)。
 */
export async function detectAccountKind(
  publicClient: PublicClient,
  address: Address,
): Promise<{ kind: AccountKind; delegateAddress: Address | null }> {
  const code = (await publicClient.getCode({ address })) ?? '0x';
  // 空 EOA: '0x' or '' 相当
  if (code === '0x' || code.length <= 2) {
    return { kind: 'none', delegateAddress: null };
  }
  // EIP-7702 delegation indicator: '0xef0100' + 40 hex chars (20 byte address)
  // 全長は 6 + 40 = 46 hex (+ '0x' prefix で 48 chars)
  const lower = code.toLowerCase();
  if (!lower.startsWith(EIP7702_PREFIX) || lower.length !== 48) {
    return { kind: 'unknown', delegateAddress: null };
  }
  const targetHex = `0x${lower.slice(EIP7702_PREFIX.length)}` as Address;
  let target: Address;
  try {
    target = getAddress(targetHex);
  } catch {
    return { kind: 'unknown', delegateAddress: null };
  }
  if (target === PIMLICO_SIMPLE7702_ADDRESS) {
    return { kind: 'pimlico-simple-7702', delegateAddress: target };
  }
  if (target === ALCHEMY_MAV2_ADDRESS) {
    return { kind: 'alchemy-mav2-7702', delegateAddress: target };
  }
  return { kind: 'unknown', delegateAddress: target };
}

export class IncompatibleSmartAccountError extends Error {
  readonly delegateAddress: Address | null;
  readonly i18nKey: 'errorIncompatibleSmartAccount' | 'errorMav2Disabled';
  constructor(args: {
    delegateAddress: Address | null;
    i18nKey: 'errorIncompatibleSmartAccount' | 'errorMav2Disabled';
  }) {
    super(
      `incompatible_smart_account: delegate=${args.delegateAddress ?? 'none'} (${args.i18nKey})`,
    );
    this.name = 'IncompatibleSmartAccountError';
    this.delegateAddress = args.delegateAddress;
    this.i18nKey = args.i18nKey;
  }
}

export function isIncompatibleSmartAccountError(
  err: unknown,
): err is IncompatibleSmartAccountError {
  // instanceof は HMR / 別バンドルで壊れることがあるので name でも判定
  return (
    err instanceof IncompatibleSmartAccountError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'IncompatibleSmartAccountError')
  );
}
