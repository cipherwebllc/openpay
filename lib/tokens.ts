import type { Address } from 'viem';
import { base, baseSepolia, polygon, polygonAmoy } from 'viem/chains';
import { env, isMainnet } from './env';

export type TokenSymbol = 'jpyc' | 'usdc';

// 'sponsorship' = Pimlico Sponsorship (Verifying) Paymaster で運営がガスを肩代わり
// 'erc20'       = Pimlico ERC20 Paymaster で顧客がトークンでガスを支払う
//                 (mainnet 限定。testnet では実装側で sponsorship にフォールバックする)
export type PaymasterMode = 'sponsorship' | 'erc20';

export type TokenInfo = {
  symbol: TokenSymbol;
  displaySymbol: string;
  name: string;
  decimals: number;
  address: Address;
  chainId: number;
  paymasterMode: PaymasterMode;
};

// ⚠️ 重要: 以下のアドレスは本番投入前に必ず公式ソースで再確認してください。
//   - JPYC は v1 / v2 / PLUS など複数バージョンが存在し、移行されることがある。
//   - 万一誤ったアドレスを使用すると顧客資金が失われる可能性があります。
//   - 不一致が見つかった場合は NEXT_PUBLIC_JPYC_MAINNET_ADDRESS で上書き可能。
const JPYC_POLYGON_DEFAULT: Address =
  '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
// USDC native by Circle (Base mainnet) — Circle 公式
const USDC_BASE_DEFAULT: Address =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// USDC on Base Sepolia (Circle 公式 faucet 対応)
const USDC_BASE_SEPOLIA_DEFAULT: Address =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

export const TOKENS: Record<TokenSymbol, TokenInfo> = {
  jpyc: {
    symbol: 'jpyc',
    displaySymbol: 'JPYC',
    name: 'JPY Coin',
    decimals: 18,
    address: isMainnet
      ? (env.mainnetTokenOverrides.jpyc ?? JPYC_POLYGON_DEFAULT)
      : (env.testnetTokenOverrides.jpyc ?? ZERO),
    chainId: isMainnet ? polygon.id : polygonAmoy.id,
    // JPYC は Pimlico ERC20 Paymaster の対応外なので運営がガスを肩代わり。
    // Polygon の POL ガスは平常 1〜3 JPY と廉価なので 15 JPYC フロアで黒字。
    paymasterMode: 'sponsorship',
  },
  usdc: {
    symbol: 'usdc',
    displaySymbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    address: isMainnet
      ? (env.mainnetTokenOverrides.usdc ?? USDC_BASE_DEFAULT)
      : (env.testnetTokenOverrides.usdc ?? USDC_BASE_SEPOLIA_DEFAULT),
    chainId: isMainnet ? base.id : baseSepolia.id,
    // USDC は Pimlico ERC20 Paymaster で顧客が USDC のままガスを支払う。
    // Base の ETH ガスを運営が立替えると赤字化リスクが高いため。
    // testnet (Base Sepolia) では sponsorship にフォールバックする (lib/pimlico.ts)。
    paymasterMode: 'erc20',
  },
};

export function getToken(symbol: TokenSymbol): TokenInfo {
  return TOKENS[symbol];
}

export function isValidTokenSymbol(value: string): value is TokenSymbol {
  return value === 'jpyc' || value === 'usdc';
}
