import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';

// 決済QR タブ × 「お店がガス代を肩代わりして送る」(内部名「お店の端末で送る」・flag ON)。作成ページで 1 つの
// お店の端末の状態を見て、送っている・結果を待っている間は通常の QR を出さない。
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
  useReadContract: vi.fn(() => ({ data: undefined })),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableStoreGasWallet: true } };
});
const device = vi.hoisted(() => ({
  busy: false,
  releaseForNormal: vi.fn(async () => true),
}));
vi.mock('@/components/StoreDeviceProvider', () => ({
  useStoreDeviceMode: () => ({ device: { busy: device.busy, releaseForNormal: device.releaseForNormal } }),
}));

import { QrGenerator } from '@/components/QrGenerator';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function ready(user: ReturnType<typeof userEvent.setup>) {
  render(<QrGenerator />);
  await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
  await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
  await user.type(screen.getByPlaceholderText('1000'), '500');
  return (await screen.findAllByRole('button', { name: /QRコードを表示する/ }))[0];
}

describe('QrGenerator × お店の端末で送る (flag ON)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    device.busy = false;
    device.releaseForNormal.mockReset().mockResolvedValue(true);
  });

  it('お店の端末が送っている・結果を待っている間は、通常の QR を開かない', async () => {
    const user = userEvent.setup();
    device.busy = true;
    const btn = await ready(user);
    await user.click(btn);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(device.releaseForNormal).not.toHaveBeenCalled();
  });

  it('締め切っていない受け渡しに署名が入っていた (端末が送る) → 通常の QR を開かない', async () => {
    const user = userEvent.setup();
    device.releaseForNormal.mockResolvedValue(false);
    const btn = await ready(user);
    await user.click(btn);
    await waitFor(() => expect(device.releaseForNormal).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('受け渡しを締め切れたら (または無ければ) 通常の QR を開く', async () => {
    const user = userEvent.setup();
    const btn = await ready(user);
    await user.click(btn);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(device.releaseForNormal).toHaveBeenCalledTimes(1);
  });
});
