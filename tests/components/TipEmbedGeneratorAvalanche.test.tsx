// TipEmbedGenerator の chain chooser が flag ON (Avalanche enable + Fuji forwarder) で
// 「Avalanche チップを実際に描画」し、選択すると URL に chain=avalanche が乗ることを、
// 実 component + 実 chains/tokens (fake data mock 無し) で実行する。
//
// なぜ別ファイル + resetModules か:
//   RECEIVABLE_JPYC_CHAINS = JPYC_CHAINS.filter(isGaslessSupported) は TipEmbedGenerator の
//   module-load 時に確定する。よって env を立ててから resetModules → React/RTL/intl/component
//   を「すべて動的 import」して同一モジュールグラフで取り直す (dual-React を回避)。env は
//   afterEach で削除し他ファイルへ漏らさない。
// 既存 TipEmbedGenerator.test (flag OFF) の「Polygon / Kaia 2 ボタン」と対照で、flag OFF だと
// Avalanche チップが出ないこと (= 本テストが非空虚であること) も同ファイルで実証する。

import { describe, it, expect, afterEach, vi } from 'vitest';

const KEYS = [
  'NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE',
  'NEXT_PUBLIC_NETWORK_ENV',
  'NEXT_PUBLIC_JPYC_FORWARDER_FUJI',
] as const;
// 有効な checksummed アドレス (jpycAvalanche.test と同一)。configuredJpycForwarderFor は
// viem isAddress (strict checksum) で検証するため checksum が正しい必要がある。
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

// env を立て resetModules → 全モジュールを動的 import し実 component を描画する。
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
  // JSX (静的 jsx-runtime) は要素記述子を作るだけ。描画は「動的 import した fresh
  // react-dom (rtl.render)」が行い、component も fresh なので hooks/context は同一
  // インスタンスで一貫する (dual-React = invalid hook call を回避)。
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
    // RECEIVABLE_JPYC_CHAINS に avalanche が入り、chooser が chain id ボタンを描画する。
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
