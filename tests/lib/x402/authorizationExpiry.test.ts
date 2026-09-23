// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getAddress, toHex } from 'viem';
import { authorizationExpiredUnused } from '@/lib/x402/authorizationExpiry';

const TOKEN = getAddress('0x1111111111111111111111111111111111111111');
const PAYER = getAddress('0x2222222222222222222222222222222222222222');
const NONCE = toHex(1n, { size: 32 });
const HASH = toHex(2n, { size: 32 });
const FINALIZED = { number: 500n, hash: HASH, timestamp: 1001n };

function fixture() {
  const client = {
    getBlock: vi.fn().mockResolvedValue(FINALIZED),
    readContract: vi.fn().mockResolvedValue(false),
    getTransactionReceipt: vi.fn(),
  };
  const prove = () => authorizationExpiredUnused({ client, token: TOKEN, payer: PAYER, nonce: NONCE, validBefore: 1000n });
  return { client, prove };
}

describe('finalized authorization expiry canonical observation', () => {
  it('works with numbered eth_call and rechecks the hash after reading state', async () => {
    const { client, prove } = fixture();
    client.readContract.mockImplementation(async (args) => {
      if ('blockHash' in args || 'requireCanonical' in args) throw new Error('EIP-1898 unsupported');
      expect(args).toMatchObject({ address: TOKEN, args: [PAYER, NONCE], blockNumber: 500n });
      expect(client.getBlock).toHaveBeenCalledTimes(1);
      return false;
    });
    expect(await prove()).toBe(true);
    expect(client.getBlock.mock.calls).toEqual([[{ blockTag: 'finalized' }], [{ blockNumber: 500n }]]);
  });

  it.each(['different-hash', 'missing-hash', 'unreadable-block', 'rpc-error'] as const)('rejects %s on the canonical reread after an unused state response', async (scenario) => {
    const { client, prove } = fixture();
    client.readContract.mockImplementation(async () => {
      // Change the response during the state read: the hash check must follow it.
      if (scenario === 'rpc-error') client.getBlock.mockRejectedValue(new Error('canonical lookup unavailable'));
      else client.getBlock.mockResolvedValue(scenario === 'unreadable-block' ? null
        : scenario === 'missing-hash' ? { number: 500n }
          : { ...FINALIZED, hash: toHex(3n, { size: 32 }) });
      return false;
    });
    expect(await prove()).toBe(false);
    expect(client.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 500n });
  });
});
