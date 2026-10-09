// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getAddress, toHex } from 'viem';
import { authorizationExpiredUnused, observeAuthorizationExpiry } from '@/lib/x402/authorizationExpiry';

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

// relay status (第 7 回レビュー A6 再レビュー): 期限切れ未使用の「証明」を tri-state で返す。手順は
// authorizationExpiredUnused と同じ (finalized → その番号に固定した authorizationState → canonical hash の再確認)。
describe('observeAuthorizationExpiry (tri-state proof for relay status)', () => {
  function observe(client: ReturnType<typeof fixture>['client'], validBefore = 1000n) {
    return observeAuthorizationExpiry({ client, token: TOKEN, payer: PAYER, nonce: NONCE, validBefore });
  }

  it('finalized の時刻が期限を過ぎ、その番号の state が unused で hash が同じなら expired', async () => {
    const { client } = fixture();
    expect(await observe(client)).toBe('expired');
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: TOKEN, args: [PAYER, NONCE], blockNumber: 500n }));
    expect(client.getBlock.mock.calls).toEqual([[{ blockTag: 'finalized' }], [{ blockNumber: 500n }]]);
  });

  it.each([
    ['timestamp == validBefore', 1001n],
    ['timestamp < validBefore', 1500n],
  ])('finalized の時刻がまだ期限前 (%s) は live で、state は読まない', async (_label, validBefore) => {
    const { client } = fixture();
    expect(await observe(client, validBefore)).toBe('live');
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it('state を読んだ後に canonical hash が変わっていたら unknown (証明しない)', async () => {
    const { client } = fixture();
    client.readContract.mockImplementation(async () => {
      client.getBlock.mockResolvedValue({ ...FINALIZED, hash: toHex(3n, { size: 32 }) });
      return false;
    });
    expect(await observe(client)).toBe('unknown');
    expect(client.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 500n });
  });

  it('finalized の番号で used=true なら unknown (期限切れ未使用の証明にならない)', async () => {
    const { client } = fixture();
    client.readContract.mockResolvedValue(true);
    expect(await observe(client)).toBe('unknown');
  });

  it.each([
    ['number なし', { hash: HASH, timestamp: 1001n }],
    ['hash なし', { number: 500n, timestamp: 1001n }],
    ['timestamp なし', { number: 500n, hash: HASH }],
  ])('finalized ブロックが揃わない (%s) なら unknown', async (_label, block) => {
    const { client } = fixture();
    client.getBlock.mockResolvedValue(block);
    expect(await observe(client)).toBe('unknown');
  });

  it('RPC 障害は unknown (throw しない)', async () => {
    const { client } = fixture();
    client.getBlock.mockRejectedValue(new Error('finality unavailable'));
    expect(await observe(client)).toBe('unknown');
  });
});
