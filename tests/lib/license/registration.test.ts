import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
const h = vi.hoisted(() => ({ enabled: true, snapshot: vi.fn(), kvEval: vi.fn(), rpc: { getBlock: vi.fn(), getTransactionReceipt: vi.fn(), readContract: vi.fn() } }));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => h.enabled }));
vi.mock('@/lib/x402/hostedStore', () => ({ getHostedProductUpdateSnapshot: h.snapshot }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => ({}), transportForChain: () => ({}) }));
vi.mock('@/lib/kv', () => ({ kvEval: h.kvEval }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => h.rpc }));
import { confirmLicenseRegistration } from '@/lib/license/registration';
import { createLicenseDefinition } from '@/lib/license/definition';
const ID = 'h_' + 'a'.repeat(32);
const CONTRACT = '0x3333333333333333333333333333333333333333';
const HASH = ('0x' + 'a'.repeat(64)) as Hex;
const d = createLicenseDefinition(ID, { supply: 10, transferable: false, termsUrl: 'https://seller.example', termsVersion: '1' }, 80002, CONTRACT);
const ABI = parseAbi(['event LicenseRegistered(uint256 indexed id,uint64 maxSupply,bool transferable,bytes32 definitionHash)']);
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = true;
  h.snapshot.mockResolvedValue({ product: { id: ID, productKind: 'license', license: d, saleActive: false, registration: { status: 'pending', attempts: 1 } }, token: 'raw' });
  h.rpc.getBlock.mockResolvedValue({ number: 10n, hash: HASH, timestamp: 100n });
  h.rpc.readContract.mockResolvedValue({ exists: true, maxSupply: 10n, transferable: false, definitionHash: d.definitionHash });
  h.rpc.getTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH, blockNumber: 10n, blockHash: HASH, logs: [{ address: CONTRACT,
    topics: encodeEventTopics({ abi: ABI, eventName: 'LicenseRegistered', args: { id: BigInt(d.tokenId) } }),
    data: encodeAbiParameters([{ type: 'uint64' }, { type: 'bool' }, { type: 'bytes32' }], [10n, false, d.definitionHash]),
  }] });
  h.kvEval.mockResolvedValue({ ok: true, value: 1 });
});
describe('registration gate', () => {
  it('persists registered only for the exact finalized definition and keeps sale paused', async () => {
    expect(await confirmLicenseRegistration(ID, HASH)).toBe('registered');
    const next = JSON.parse(h.kvEval.mock.calls[0]![2][1]); expect(next.registration).toEqual({ status: 'registered', attempts: 1, txHash: HASH }); expect(next.saleActive).toBe(false);
  });
  it('does not admit a finality gap, definition mismatch or missing registration event', async () => {
    h.rpc.getBlock.mockResolvedValueOnce({ number: 9n, hash: HASH }); expect(await confirmLicenseRegistration(ID, HASH)).toBe('pending');
    h.rpc.readContract.mockResolvedValueOnce({ exists: true, maxSupply: 9n, transferable: false, definitionHash: d.definitionHash }); expect(await confirmLicenseRegistration(ID, HASH)).toBe('conflict');
    h.rpc.getTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: HASH, blockNumber: 10n, blockHash: HASH, logs: [] }); expect(await confirmLicenseRegistration(ID, HASH)).toBe('conflict'); expect(h.kvEval).not.toHaveBeenCalled();
  });
  it('OFF performs no storage or RPC work', async () => {
    h.enabled = false; expect(await confirmLicenseRegistration(ID, HASH)).toBe('pending'); expect(h.snapshot).not.toHaveBeenCalled(); expect(h.rpc.getBlock).not.toHaveBeenCalled();
  });
});
