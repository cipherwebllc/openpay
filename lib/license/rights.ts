import 'server-only';

import { createPublicClient, getAddress, isAddressEqual, parseAbi, type Address, type Hex } from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import type { PurchaseOwnership } from '@/lib/x402/purchaseIntent';
import { licenseNftEnabled } from './config';
import { type LicenseDefinition } from './definition';
import { computeLicensePaymentKey } from './paymentKey';
import { JPYC_V3_ASSET } from '@/lib/x402/types';

const ABI = parseAbi([
  'function balanceOf(address account,uint256 id) view returns (uint256)',
  'function paymentKeyOf(bytes32 key) view returns ((uint256 id,address to))',
]);
export type LicenseRights = { entitled: boolean | null; basis: 'purchase' | 'holder' | null; nft: { status: 'pending' | 'minted' | 'unknown' }; observedBlock?: string };
export type LicenseRightsChain = {
  block(): Promise<bigint>;
  balance(address: Address, definition: LicenseDefinition, block: bigint): Promise<bigint>;
  consumed(paymentKey: Hex, definition: LicenseDefinition, block: bigint): Promise<{ id: bigint; to: Address }>;
};
function defaultChain(definition: LicenseDefinition): LicenseRightsChain {
  const chain = chainObjectForId(definition.tokenChainId);
  if (!chain) throw new Error('unsupported license chain');
  const rpc = createPublicClient({ chain, transport: transportForChain(definition.tokenChainId) });
  return {
    block: async () => (await rpc.getBlock({ blockTag: 'finalized' })).number,
    balance: (address, d, blockNumber) => rpc.readContract({ address: d.contract, abi: ABI, functionName: 'balanceOf', args: [address, BigInt(d.tokenId)], blockNumber }),
    consumed: (key, d, blockNumber) => rpc.readContract({ address: d.contract, abi: ABI, functionName: 'paymentKeyOf', args: [key], blockNumber }),
  };
}
const UNKNOWN: LicenseRights = { entitled: null, basis: null, nft: { status: 'unknown' } };

/**
 * 購入済み本人の burn は不可譲渡なら証明放棄のみ。譲渡可は mint 後の balance が権威。
 * job の status は根拠にしない (receipt 保存直前 crash でも元購入者へ権利を戻さない)。
 */
export async function resolveLicenseRights(input: { address: Address; productId: string; definition: LicenseDefinition; ownership: PurchaseOwnership | null; chain?: LicenseRightsChain }): Promise<LicenseRights> {
  if (!licenseNftEnabled()) return UNKNOWN;
  const { definition, ownership } = input;
  const grants = ownership && ownership.resourceId === input.productId && isAddressEqual(ownership.payer, input.address)
    ? ownership.grants.filter((g) => g.metadata.license?.definitionHash === definition.definitionHash) : [];
  if (!definition.transferable) return { entitled: grants.length > 0, basis: grants.length ? 'purchase' : null, nft: { status: 'unknown' } };
  try {
    const chain = input.chain ?? defaultChain(definition);
    const block = await chain.block();
    if (await chain.balance(input.address, definition, block) > 0n) return { entitled: true, basis: 'holder', nft: { status: 'minted' }, observedBlock: block.toString() };
    // 1 request の RPC を上限化。未確認の grant を非所有と偽らず unknown へ分離する。
    for (const grant of grants.slice(0, 40)) {
      const key = computeLicensePaymentKey({ paymentChainId: BigInt(grant.chainId), paymentToken: JPYC_V3_ASSET.address, payer: input.address, authorizationNonce: grant.nonce });
      const record = await chain.consumed(key, definition, block);
      if (isAddressEqual(record.to, getAddress('0x0000000000000000000000000000000000000000'))) return { entitled: true, basis: 'purchase', nft: { status: 'pending' }, observedBlock: block.toString() };
      if (record.id !== BigInt(definition.tokenId) || !isAddressEqual(record.to, input.address)) return UNKNOWN;
    }
    if (grants.length > 40) return UNKNOWN;
    return { entitled: false, basis: 'holder', nft: { status: grants.length ? 'minted' : 'unknown' }, observedBlock: block.toString() };
  } catch {
    // RPC 不明を元購入者の fallback 権利/非所有へ変換して誤配信する波及を断つ。
    return UNKNOWN;
  }
}
