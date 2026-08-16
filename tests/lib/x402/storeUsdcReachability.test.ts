import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBytecode: vi.fn(),
  createPublicClient: vi.fn(),
  transportForChain: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: mocks.createPublicClient };
});
vi.mock('@/lib/chains', () => ({
  transportForChain: mocks.transportForChain,
}));

import { checkStoreUsdcPayToReachability } from '@/lib/x402/storeUsdcReachability';

const PAY_TO = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createPublicClient.mockReturnValue({ getBytecode: mocks.getBytecode });
  mocks.transportForChain.mockReturnValue('polygon-transport');
  mocks.getBytecode.mockResolvedValue(undefined);
});

describe('Store USDC payTo reachability', () => {
  it.each([undefined, '0x'])('Polygon code=%s の EOA は許可', async (code) => {
    mocks.getBytecode.mockResolvedValue(code);
    await expect(checkStoreUsdcPayToReachability(PAY_TO)).resolves.toMatchObject({
      ok: true,
    });
    expect(mocks.transportForChain).toHaveBeenCalledWith(137);
    expect(mocks.getBytecode).toHaveBeenCalledWith({ address: PAY_TO });
  });

  it('Polygon contract wallet はブロックする', async () => {
    mocks.getBytecode.mockResolvedValue('0x6000');
    await expect(checkStoreUsdcPayToReachability(PAY_TO)).resolves.toEqual({
      ok: false,
      reason: 'contract_wallet',
    });
  });

  it('RPC 障害は EOA に倒さず fail-closed', async () => {
    mocks.getBytecode.mockRejectedValue(new Error('rpc down'));
    await expect(checkStoreUsdcPayToReachability(PAY_TO)).resolves.toEqual({
      ok: false,
      reason: 'rpc_unavailable',
    });
  });
});
