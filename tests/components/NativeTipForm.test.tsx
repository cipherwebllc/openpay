import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseEther, getAddress } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import { chainForSlug } from '@/lib/chains';
import type { NativeTipParams } from '@/lib/url';

// wagmi の native 送金境界を hoisted ホルダで mock し、各 test で状態を差し替える。
// ConnectButton は jsdom で重い wagmi graph を描画し OOM を招くため stub する
// (memory:paymentform-oom-rootcause)。
const h = vi.hoisted(() => ({
  account: {
    address: undefined as `0x${string}` | undefined,
    isConnected: false,
    chainId: undefined as number | undefined,
  },
  balance: { data: undefined as { value: bigint } | undefined },
  send: {
    sendTransaction: vi.fn(),
    data: undefined as `0x${string}` | undefined,
    isPending: false,
    error: null as Error | null,
  },
  receipt: {
    data: undefined as { status: 'success' | 'reverted' } | undefined,
    isLoading: false,
    isSuccess: false,
  },
  switchChain: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => h.balance,
  useSendTransaction: () => h.send,
  useWaitForTransactionReceipt: () => h.receipt,
  useSwitchChain: () => ({ switchChain: h.switchChain, isPending: false }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <div data-testid="connect-button" />,
}));

import { NativeTipForm } from '@/components/NativeTipForm';

const TO = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const POLYGON = chainForSlug('polygon');
const SYMBOL = POLYGON.nativeCurrency.symbol;

function render(overrides: Partial<NativeTipParams> = {}) {
  return renderWithIntl(
    <NativeTipForm params={{ to: TO, chain: 'polygon', ...overrides }} />,
    { locale: 'ja' },
  );
}

beforeEach(() => {
  h.account = { address: undefined, isConnected: false, chainId: undefined };
  h.balance = { data: undefined };
  h.send = {
    sendTransaction: vi.fn(),
    data: undefined,
    isPending: false,
    error: null,
  };
  h.receipt = { data: undefined, isLoading: false, isSuccess: false };
  h.switchChain = vi.fn();
});

describe('NativeTipForm', () => {
  it('チェーン名とネイティブ記号を表示', () => {
    render();
    expect(screen.getByText(`${POLYGON.name} · ${SYMBOL}`)).toBeInTheDocument();
  });

  it('未接続 → 接続ボタン文言', () => {
    render();
    expect(
      screen.getByRole('button', { name: 'ウォレットを接続' }),
    ).toBeInTheDocument();
  });

  it('接続済・別チェーン → チェーン切替を促す', () => {
    h.account = { address: TO, isConnected: true, chainId: 1 }; // mainnet ETH 等
    render();
    // インライン切替ボタン「{chainName} に切り替える」(送信ボタン「チェーンを切り替える」とは別)。
    expect(
      screen.getByRole('button', { name: /に切り替える/ }),
    ).toBeInTheDocument();
  });

  it('接続済・正チェーン → 既定プリセット額で送るボタン', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    render();
    expect(screen.getByRole('button', { name: /を送る/ })).toBeInTheDocument();
  });

  it('残高不足 → 注記 + 送るボタン無効', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: 0n } }; // 既定プリセット 1 POL に満たない
    render();
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: /を送る/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('送るボタン押下で sendTransaction を {to,value,chainId} で呼ぶ', async () => {
    const user = userEvent.setup();
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    render();
    await user.click(screen.getByRole('button', { name: /を送る/ }));
    expect(h.send.sendTransaction).toHaveBeenCalledOnce();
    expect(h.send.sendTransaction).toHaveBeenCalledWith({
      to: TO,
      value: parseEther('1'), // polygon 既定プリセット先頭 = '1'
      chainId: POLYGON.id,
    });
  });

  it('送信中 (txHash 取得・未確定) → 確定待ち表示 + 再送不可', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    h.send = { ...h.send, data: `0x${'a'.repeat(64)}` };
    h.receipt = { data: undefined, isLoading: true, isSuccess: false };
    render();
    const btn = screen.getByRole('button', { name: /確定待ち/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('確定 → 成功パネル + tx + エクスプローラリンク', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    h.send = { ...h.send, data: `0x${'a'.repeat(64)}` };
    h.receipt = { data: { status: 'success' }, isLoading: false, isSuccess: true };
    render();
    expect(screen.getByText(/応援ありがとう/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /エクスプローラ/ }),
    ).toBeInTheDocument();
  });

  it('revert → エラー文言を表示 + 再送ボタンは有効 (リロードせず再試行可)', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    h.send = { ...h.send, data: `0x${'a'.repeat(64)}` };
    h.receipt = { data: { status: 'reverted' }, isLoading: false, isSuccess: false };
    render();
    expect(screen.getByText(/ネットワーク上で失敗/)).toBeInTheDocument();
    // revert 後は txHash が残っても再送を許す (二重チップは success 時のみ防ぐ)。
    expect(
      (screen.getByRole('button', { name: /を送る/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
