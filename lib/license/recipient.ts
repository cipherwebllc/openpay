import 'server-only';

import { randomBytes } from 'node:crypto';
import { BaseError, ContractFunctionRevertedError, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { LicenseDefinition } from './definition';
import { licenseNftEnabled } from './config';
import { licenseRpc } from './rpc';

const ABI = parseAbi([
  'function minter() view returns (address)',
  'function mintFor(address to,uint256 id,bytes32 paymentKey)',
  'error ERC1155InvalidReceiver(address receiver)',
]);

/** 購入署名の要求前に受取可否を eth_call で確認。決済/発行/鍵読込は行わない。 */
export async function checkLicenseRecipient(definition: LicenseDefinition, payer: Address): Promise<'supported' | 'unsupported' | 'unknown'> {
  if (!licenseNftEnabled()) return 'unknown';
  try {
    const rpc = licenseRpc(definition.tokenChainId, Date.now() + 5_000);
    const minter = await rpc.readContract({ address: definition.contract, abi: ABI, functionName: 'minter' });
    if (minter === zeroAddress) return 'unknown';
    const key = ('0x' + randomBytes(32).toString('hex')) as Hex;
    await rpc.simulateContract({ account: minter, address: definition.contract, abi: ABI, functionName: 'mintFor', args: [payer, BigInt(definition.tokenId), key] });
    return 'supported';
  } catch (error) {
    // RPC/在庫/権限の障害を「受取不能」と偽らない。確定した receiver 拒否だけ 409 にする。
    const revert = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null;
    return revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'ERC1155InvalidReceiver' ? 'unsupported' : 'unknown';
  }
}
