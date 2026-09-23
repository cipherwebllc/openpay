import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient, WalletClient } from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import { buildBurnIntent } from '@/lib/crossChain/gateway';
import { executeGatewayTransfer } from '@/lib/crossChain/execute';
import { GATEWAY_WALLET_ADDRESS } from '@/lib/crossChain/config';
import { __resetContractDeployedCacheForTest } from '@/lib/crossChain/deploycheck';
import { CIRCLE_DOMAIN_BASE, CIRCLE_DOMAIN_POLYGON } from '@/lib/crossChain/types';

const account = '0x1111111111111111111111111111111111111111' as const;
const recipient = '0x2222222222222222222222222222222222222222' as const;
const burnArgs = {
  sourceDomain: CIRCLE_DOMAIN_BASE,
  destinationDomain: CIRCLE_DOMAIN_POLYGON,
  sourceToken: account,
  destinationToken: recipient,
  depositor: account,
  recipient,
  value: 1_000_000n,
  currentBlockHeight: 1000n,
  withdrawalDelay: 302_400n,
};

function fixture(sourceChainId = 84532) {
  let chainId = sourceChainId;
  const source = {
    readContract: vi.fn().mockResolvedValue(302_400n),
    getBlockNumber: vi.fn().mockResolvedValue(1000n),
    request: vi.fn().mockResolvedValue({ number: '0x17d78400', l1BlockNumber: '0x1312d00' }),
    getCode: vi.fn().mockResolvedValue('0x6000'),
  };
  const dest = {
    readContract: vi.fn().mockRejectedValue(new Error('must read source')),
    getBlockNumber: vi.fn().mockResolvedValue(9_000_000n),
    getCode: vi.fn().mockResolvedValue('0x6000'),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
  };
  const wallet = {
    getChainId: vi.fn(async () => chainId),
    signTypedData: vi.fn().mockResolvedValue('0x1234'),
    sendTransaction: vi.fn().mockResolvedValue('0xabcd'),
  };
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ attestation: '0x1234', signature: '0x5678' })));
  return { source, dest, wallet, fetch, args: {
    sourcePublicClient: source as unknown as PublicClient,
    destPublicClient: dest as unknown as PublicClient,
    walletClient: wallet as unknown as WalletClient,
    switchChainAsync: vi.fn(async (args: { chainId: number }) => { chainId = args.chainId; }),
    account, recipient, sourceChainId, destChainId: 80002,
    sourceDomain: CIRCLE_DOMAIN_BASE, destDomain: CIRCLE_DOMAIN_POLYGON,
    sourceToken: account, destToken: recipient, valueAtomic: 1_000_000n, fetch,
  } };
}

