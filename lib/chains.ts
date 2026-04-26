// NETWORK_ENV: mainnet → Polygon (137) + Base (8453)
//              testnet → Polygon Amoy (80002) + Base Sepolia (84532)
import { base, baseSepolia, polygon, polygonAmoy } from 'viem/chains';
import type { Chain } from 'viem';
import { env, isMainnet } from './env';
import type { TokenSymbol } from './tokens';

export const polygonChain: Chain = isMainnet ? polygon : polygonAmoy;
export const baseChain: Chain = isMainnet ? base : baseSepolia;

export const supportedChains = [polygonChain, baseChain] as const;

export function chainForToken(token: TokenSymbol): Chain {
  return token === 'jpyc' ? polygonChain : baseChain;
}

export function customRpcUrlForChain(chainId: number): string | undefined {
  if (chainId === polygon.id) return env.rpc.polygon;
  if (chainId === polygonAmoy.id) return env.rpc.polygonAmoy;
  if (chainId === base.id) return env.rpc.base;
  if (chainId === baseSepolia.id) return env.rpc.baseSepolia;
  return undefined;
}

export function isSupportedChainId(chainId: number | undefined): boolean {
  return (
    chainId === polygonChain.id || chainId === baseChain.id
  );
}
