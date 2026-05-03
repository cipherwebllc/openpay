// EIP-681 (Ethereum URI) ERC20 transfer encoder/parser.
//
// 仕様: https://eips.ethereum.org/EIPS/eip-681
//
//   ethereum:<token_address>@<chain_id>/transfer?address=<receiver>&uint256=<amount>
//
// OpenPay は通常 https://<origin>/pay?... 形式の独自 URL で QR を発行するが、
// この URL は OpenPay の hosted checkout (gasless / split / 1% 手数料) 用。
// 「OpenPay のホスト機能を使わず任意のウォレットから直接送金したい」需要のため、
// EIP-681 形式の互換 URI を併発行する手段を提供する。
//
// 適用条件 (UI 側で enforce):
//   - directTransfer = true (OpenPay 経由しない、純粋 ERC20 transfer)
//   - amount が確定 (EIP-681 では amount を URI に埋め込むのが標準的な互換性)
//   - splits 空 (EIP-681 は単一受取人)
//
// gasless / split / 1% 手数料は EIP-681 では表現できないため、上記制約以外では
// 提供しない。
import { getAddress, isAddress, parseUnits, type Address } from 'viem';

export type Eip681TransferInput = {
  /** ERC20 トークンコントラクトアドレス (例: JPYC, USDC) */
  tokenAddress: Address;
  /** EVM chain ID (例: Polygon mainnet=137, Polygon Amoy=80002, Base=8453) */
  chainId: number;
  /** 受取人アドレス */
  to: Address;
  /** 送金額 (人間可読 decimal 文字列。例: "10.5") */
  amount: string;
  /** トークン decimals (JPYC=18, USDC=6) */
  decimals: number;
};

export type ParsedEip681Transfer = {
  tokenAddress: Address;
  chainId: number;
  to: Address;
  /** smallest unit (wei 相当) */
  amountWei: bigint;
};

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * EIP-681 ERC20 transfer URI を生成する。
 *
 * 出力例:
 *   ethereum:0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29@137/transfer
 *     ?address=0xAbC...&uint256=1000000000000000000000
 *
 * - tokenAddress / to は EIP-55 checksum 化 (URI スキャン後の表示一貫性)
 * - amount は decimals に従い smallest unit (wei) 文字列に変換
 * - chainId は 10 進整数 (EIP-681 は CAIP-2 ではなく純粋 chain_id を使う)
 */
export function buildEip681TransferUri(input: Eip681TransferInput): string {
  if (!isAddress(input.tokenAddress)) {
    throw new Error(`Invalid token address: ${input.tokenAddress}`);
  }
  if (!isAddress(input.to)) {
    throw new Error(`Invalid receiver address: ${input.to}`);
  }
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    throw new Error(`Invalid chain id: ${input.chainId}`);
  }
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 36) {
    throw new Error(`Invalid decimals: ${input.decimals}`);
  }
  if (!DECIMAL_PATTERN.test(input.amount)) {
    throw new Error(`Invalid amount: ${input.amount}`);
  }
  // 0 / 0.0 は EIP-681 として技術的には valid だがウォレット側で nonsense なので拒否
  if (/^0+(\.0+)?$/.test(input.amount)) {
    throw new Error('Amount must be greater than zero');
  }
  // 小数点以下の桁数が decimals を超えると parseUnits が round するため、ここで明示拒否
  // (誤った金額が QR に焼かれるのを防ぐ)
  const dotIdx = input.amount.indexOf('.');
  if (dotIdx !== -1) {
    const fracDigits = input.amount.length - dotIdx - 1;
    if (fracDigits > input.decimals) {
      throw new Error(
        `Amount has more decimal places (${fracDigits}) than token decimals (${input.decimals})`,
      );
    }
  }

  const tokenChecksum = getAddress(input.tokenAddress);
  const toChecksum = getAddress(input.to);
  const amountWei = parseUnits(input.amount, input.decimals);

  // EIP-681 の query string は標準的な application/x-www-form-urlencoded。
  // address は 0x プレフィックスのまま入れる (ウォレット側はそのまま decode)。
  const sp = new URLSearchParams();
  sp.set('address', toChecksum);
  sp.set('uint256', amountWei.toString());

  return `ethereum:${tokenChecksum}@${input.chainId}/transfer?${sp.toString()}`;
}

/**
 * EIP-681 transfer URI を parse する。OpenPay は parser 自体は使わないが、
 * roundtrip テストおよび将来の inbound (URI を読んで OpenPay flow に変換) 用に提供。
 *
 * 受け付けるのは:
 *   - scheme: "ethereum:"
 *   - target_address は 0x40hex の EVM address
 *   - chain_id 必須 (省略 = mainnet 既定の慣習があるが、OpenPay は明示要求)
 *   - function_name: "transfer"
 *   - 必須 query: address, uint256
 *
 * それ以外の形式 (native ETH 送金、approve, 任意 contract call) は null を返す。
 */
export function parseEip681Transfer(uri: string): ParsedEip681Transfer | null {
  if (typeof uri !== 'string' || !uri.startsWith('ethereum:')) return null;
  const rest = uri.slice('ethereum:'.length);

  // path と query を分離
  const queryIdx = rest.indexOf('?');
  const pathPart = queryIdx === -1 ? rest : rest.slice(0, queryIdx);
  const queryPart = queryIdx === -1 ? '' : rest.slice(queryIdx + 1);

  // path = "<token_address>@<chain_id>/<function_name>"
  const slashIdx = pathPart.indexOf('/');
  if (slashIdx === -1) return null;
  const targetWithChain = pathPart.slice(0, slashIdx);
  const fnName = pathPart.slice(slashIdx + 1);
  if (fnName !== 'transfer') return null;

  const atIdx = targetWithChain.indexOf('@');
  if (atIdx === -1) return null;
  const tokenAddrRaw = targetWithChain.slice(0, atIdx);
  const chainIdRaw = targetWithChain.slice(atIdx + 1);
  if (!isAddress(tokenAddrRaw)) return null;
  if (!/^\d+$/.test(chainIdRaw)) return null;
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) return null;

  const sp = new URLSearchParams(queryPart);
  const addressRaw = sp.get('address');
  const uint256Raw = sp.get('uint256');
  if (!addressRaw || !uint256Raw) return null;
  if (!isAddress(addressRaw)) return null;
  if (!/^\d+$/.test(uint256Raw)) return null;

  return {
    tokenAddress: getAddress(tokenAddrRaw),
    chainId,
    to: getAddress(addressRaw),
    amountWei: BigInt(uint256Raw),
  };
}