beforeEach(() => { __resetContractDeployedCacheForTest(); });
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('X13 Gateway burn-intent expiry', () => {
  it.each([302_400n, 403_200n, 50_400n, 545_000n, 7n])('uses live withdrawalDelay=%s plus a rounded-up 10%% margin', async (delay) => {
    const f = fixture();
    f.source.readContract.mockResolvedValue(delay);
    await executeGatewayTransfer(f.args);
    expect(f.wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ maxBlockHeight: 1000n + delay + (delay + 9n) / 10n }),
    }));
    expect(f.source.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: GATEWAY_WALLET_ADDRESS, functionName: 'withdrawalDelay',
    }));
    expect(f.dest.readContract).not.toHaveBeenCalled();
    expect(f.dest.getBlockNumber).not.toHaveBeenCalled();
  });

  it.each([-1n, 0n, 600n, 302_400n, 332_639n, 400_000n])('clamps per-call offset %s to delay plus margin', (offset) => {
    const intent = buildBurnIntent({ ...burnArgs, overrides: { maxBlockHeightOffset: offset } });
    expect(intent.maxBlockHeight).toBe(1000n + (offset > 332_640n ? offset : 332_640n));
  });

  it.each(['600', '302400', '400000'])('clamps environment offset %s to delay plus margin', async (offset) => {
    vi.stubEnv('NEXT_PUBLIC_CROSS_CHAIN_BLOCK_OFFSET_DEFAULT', offset);
    vi.resetModules();
    const gateway = await import('@/lib/crossChain/gateway');
    expect(gateway.buildBurnIntent(burnArgs).maxBlockHeight)
      .toBe(1000n + (BigInt(offset) > 332_640n ? BigInt(offset) : 332_640n));
    expect(gateway.buildBurnIntent({ ...burnArgs, overrides: { maxBlockHeightOffset: 1n } }).maxBlockHeight)
      .toBe(333_640n);
  });

  it.each(['1e300', (1n << 255n).toString(), (1n << 256n).toString()])('ignores oversized environment offset %s', async (offset) => {
    vi.stubEnv('NEXT_PUBLIC_CROSS_CHAIN_BLOCK_OFFSET_DEFAULT', offset);
    vi.resetModules();
    const gateway = await import('@/lib/crossChain/gateway');
    expect(gateway.buildBurnIntent(burnArgs).maxBlockHeight).toBe(333_640n);
  });

  it('withdrawalDelay read failure stops before signing, attestation, or mint', async () => {
    const f = fixture();
    f.source.readContract.mockRejectedValue(new Error('withdrawalDelay unavailable'));
    await expect(executeGatewayTransfer(f.args)).rejects.toThrow('withdrawalDelay unavailable');
    expect(f.wallet.signTypedData).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('clamps a low execution override in the signed and submitted intent', async () => {
    const f = fixture();
    await executeGatewayTransfer({ ...f.args, overrides: { maxBlockHeightOffset: 600n } });
    expect(f.wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ maxBlockHeight: 333_640n }),
    }));
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)[0].burnIntent.maxBlockHeight).toBe('333640');
  });

  it('refreshes head and withdrawalDelay before the fee signature', async () => {
    const f = fixture();
    f.source.readContract.mockResolvedValueOnce(302_400n).mockResolvedValueOnce(403_200n);
    f.source.getBlockNumber.mockResolvedValueOnce(1000n).mockResolvedValueOnce(2000n);
    await executeGatewayTransfer({ ...f.args, feeReceiver: account, feeAmount: 1000n });
    expect(f.wallet.signTypedData.mock.calls.map(([arg]) => arg.message.maxBlockHeight))
      .toEqual([333_640n, 445_520n]);
  });

  it.each([arbitrum.id, arbitrumSepolia.id])('Arbitrum %s uses the source RPC L1 height, never its L2 height', async (chainId) => {
    const f = fixture(chainId);
    f.source.readContract.mockResolvedValue(50_400n);
    await executeGatewayTransfer({ ...f.args, sourceDomain: 3 });
    expect(f.source.request).toHaveBeenCalledWith({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    expect(f.source.getBlockNumber).not.toHaveBeenCalled();
    expect(f.wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ maxBlockHeight: 20_000_000n + 50_400n + 5040n }),
    }));
  });

  it.each([undefined, null, '20000000', '0x', '0xzz', 20_000_000])('Arbitrum rejects missing/malformed L1 height %s before signing', async (l1BlockNumber) => {
    const f = fixture(arbitrum.id);
    f.source.request.mockResolvedValue({ number: '0x17d78400', l1BlockNumber });
    await expect(executeGatewayTransfer({ ...f.args, sourceDomain: 3 })).rejects.toThrow('L1 block number');
    expect(f.wallet.signTypedData).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.source.getBlockNumber).not.toHaveBeenCalled();
  });

  it('Arbitrum RPC failure stops before signing without falling back to L2', async () => {
    const f = fixture(arbitrum.id);
    f.source.request.mockRejectedValue(new Error('Arbitrum RPC unavailable'));
    await expect(executeGatewayTransfer({ ...f.args, sourceDomain: 3 })).rejects.toThrow('Arbitrum RPC unavailable');
    expect(f.wallet.signTypedData).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.source.getBlockNumber).not.toHaveBeenCalled();
  });
});
