import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, parseAbi } from 'viem';
const h = vi.hoisted(() => ({ enabled: true, read: vi.fn(), simulate: vi.fn() }));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/license/rpc', () => ({ licenseRpc: () => ({ readContract: h.read, simulateContract: h.simulate }) }));
import { checkLicenseRecipient } from '@/lib/license/recipient';
import { createLicenseDefinition } from '@/lib/license/definition';
const PAYER = '0x1111111111111111111111111111111111111111';
const MINTER = '0x2222222222222222222222222222222222222222';
const d = createLicenseDefinition('h_' + 'a'.repeat(32), { supply: 10, transferable: false, termsUrl: 'https://seller.example', termsVersion: '1' }, 80002, '0x3333333333333333333333333333333333333333');
beforeEach(() => { vi.clearAllMocks(); h.enabled = true; h.read.mockResolvedValue(MINTER); h.simulate.mockResolvedValue({}); });
describe('pre-sign receiver simulation', () => {
  it('uses on-chain minter as eth_call sender and the payer as recipient', async () => {
    expect(await checkLicenseRecipient(d, PAYER)).toBe('supported'); expect(h.simulate).toHaveBeenCalledWith(expect.objectContaining({ account: MINTER, args: [PAYER, BigInt(d.tokenId), expect.any(String)] }));
  });
  it('distinguishes receiver rejection from RPC failure and OFF is inert', async () => {
    const abi = parseAbi(['error ERC1155InvalidReceiver(address receiver)']);
    h.simulate.mockRejectedValue(new ContractFunctionRevertedError({ abi, functionName: 'mintFor', data: encodeErrorResult({ abi, errorName: 'ERC1155InvalidReceiver', args: [PAYER] }) }));
    expect(await checkLicenseRecipient(d, PAYER)).toBe('unsupported');
    h.simulate.mockRejectedValue(new Error('RPC outage')); expect(await checkLicenseRecipient(d, PAYER)).toBe('unknown');
    h.enabled = false; h.read.mockClear(); expect(await checkLicenseRecipient(d, PAYER)).toBe('unknown'); expect(h.read).not.toHaveBeenCalled();
  });
});
