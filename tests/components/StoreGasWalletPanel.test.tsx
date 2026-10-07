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

function base(over: Record<string, unknown> = {}) {
  return {
    chain: { id: 80002, name: 'Polygon Amoy' },
    hydrated: true,
    wallet: null,
    balance: null,
    gasPrice: null,
    readFailed: false,
    busy: false,
    refresh: vi.fn(),
    create: vi.fn(() => ({ ok: true })),
    remove: vi.fn(),
    withdraw: vi.fn(async () => ({ ok: true, hash: `0x${'ab'.repeat(32)}` })),
    ...over,
  };
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
    expect((hold.state.create as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('保存できない端末では作れなかったと出す', () => {
    hold.state = base({ create: vi.fn(() => ({ ok: false, reason: 'storage_unavailable' })) });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'この端末にガス用ウォレットを作る' }));
    expect(screen.getByText(/保存できませんでした/)).toBeTruthy();
  });

  it('作成済み: アドレス・残高・残り回数・少ないときの注意', () => {
    hold.state = base({
      wallet: { address: ADDR },
      balance: 10n ** 16n, // 0.01 POL
      gasPrice: 30n * 10n ** 9n,
    });
    render(<StoreGasWalletPanel />);
    expect(screen.getByText(ADDR)).toBeTruthy();
    expect(screen.getAllByText('0.01 POL').length).toBeGreaterThan(0);
    expect(screen.getByText('あと約 2 回送れます')).toBeTruthy();
    expect(screen.getByText(/残高が少なくなっています/)).toBeTruthy();
  });

  it('残高を読めないときは 0 と見せず「読めませんでした」', () => {
    hold.state = base({ wallet: { address: ADDR }, readFailed: true });
    render(<StoreGasWalletPanel />);
    expect(screen.getByText('残高を読めませんでした')).toBeTruthy();
  });

  it('残りの POL を戻す: 確認してから送り、結果を出す', async () => {
    hold.state = base({ wallet: { address: ADDR }, balance: 10n ** 18n, gasPrice: 1n });
    render(<StoreGasWalletPanel />);
    fireEvent.change(screen.getByPlaceholderText('戻し先のアドレス (0x...)'), {
      target: { value: '0x1111111111111111111111111111111111111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: '戻す' }));
    expect(screen.getByText(/取り消せません/)).toBeTruthy();
    expect(hold.state.withdraw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(await screen.findByText('送りました。')).toBeTruthy();
    expect(hold.state.withdraw).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111');
  });

  it('戻せなかった理由を出す', async () => {
    hold.state = base({
      wallet: { address: ADDR },
      withdraw: vi.fn(async () => ({ ok: false, reason: 'insufficient' })),
    });
    render(<StoreGasWalletPanel />);
    fireEvent.change(screen.getByPlaceholderText('戻し先のアドレス (0x...)'), { target: { value: '0x1' } });
    fireEvent.click(screen.getByRole('button', { name: '戻す' }));
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(await screen.findByText('ガス代を払うと残りがありません。')).toBeTruthy();
  });

  it('消す: 残高があるときは先に戻すよう注意し、確認してから消す', () => {
    hold.state = base({ wallet: { address: ADDR }, balance: 10n ** 18n, gasPrice: 1n });
    render(<StoreGasWalletPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'この端末から消す' }));
    expect(screen.getByText(/まだ 1 POL 残っています/)).toBeTruthy();
    expect(hold.state.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    expect(hold.state.remove).toHaveBeenCalled();
  });
});
