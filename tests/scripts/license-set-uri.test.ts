// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseAbi, toHex } from 'viem';
import { computeLicenseTokenId } from '@/lib/license/paymentKey';
const h = vi.hoisted(() => ({ read: vi.fn(), simulate: vi.fn(), receipt: vi.fn(), wallet: vi.fn(), write: vi.fn(), account: vi.fn(), http: vi.fn(), public: vi.fn() }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(),
  http: h.http, createPublicClient: h.public, createWalletClient: h.wallet,
}));
vi.mock('viem/accounts', () => ({ privateKeyToAccount: h.account }));
import { main } from '@/scripts/license-set-uri.mjs';
const ID = 'h_4fa999236d92e95a76bb36dcd7446208';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const config = { NEXT_PUBLIC_LICENSE_NFT_POLYGON: CONTRACT, NEXT_PUBLIC_LICENSE_NFT_AMOY: CONTRACT };
beforeEach(() => {
  vi.resetAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {});
  h.public.mockReturnValue({ readContract: h.read, simulateContract: h.simulate, waitForTransactionReceipt: h.receipt });
  h.wallet.mockReturnValue({ writeContract: h.write }); h.account.mockReturnValue({ address: CONTRACT });
  h.read.mockImplementation(async ({ functionName }: { functionName: string }) => (functionName === 'owner' ? CONTRACT : 'https://seller.example/terms'));
  h.simulate.mockResolvedValue({ request: { address: CONTRACT } });
  h.write.mockResolvedValue('0xtransaction'); h.receipt.mockResolvedValue({ status: 'success' });
});
afterEach(() => vi.restoreAllMocks());
it('dry-run needs no key, prints matching tokenId/calldata, and never creates a wallet', async () => {
  await main(['--product', ID], config);
  const body = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
  expect(body).toMatchObject({ mode: 'dry-run', chain: 'polygon', contract: CONTRACT, tokenId: toHex(computeLicenseTokenId(ID), { size: 32 }), currentUri: 'https://seller.example/terms', newUri: 'https://open-pay.jp/api/license/metadata/' + ID });
  expect(decodeFunctionData({ abi: parseAbi(['function setURI(uint256 id,string tokenURI)']), data: body.calldata })).toEqual({ functionName: 'setURI', args: [computeLicenseTokenId(ID), body.newUri] });
  expect(h.account).not.toHaveBeenCalled(); expect(h.wallet).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
  expect(h.http).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\//));
});
it('only --send uses the env key and reports receipt without logging credentials', async () => {
  const secret = 'test-only-account-mock-sentinel';
  await main(['--product', ID, '--chain', 'amoy', '--send'], { ...config, LICENSE_OWNER_PRIVATE_KEY: secret, NEXT_PUBLIC_POLYGON_AMOY_RPC_URL: 'https://rpc.example' });
  expect(h.account).toHaveBeenCalledWith(secret); expect(h.http).toHaveBeenCalledWith('https://rpc.example');
  expect(h.write).toHaveBeenCalledWith({ address: CONTRACT });
  expect(console.log).toHaveBeenCalledWith('receipt status:', 'success');
  expect(JSON.stringify(vi.mocked(console.log).mock.calls).includes(secret)).toBe(false);
});
it('refuses to send when the key is not the contract owner (prints both addresses only)', async () => {
  h.account.mockReturnValue({ address: '0x1111111111111111111111111111111111111111' });
  await expect(main(['--product', ID, '--send'], { ...config, LICENSE_OWNER_PRIVATE_KEY: 'k' })).rejects.toThrow(/is for 0x1111.*owner is 0x3333/);
  expect(h.simulate).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
});
it('reverted receipt fails after reporting status', async () => {
  h.receipt.mockResolvedValue({ status: 'reverted' });
  await expect(main(['--product', ID, '--send'], config)).rejects.toThrow('transaction reverted');
});
it.each([{ args: ['--product', 'bad'] }, { args: ['--product', ID, '--chain', 'ethereum'] }, { args: ['--product', ID, '--unknown'] }])('rejects invalid args before RPC: $args', async ({ args }) => {
  await expect(main(args, config)).rejects.toThrow(); expect(h.public).not.toHaveBeenCalled();
});
