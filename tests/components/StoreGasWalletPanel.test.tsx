import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

const hold = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));
vi.mock('@/hooks/useStoreGasWallet', () => ({
  useStoreGasWallet: () => hold.state,
}));

import { StoreGasWalletPanel } from '@/components/StoreGasWalletPanel';

const ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TX = `0x${'ab'.repeat(32)}`;

function base(over: Record<string, unknown> = {}) {
  return {
    chain: { id: 80002, name: 'Polygon Amoy' },
    hydrated: true,
    walletState: { state: 'none' },
    address: null,
    balance: null,
    gasPrice: null,
    readFailed: false,
    withdrawStatus: { phase: 'idle' },
    removeBlocked: false,
    refresh: vi.fn(),
    create: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => true),
    withdraw: vi.fn(async () => ({ phase: 'confirmed', hash: TX })),
    ...over,
  };
}

function ready(over: Record<string, unknown> = {}) {
  return base({ walletState: { state: 'ok', info: { address: ADDR, createdAt: 1 } }, address: ADDR, ...over });
}

describe('StoreGasWalletPanel', () => {
  beforeEach(() => {
    hold.state = base();
  });

  it('未作成: 説明と注意 (鍵は端末だけ・少額・JPYC を入れない) と作成ボタン', () => {
    render(<StoreGasWalletPanel />);
    expect(screen.getByText('お店の端末のガス用ウォレット')).toBeTruthy();
    expect(screen.getByText(/OpenPay は預かりません/)).toBeTruthy();
    expect(screen.getByText(/JPYC は入れないでください/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'この端末にガス用ウォレットを作る' }));
    expect(hold.state.create).toHaveBeenCalled();
  });

  it('読み込む前は「無い」と知らせない (タブを戻ったときに送信中の支払いを消さない)・読み込んだら知らせる', () => {
    const onAddressChange = vi.fn();
    hold.state = base({ hydrated: false, walletState: null });
    const r = render(<StoreGasWalletPanel onAddressChange={onAddressChange} />);
    expect(onAddressChange).not.toHaveBeenCalled();
    hold.state = ready();
    r.rerender(<StoreGasWalletPanel onAddressChange={onAddressChange} />);
    expect(onAddressChange).toHaveBeenCalledTimes(1);
    expect(onAddressChange).toHaveBeenLastCalledWith(ADDR);
  });

  it('使えるガス用ウォレットのアドレスを知らせる (無いときは null)・切替は出さない (決済QRタブの決済モードで選ぶ)', () => {
    const onAddressChange = vi.fn();
    const { unmount } = render(<StoreGasWalletPanel onAddressChange={onAddressChange} />);
    expect(onAddressChange).toHaveBeenLastCalledWith(null);
    unmount();
    hold.state = ready();
    render(<StoreGasWalletPanel onAddressChange={onAddressChange} />);
    expect(onAddressChange).toHaveBeenLastCalledWith(ADDR);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('保存できない端末では作れなかったと出す', async () => {
    hold.state = base({ create: vi.fn(async () => ({ ok: false, reason: 'storage_unavailable' })) });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'この端末にガス用ウォレットを作る' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/保存できませんでした/);
  });

  it('保存データが壊れているときは作るボタンを出さず、上書きしない旨を出す', () => {
    hold.state = base({ walletState: { state: 'corrupt' } });
    render(<StoreGasWalletPanel />);
    expect(screen.queryByRole('button', { name: 'この端末にガス用ウォレットを作る' })).toBeNull();
    expect(screen.getByText(/上書きを防ぐため、新しく作れません/)).toBeTruthy();
  });

  it('作成済み: アドレス・残高・残り回数・少ないときの注意', () => {
    hold.state = ready({ balance: 10n ** 16n, gasPrice: 30n * 10n ** 9n });
    render(<StoreGasWalletPanel />);
    expect(screen.getByText(ADDR)).toBeTruthy();
    expect(screen.getAllByText('0.01 POL').length).toBeGreaterThan(0);
    expect(screen.getByText('あと約 1 回送れます')).toBeTruthy();
    expect(screen.getByText(/残高が少なくなっています/)).toBeTruthy();
  });

  it('残高を読めないときは 0 と見せず「読めませんでした」', () => {
    hold.state = ready({ readFailed: true });
    render(<StoreGasWalletPanel />);
    expect(screen.getByText('残高を読めませんでした')).toBeTruthy();
  });

  it('戻し先の欄は見出しで名前が付き、確認してから送る', () => {
    hold.state = ready({ balance: 10n ** 18n, gasPrice: 1n });
    render(<StoreGasWalletPanel />);
    const input = screen.getByRole('textbox', { name: '残りの POL を戻す' });
    fireEvent.change(input, { target: { value: '0x1111111111111111111111111111111111111111' } });
    fireEvent.click(screen.getByRole('button', { name: '戻す' }));
    expect(screen.getByText(/少額が残ることがあります/)).toBeTruthy();
    expect(hold.state.withdraw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(hold.state.withdraw).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111');
  });

  it('結果は読み上げ領域に出す: 確定・確定待ち・不明・取り消し・拒否', () => {
    const cases: [Record<string, unknown>, RegExp, 'status' | 'alert'][] = [
      [{ phase: 'confirmed', hash: TX }, /戻しました/, 'status'],
      [{ phase: 'pending', hash: TX }, /確定を待っています/, 'status'],
      [{ phase: 'unknown', hash: TX }, /確かめられませんでした/, 'alert'],
      [{ phase: 'reverted', hash: TX }, /失敗しました/, 'alert'],
      [{ phase: 'rejected', reason: 'contract_recipient' }, /コントラクトのアドレスには戻せません/, 'alert'],
    ];
    for (const [status, text, role] of cases) {
      hold.state = ready({ withdrawStatus: status });
      const { unmount } = render(<StoreGasWalletPanel />);
      expect(screen.getByRole(role)).toHaveTextContent(text);
      unmount();
    }
  });

  it('確定待ちの間は消せない', () => {
    hold.state = ready({ withdrawStatus: { phase: 'pending', hash: TX }, removeBlocked: true });
    render(<StoreGasWalletPanel />);
    expect(screen.getByRole('button', { name: 'この端末から消す' })).toBeDisabled();
    expect(screen.getByText(/確定を待っている間は消せません/)).toBeTruthy();
  });

  it('消す: 残高があるときは先に戻すよう注意し、確認してから消す・消せなければそう出す', async () => {
    hold.state = ready({ balance: 10n ** 18n, gasPrice: 1n, remove: vi.fn(async () => false) });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'この端末から消す' }));
    expect(screen.getByText(/まだ 1 POL 残っています/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    expect(hold.state.remove).toHaveBeenCalled();
    expect(await screen.findByText('この端末から消せませんでした。もう一度お試しください。')).toBeTruthy();
  });
});
