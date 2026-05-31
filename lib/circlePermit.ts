// Circle Paymaster v0.8 の EIP-2612 permit / paymasterData / deploy guard ヘルパ。
//
// lib/circlePaymaster.ts (provider 解決層・allowlist) から **分離**している理由:
// これらの関数は circle 決済の実行時 (lib/smartAccount/circleAccount.ts) でのみ必要で、
// しかも parseAbi / parseErc6492Signature 等の viem を引き込む。circleAccount は
// useSmartAccount/useBatchPayment から **dynamic import** されるため、本 module も
// その lazy chunk に同梱され、/pay /checkout の baseline bundle (budget 420kB) に
// 入らない。一方 resolveUsdcGaslessProvider 等の軽量な解決層は baseline に静的に残す。

import {
  encodePacked,
  getAddress,
  parseAbi,
  parseErc6492Signature,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { requireCirclePaymasterAddress } from './circlePaymaster';

// permit deadline は MAX_UINT256 (non-expiring)。ERC-4337 validation 制約で paymaster
// は block.timestamp を読めないため、期限付き permit は使えない (spike 確定)。
export const PERMIT_DEADLINE_MAX = 2n ** 256n - 1n;

// ---- EIP-2612 permit ヘルパ -------------------------------------------------
export type Eip2612Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

const EIP712_DOMAIN_ABI = parseAbi([
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]);
const VERSION_ABI = parseAbi(['function version() view returns (string)']);
const NAME_ABI = parseAbi(['function name() view returns (string)']);
const NONCES_ABI = parseAbi(['function nonces(address) view returns (uint256)']);

/** USDC の EIP-712 permit domain を解決。EIP-5267 eip712Domain() を優先し、無ければ
 * name()+version() フォールバック (version 取得不可なら "2" を仮定)。spike と同手順。 */
export async function readPermitDomain(
  client: PublicClient,
  token: Address,
): Promise<Eip2612Domain> {
  try {
    const d = await client.readContract({
      address: token,
      abi: EIP712_DOMAIN_ABI,
      functionName: 'eip712Domain',
    });
    return {
      name: d[1],
      version: d[2],
      chainId: Number(d[3]),
      verifyingContract: getAddress(d[4]),
    };
  } catch {
    const [name, version] = await Promise.all([
      client
        .readContract({ address: token, abi: NAME_ABI, functionName: 'name' })
        .catch(() => 'USD Coin'),
      client
        .readContract({
          address: token,
          abi: VERSION_ABI,
          functionName: 'version',
        })
        .catch(() => '2'),
    ]);
    return {
      name,
      version,
      chainId: await client.getChainId(),
      verifyingContract: token,
    };
  }
}

/** USDC permit の現在 nonce を読む。 */
export async function readPermitNonce(
  client: PublicClient,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: NONCES_ABI,
    functionName: 'nonces',
    args: [owner],
  });
}

/** permit domain が当該 chain/token と一致するか検証。drift は permit revert の早期切り
 * 分け (spike finding)。不一致は throw。 */
export function assertPermitDomain(
  domain: Eip2612Domain,
  expected: { chainId: number; token: Address },
): void {
  if (domain.chainId !== expected.chainId) {
    throw new Error(
      `permit domain chainId 不一致: ${domain.chainId} ≠ ${expected.chainId}`,
    );
  }
  if (getAddress(domain.verifyingContract) !== getAddress(expected.token)) {
    throw new Error(
      `permit domain verifyingContract 不一致: ${domain.verifyingContract} ≠ ${expected.token}`,
    );
  }
}

/** signTypedData に渡す permit payload を組む (deadline=MAX 固定)。 */
export function buildPermitTypedData(args: {
  domain: Eip2612Domain;
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
}) {
  return {
    domain: args.domain,
    types: PERMIT_TYPES,
    primaryType: 'Permit' as const,
    message: {
      owner: args.owner,
      spender: args.spender,
      value: args.value,
      nonce: args.nonce,
      deadline: PERMIT_DEADLINE_MAX,
    },
  };
}

/** Circle paymasterData = abi.encodePacked(uint8(0), usdc, permitAmount, permitSig)。
 * permitSignature は 65-byte の生 ECDSA 署名 (ERC-6492 wrapper は剥がして渡す)。 */
export function encodeCirclePaymasterData(args: {
  token: Address;
  permitAmount: bigint;
  permitSignature: Hex;
}): Hex {
  return encodePacked(
    ['uint8', 'address', 'uint256', 'bytes'],
    [0, args.token, args.permitAmount, args.permitSignature],
  );
}

/** signTypedData の戻り (ERC-6492 wrapper 付きのことがある) から生 ECDSA 署名を取り出す。 */
export function normalizePermitSignature(raw: Hex): Hex {
  return parseErc6492Signature(raw).signature;
}

// ---- deploy/runtime guard (C3) ----------------------------------------------
// allowlist アドレスに実際に contract code が在ることを検証してから permit spender
// として使う。EOA/未 deploy アドレスに permit を出す事故を防ぐ最低限の sanity。
// 期待 codehash 登録済 → assertCirclePaymasterDeployed が非空 code に加えて
// keccak256(code) 一致まで検証する (信頼境界 C3 強化)。
// 値: scripts/verify-circle-codehash.mjs で 2026-05-31 に全 14 chain (mainnet 7 +
// testnet 7・両 deployment class) の eth_getCode を keccak256 し **全て同一**を確認した。
// deterministic CREATE2 deploy のため bytecode は全 chain 共通。**未検証 chain を自動
// enforce しない**よう検証済 chainId を明示列挙する (chain 追加時は同 gate を再実行して足す)。
const CIRCLE_PAYMASTER_V08_CODEHASH: Hex =
  '0x6ed62b6e72af8fab750c07bebbe4de671b2d3c31f273cd2acefc0fa568f78a6a';
const CODEHASH_VERIFIED_CHAIN_IDS: readonly number[] = [
  // mainnet: Ethereum / Base / Arbitrum / Optimism / Polygon / Avalanche / Unichain
  1, 8453, 42161, 10, 137, 43114, 130,
  // testnet: Sepolia / Base Sepolia / Arb Sepolia / OP Sepolia / Polygon Amoy / Avax Fuji / Unichain Sepolia
  11155111, 84532, 421614, 11155420, 80002, 43113, 1301,
];
export const CIRCLE_PAYMASTER_CODEHASH: Readonly<Record<number, Hex>> =
  Object.fromEntries(
    CODEHASH_VERIFIED_CHAIN_IDS.map((id) => [id, CIRCLE_PAYMASTER_V08_CODEHASH]),
  );

/** Circle Paymaster が allowlist アドレスに deploy 済か検証。code が空 (EOA/未 deploy)
 * なら throw。期待 codehash が登録済の chain では keccak256(code) 一致まで検証する。 */
export async function assertCirclePaymasterDeployed(
  client: PublicClient,
  chainId: number,
): Promise<void> {
  const address = requireCirclePaymasterAddress(chainId);
  const code = await client.getCode({ address });
  if (!code || code === '0x' || code.length <= 2) {
    throw new Error(
      `Circle Paymaster ${address} on chain ${chainId} に contract code が無い ` +
        '(EOA/未 deploy)。permit spender として使えないため中止。',
    );
  }
  const expected = CIRCLE_PAYMASTER_CODEHASH[chainId];
  if (expected) {
    const { keccak256 } = await import('viem');
    const actual = keccak256(code);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `Circle Paymaster ${address} on chain ${chainId} の codehash 不一致: ` +
          `${actual} ≠ 期待 ${expected}。`,
      );
    }
  }
}
