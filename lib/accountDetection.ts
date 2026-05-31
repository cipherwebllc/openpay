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
// MetaMask Smart Account (EIP7702StatelessDeleGatorImpl v1.3.0)。CREATE2 salt
// "GATOR" で全 23 mainnet に同 address で deploy 済 (Ethereum / Polygon / BSC /
// OP / Arb / Base / Linea / Unichain / Sonic / Sei 他)。Kaia (8217) には未 deploy
// のため Kaia chain では到達しないはず — 万一 Kaia で検出した場合は metamask.ts
// builder 側で chain guard で reject する。
// 出典: https://github.com/MetaMask/delegation-framework/blob/main/documents/Deployments.md
//       https://docs.pimlico.io/guides/how-to/accounts/use-metamask-account
//       (確認 2026-05-24)
export const METAMASK_DELEGATOR_ADDRESS: Address = getAddress(
  '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
);

const EIP7702_PREFIX = '0xef0100';

export type AccountKind =
  | 'none' // EOA pristine, code 空
  | 'pimlico-simple-7702' // 0xef0100 + Pimlico SimpleAccount
  | 'alchemy-mav2-7702' // 0xef0100 + Alchemy Modular Account v2
  | 'metamask-7702' // 0xef0100 + MetaMask EIP7702StatelessDeleGatorImpl
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
  if (target === METAMASK_DELEGATOR_ADDRESS) {
    return { kind: 'metamask-7702', delegateAddress: target };
  }
  return { kind: 'unknown', delegateAddress: target };
}

export type IncompatibleSmartAccountI18nKey =
  | 'errorIncompatibleSmartAccount'
  | 'errorMav2Disabled'
  | 'errorMav2KaiaPolygon'
  | 'errorMetaMaskKaia'
  // pristine EOA (未委任) は injected wallet で 7702 委任を初回ガスレス設定できない
  // (viem signAuthorization が JSON-RPC account 非対応)。standard mode 案内に倒す。
  | 'errorPristineNoBootstrap'
  // canonical EIP-7702 非対応 chain (Avalanche C-Chain = ACP-209「7702 style」AA)。
  // 委任済み EOA でも標準 bundler 経由の 7702 UserOp が AA23 で revert するため
  // standard mode 案内に倒す ([[chainSupportsCanonical7702]])。
  | 'errorChainNo7702'
  // MetaMask Smart Account (Stateless7702) ガスレスが viem 2.50 ERC-7739 ガードと
  // delegation-toolkit 0.13.0 の非互換で署名失敗するため一時無効化 (standard 案内に倒す)。
  | 'errorMetaMaskGaslessUnavailable';

export class IncompatibleSmartAccountError extends Error {
  readonly delegateAddress: Address | null;
  readonly i18nKey: IncompatibleSmartAccountI18nKey;
  constructor(args: {
    delegateAddress: Address | null;
    i18nKey: IncompatibleSmartAccountI18nKey;
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
