import 'server-only';

import { getAddress, isAddressEqual, parseAbi, type Address, type Hex } from 'viem';
import type { PurchaseOwnership } from '@/lib/x402/purchaseIntent';
import { licenseNftEnabled } from './config';
import { type LicenseDefinition } from './definition';
import { computeLicensePaymentKey } from './paymentKey';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import { licenseRpc } from './rpc';
import { readLicenseProof, type LicenseProof } from './jobs';
import type { LicenseRightsAdmission } from './rightsAdmission';

const ABI = parseAbi([
  'function balanceOf(address account,uint256 id) view returns (uint256)',
  'function paymentKeyOf(bytes32 key) view returns ((uint256 id,address to))',
]);
export type LicenseRights = { entitled: boolean | null; basis: 'purchase' | 'holder' | null; nft: LicenseProof; observedBlock?: string };
export type LicenseRightsChain = {
  block(): Promise<bigint>;
  balance(address: Address, definition: LicenseDefinition, block: bigint): Promise<bigint>;
  consumed(paymentKey: Hex, definition: LicenseDefinition, block: bigint): Promise<{ id: bigint; to: Address }>;
};
const RIGHTS_RPC_WINDOW_MS = 6_000;
// 1 商品あたりの RPC 窓 (6 秒) と、呼出側のページ全体の期限の早い方 (第 7 回レビュー B13: 商品ごとに
// 期限をリセットするとページ全体の待機を制限できない)。
function defaultChain(definition: LicenseDefinition, deadline?: number): LicenseRightsChain {
  const window = Date.now() + RIGHTS_RPC_WINDOW_MS;
  const rpc = licenseRpc(definition.tokenChainId, deadline !== undefined && deadline < window ? deadline : window);
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
export async function resolveLicenseRights(input: { address: Address; productId: string; definition: LicenseDefinition; ownership: PurchaseOwnership | null; chain?: LicenseRightsChain; deadline?: number; admission?: LicenseRightsAdmission }): Promise<LicenseRights> {
  if (!licenseNftEnabled()) return UNKNOWN;
  const { definition, ownership } = input;
  const grants = ownership && ownership.resourceId === input.productId && isAddressEqual(ownership.payer, input.address)
    ? ownership.grants.filter((g) => g.metadata.license?.definitionHash === definition.definitionHash) : [];
  let proof: LicenseProof = { status: 'unknown' };
  if (grants.length) {
    const grant = grants.reduce((a, b) => a.purchasedAt > b.purchasedAt ? a : b);
    try {
      proof = await readLicenseProof(computeLicensePaymentKey({ paymentChainId: BigInt(grant.chainId), paymentToken: JPYC_V3_ASSET.address, payer: input.address, authorizationNonce: grant.nonce }));
    } catch {
      // 証明状態の読込障害を非譲渡ライセンスの購入権利へ波及させない。
    }
  }
  if (!definition.transferable) return { entitled: grants.length > 0, basis: grants.length ? 'purchase' : null, nft: proof };
  // 第 7 回レビュー B9: RPC の同時実行枠は「実際に RPC を始める直前」にだけ取る。譲渡不可・flag OFF は
  // ここに来ないので枠にも枠の KV 障害にも触れない。枠が取れなければ RPC 不明と同じ unknown (denied にしない)。
  let lease: string | null | undefined;
  try {
    if (input.admission) {
      lease = await input.admission.acquire();
      if (!lease) return { ...UNKNOWN, nft: { ...proof, status: 'unknown' } };
    }
    const chain = input.chain ?? defaultChain(definition, input.deadline);
    const block = await chain.block();
    if (await chain.balance(input.address, definition, block) > 0n) return { entitled: true, basis: 'holder', nft: { ...proof, status: 'minted' }, observedBlock: block.toString() };
    // 1 request の RPC を上限化 (40)。未確認の grant を非所有と偽らず unknown へ分離する。
    // grant は finalize で末尾に追加されるので、最新 (purchasedAt 降順・同時刻は後に追加された方が先) から検査する:
    // 古い 40 件を先に見ると、mint 済み・譲渡済みの旧 grant の陰で 41 件目以降の未 mint 購入が unknown に隠れる
    // (第 7 回レビュー B7)。上限は保ち、unknown を true/false に変換しない。
    const newestFirst = grants.slice().reverse().sort((a, b) => b.purchasedAt - a.purchasedAt);
    for (const grant of newestFirst.slice(0, 40)) {
      const key = computeLicensePaymentKey({ paymentChainId: BigInt(grant.chainId), paymentToken: JPYC_V3_ASSET.address, payer: input.address, authorizationNonce: grant.nonce });
      const record = await chain.consumed(key, definition, block);
      if (isAddressEqual(record.to, getAddress('0x0000000000000000000000000000000000000000'))) return { entitled: true, basis: 'purchase', nft: { ...proof, status: proof.status === 'unknown' || proof.status === 'minted' ? 'pending' : proof.status }, observedBlock: block.toString() };
      if (record.id !== BigInt(definition.tokenId) || !isAddressEqual(record.to, input.address)) return UNKNOWN;
    }
    if (grants.length > 40) return UNKNOWN;
    return { entitled: false, basis: 'holder', nft: { ...proof, status: grants.length ? 'minted' : 'unknown' }, observedBlock: block.toString() };
  } catch {
    // RPC 不明を元購入者の fallback 権利/非所有へ変換して誤配信する波及を断つ。
    return { ...UNKNOWN, nft: { ...proof, status: 'unknown' } };
  } finally {
    // 返却の失敗は権利の応答に波及させない (60 秒 lease で回収される)。
    if (lease && input.admission) {
      try { await input.admission.release(lease); } catch { /* lease 失効で回収 */ }
    }
  }
}
