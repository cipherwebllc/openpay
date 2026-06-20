// TipEmbedGenerator の chain chooser が flag ON (Avalanche enable + Fuji forwarder) で
// Avalanche チップを描画し、選択で URL に chain=avalanche が乗ることを実 component で実行する。
// RECEIVABLE_JPYC_CHAINS は module-load 時に確定するため、env を立ててから resetModules →
// 全モジュールを動的 import して flag を効かせる (fake data mock は使わない)。

import { describe, it, expect, afterEach, vi } from 'vitest';

const KEYS = [
  'NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE',
  'NEXT_PUBLIC_NETWORK_ENV',
  'NEXT_PUBLIC_JPYC_FORWARDER_FUJI',
] as const;
// Fuji forwarder (checksummed・viem isAddress の strict 検証を通す必要がある)。
const FUJI_FORWARDER = '0x0F4560a777415580F0680F8B56a79B0022C6B848';
const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// 外 RPC / wallet は boundary mock (対象ロジックではない)。既存 TipEmbedGenerator.test と同型。
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  for (const k of KEYS) delete process.env[k];
  vi.resetModules();
});

async function renderTip(envVars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, envVars);
  vi.resetModules();

  const rtl = await import('@testing-library/react');
  const { NextIntlClientProvider } = await import('next-intl');
  const messages = (await import('../../messages/ja.json')).default;
  const { TipEmbedGenerator } = await import('@/components/TipEmbedGenerator');
  const { chainForSlug } = await import('@/lib/chains');

  const avaxId = chainForSlug('avalanche').id; // testnet → Fuji (43113)
  // 描画は動的 import した fresh react-dom + fresh component なので hooks/context が同一
  // インスタンスで一貫する (dual-React = invalid hook call を回避)。JSX は記述子生成のみ。
  rtl.render(
    <NextIntlClientProvider locale="ja" messages={messages}>
      <TipEmbedGenerator />
    </NextIntlClientProvider>,
  );
  cleanupFn = rtl.cleanup;
  return { screen: rtl.screen, waitFor: rtl.waitFor, fireEvent: rtl.fireEvent, avaxId };
}

describe('TipEmbedGenerator — Avalanche chain chip (flag ON・実 component 描画パス)', () => {
  it('flag ON + Fuji forwarder: JPYC chain chooser に Avalanche チップが実描画される', async () => {
    const { screen, waitFor, avaxId } = await renderTip({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
      NEXT_PUBLIC_JPYC_FORWARDER_FUJI: FUJI_FORWARDER,
    });
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(
      screen.getByRole('button', { name: new RegExp(`id:\\s*${avaxId}\\b`) }),
    ).toBeInTheDocument();
  });

  it('Avalanche チップを選択 → URL に chain=avalanche が乗る (実 buildTipUrl)', async () => {
    const { screen, waitFor, fireEvent, avaxId } = await renderTip({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
      NEXT_PUBLIC_JPYC_FORWARDER_FUJI: FUJI_FORWARDER,
    });
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    fireEvent.change(screen.getByPlaceholderText(/0x\.\.\./), {
      target: { value: VALID },
    });
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`id:\\s*${avaxId}\\b`) }),
    );
    await waitFor(() => {
      expect(screen.getAllByText(/chain=avalanche/).length).toBeGreaterThan(0);
    });
  });

  it('flag OFF (enable 無し): Avalanche チップは出ない (非空虚の対照)', async () => {
    // enable flag を立てない → JPYC_CHAINS に avalanche が入らず chooser に現れない。
    // (同一描画経路で flag だけ差し替え → チップの有無が flag に因ることを実証)
    const { screen, waitFor, avaxId } = await renderTip({
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
    });
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(
      screen.queryByRole('button', { name: new RegExp(`id:\\s*${avaxId}\\b`) }),
    ).toBeNull();
  });
});
