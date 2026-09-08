import 'server-only';

import { createPublicClient, isAddressEqual, parseAbi, parseEventLogs, type Hex } from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { kvEval } from '@/lib/kv';
import { getHostedProductUpdateSnapshot } from '@/lib/x402/hostedStore';
import { licenseNftEnabled } from './config';

const ABI = parseAbi([
  'function licenseOf(uint256 id) view returns ((uint64 maxSupply,uint64 minted,bool transferable,bool exists,bytes32 definitionHash))',
  'event LicenseRegistered(uint256 indexed id,uint64 maxSupply,bool transferable,bytes32 definitionHash)',
]);
const CONFIRM =
  'local t=redis.call("TYPE",KEYS[1]); if type(t)=="table" then t=t.ok end; if t~="string" then return 0 end; ' +
  'if redis.call("GET",KEYS[1])~=ARGV[1] then return 0 end; ' +
  'local ok,v=pcall(cjson.decode,ARGV[2]); if not ok or type(v)~="table" then return 0 end; ' +
  'redis.call("SET",KEYS[1],ARGV[2]); return 1; ';

/** worker 用の登録確認。receipt と finalized の定義が一致したときだけ registered を保存する。 */
export async function confirmLicenseRegistration(productId: string, txHash: Hex): Promise<'registered' | 'pending' | 'conflict' | 'storage'> {
  if (!licenseNftEnabled()) return 'pending';
  const snapshot = await getHostedProductUpdateSnapshot(productId);
  if (snapshot === 'storage') return 'storage';
  if (!snapshot || snapshot.product.productKind !== 'license' || !snapshot.product.license) return 'conflict';
  const d = snapshot.product.license;
  try {
    const chain = chainObjectForId(d.tokenChainId);
    if (!chain) return 'conflict';
    const rpc = createPublicClient({ chain, transport: transportForChain(d.tokenChainId) });
    const block = await rpc.getBlock({ blockTag: 'finalized' });
    const receipt = await rpc.getTransactionReceipt({ hash: txHash });
    if (receipt.blockNumber > block.number) return 'pending';
    if (receipt.status !== 'success' || receipt.transactionHash !== txHash || (await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) return 'conflict';
    const registered = await rpc.readContract({ address: d.contract, abi: ABI, functionName: 'licenseOf', args: [BigInt(d.tokenId)], blockNumber: block.number });
    if (!registered.exists || registered.definitionHash !== d.definitionHash || registered.maxSupply !== BigInt(d.supply) || registered.transferable !== d.transferable) return 'conflict';
    const matches = parseEventLogs({ abi: ABI, eventName: 'LicenseRegistered', logs: receipt.logs.filter((l) => isAddressEqual(l.address, d.contract)), strict: true }).some(({ args }) => args.id === BigInt(d.tokenId) && args.maxSupply === BigInt(d.supply) && args.transferable === d.transferable && args.definitionHash === d.definitionHash);
    if (!matches) return 'conflict';
    if ((await rpc.getBlock({ blockNumber: block.number })).hash !== block.hash) return 'pending';
    const next = { ...snapshot.product, registration: { status: 'registered', txHash, attempts: snapshot.product.registration!.attempts }, updatedAt: Date.now() };
    const saved = await kvEval<number>(CONFIRM, ['x402:hosted:' + productId], [snapshot.token, JSON.stringify(next)]);
    return !saved.ok ? 'storage' : saved.value === 1 ? 'registered' : 'conflict';
  } catch {
    // RPC/receipt 不明が「登録済み」へ波及し、未登録商品の署名要求を開かないよう保留する。
    return 'pending';
  }
}
