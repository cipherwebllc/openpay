// 「接続中のウォレットから補充」: お店のウォレット (wagmi) から、ガス用ウォレットへガス代のトークンを送る。
// 二重に送らない・届く途中の宛先を消さない・取り消しを「補充しました」と言わない、を確かめる。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Address } from 'viem';
import { renderWithIntl as render } from '../_helpers/i18n';

type Receipt = {
  data: { status: 'success' | 'reverted'; transactionHash: string } | undefined;
  isError: boolean;
  refetch: () => Promise<unknown>;
};
const w = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined },
  balance: undefined as { value: bigint } | undefined,
  sendAsync: vi.fn(),
  switchChain: vi.fn(),
  receipt: { data: undefined, isError: false, refetch: vi.fn() } as unknown as Receipt,
  receiptArgs: [] as { hash?: string; chainId?: number; onReplaced?: (r: { reason: string }) => void }[],
}));
vi.mock('wagmi', () => ({
  useAccount: () => w.account,
  useBalance: () => ({ data: w.balance }),
  useSwitchChain: () => ({ switchChain: w.switchChain, isPending: false }),
  useSendTransaction: () => ({ sendTransactionAsync: w.sendAsync }),
  useWaitForTransactionReceipt: (args: (typeof w.receiptArgs)[number]) => {
    w.receiptArgs.push(args);
    return args.hash ? w.receipt : { data: undefined, isError: false, refetch: vi.fn() };
  },
}));

import { StoreGasWalletTopUp } from '@/components/StoreGasWalletTopUp';
import { createStoreGasWallet, hasPendingStoreGasTopUp, loadStoreGasWallet } from '@/lib/storeGasWallet';

const SHOP = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TX = `0x${'ab'.repeat(32)}`;
const TX2 = `0x${'cd'.repeat(32)}`;
const chainState = (id: number, name: string) => ({
  chainId: id,
  chain: { id, name } as never,
  active: true,
  balance: 0n,
  gasPrice: 1n,
  readFailed: false,
});
const AMOY = chainState(80002, 'Polygon Amoy');
const FUJI = chainState(43113, 'Avalanche Fuji');

let gas: Address;
function show(chains = [AMOY], extra: { onDone?: () => void; onPendingChange?: (p: boolean) => void } = {}) {
  const props = { onDone: vi.fn(), onPendingChange: vi.fn(), ...extra };
  const ui = () => <StoreGasWalletTopUp chains={chains} gasAddress={gas} {...props} />;
  const r = render(ui());
  return { ...props, rerender: () => r.rerender(ui()) };
}
const sendButton = () => screen.getByRole('button', { name: /を送る/ });

describe('StoreGasWalletTopUp', () => {
  beforeEach(() => {
    window.localStorage.clear();
    createStoreGasWallet();
    const s = loadStoreGasWallet();
    if (s.state !== 'ok') throw new Error('setup');
    gas = s.info.address;
    w.account = { address: SHOP, isConnected: true, chainId: 80002 };
    w.balance = { value: 10n ** 19n };
    w.sendAsync.mockReset().mockResolvedValue(TX);
    w.switchChain.mockReset();
    w.receipt = { data: undefined, isError: false, refetch: vi.fn(async () => undefined) };
    w.receiptArgs = [];
  });

  it('未接続なら、右上で接続するよう案内するだけ (送る欄は出さない)', () => {
    w.account = { address: undefined, isConnected: false, chainId: undefined };
    show();
    expect(screen.getByText(/右上の「接続」でお店のウォレットをつなぐと/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /を送る/ })).toBeNull();
  });

  it('既定額は目安の下限・保存されている鍵と同じ宛先へ、そのチェーンで送る・送る前に途中の印を置く', async () => {
    let markedDuringApproval = false;
    w.sendAsync.mockImplementation(async () => {
      markedDuringApproval = hasPendingStoreGasTopUp(gas);
      return TX;
    });
    show();
    expect(screen.getByRole('textbox', { name: '送る額 (POL)' })).toHaveValue('1');
    expect(screen.getByText(/目安 1〜2 POL・1 回 2 POL まで/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1 POL を送る' }));
    });
    expect(w.sendAsync).toHaveBeenCalledWith({ to: gas, value: 10n ** 18n, chainId: 80002 });
    expect(markedDuringApproval).toBe(true);
  });

  it('別のタブで鍵が作り直されていたら送らない (古いアドレスへ送らない)', async () => {
    show();
    window.localStorage.clear();
    createStoreGasWallet(); // 別のアドレス
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(w.sendAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('ガス用ウォレットが変わりました');
  });

  it('ウォレットで確認中・結果待ちの間は、次の送信・額・チェーンを変えさせない (途中を知らせる)', async () => {
    let approve!: (h: string) => void;
    w.sendAsync.mockImplementation(() => new Promise((r) => { approve = r; }));
    w.account = { address: SHOP, isConnected: true, chainId: 80002 };
    const v = show([AMOY, FUJI]);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(screen.getByRole('status')).toHaveTextContent('ウォレットで確認してください');
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '送る額 (POL)' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '補充するチェーン' })).toBeDisabled();
    expect(v.onPendingChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      approve(TX);
    });
    expect(screen.getByRole('status')).toHaveTextContent('送っています。確定を待っています');
    expect(sendButton()).toBeDisabled();
    expect(w.receiptArgs.at(-1)).toMatchObject({ hash: TX, chainId: 80002 });
  });

  it('確定したら印を外し、残高を 1 回だけ読み直し、結果と tx へのリンクを出す', async () => {
    const v = show();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    w.receipt = { ...w.receipt, data: { status: 'success', transactionHash: TX } };
    await act(async () => {
      v.rerender();
    });
    v.rerender();
    expect(v.onDone).toHaveBeenCalledTimes(1);
    expect(hasPendingStoreGasTopUp(gas)).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('補充しました。');
    expect(screen.getByRole('link', { name: '取引を見る' }).getAttribute('href')).toContain(TX);
    expect(v.onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it('ウォレットで取り消された・別の取引に置き換えられたら「補充しました」と言わない', async () => {
    for (const [reason, text] of [
      ['cancelled', 'ウォレットで取り消されました。補充されていません。'],
      ['replaced', 'ウォレットで別の取引に置き換えられました。補充されていません。'],
    ] as const) {
      window.localStorage.removeItem('openpay:store-gas-wallet:topup:v1');
      w.receipt = { data: undefined, isError: false, refetch: vi.fn() };
      const v = show();
      await act(async () => {
        fireEvent.click(sendButton());
      });
      act(() => {
        w.receiptArgs.at(-1)!.onReplaced!({ reason });
      });
      w.receipt = { ...w.receipt, data: { status: 'success', transactionHash: TX2 } };
      await act(async () => {
        v.rerender();
      });
      expect(screen.getByRole('alert')).toHaveTextContent(text);
      expect(screen.queryByText('補充しました。')).toBeNull();
      cleanup();
    }
  });

  it('確定の確認が失敗しても途中のまま (次を送らせない)・リンクと確かめ直すボタンを出す', async () => {
    const v = show();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    w.receipt = { ...w.receipt, isError: true };
    v.rerender();
    expect(screen.getByRole('alert')).toHaveTextContent('送った取引の結果をまだ確かめられません');
    expect(screen.getByRole('link', { name: '取引を見る' }).getAttribute('href')).toContain(TX);
    expect(sendButton()).toBeDisabled();
    expect(hasPendingStoreGasTopUp(gas)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '結果を確かめ直す' }));
    expect(w.receipt.refetch).toHaveBeenCalled();
  });

  it('ウォレットで断ったら印を外して元に戻す (失敗の表示は出さない)・それ以外の失敗は出す', async () => {
    w.sendAsync.mockRejectedValueOnce(new Error('User rejected the request.'));
    show();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(hasPendingStoreGasTopUp(gas)).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sendButton()).not.toBeDisabled();
    w.sendAsync.mockRejectedValueOnce(new Error('rpc down'));
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('送れませんでした'));
    expect(hasPendingStoreGasTopUp(gas)).toBe(false);
  });

  it('1 回の上限 (目安の上限) を超える額・数字でない額は送らない', () => {
    show();
    const input = screen.getByRole('textbox', { name: '送る額 (POL)' });
    fireEvent.change(input, { target: { value: '2.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('1 回に送れるのは 2 POL までです');
    expect(sendButton()).toBeDisabled();
    fireEvent.change(input, { target: { value: '1e3' } });
    expect(screen.getByRole('alert')).toHaveTextContent('送る額を数字で入れてください。');
    fireEvent.change(input, { target: { value: '0' } });
    expect(sendButton()).toBeDisabled();
  });

  it('接続中のウォレットの残高が足りなければ送らない', () => {
    w.balance = { value: 10n ** 17n };
    show();
    expect(screen.getByRole('alert')).toHaveTextContent('接続中のウォレットの POL が足りません。');
    expect(sendButton()).toBeDisabled();
  });

  it('ウォレットのチェーンが違えば、切り替えボタンだけを出す', () => {
    w.account = { address: SHOP, isConnected: true, chainId: 1 };
    show();
    expect(screen.queryByRole('button', { name: /を送る/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ウォレットを Polygon Amoy に切り替える' }));
    expect(w.switchChain).toHaveBeenCalledWith({ chainId: 80002 });
  });

  it('チェーンを選ぶと、そのチェーンの目安と通貨で送る', async () => {
    w.account = { address: SHOP, isConnected: true, chainId: 43113 };
    show([AMOY, FUJI]);
    fireEvent.change(screen.getByRole('combobox', { name: '補充するチェーン' }), { target: { value: '43113' } });
    expect(screen.getByRole('textbox', { name: '送る額 (AVAX)' })).toHaveValue('0.05');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '0.05 AVAX を送る' }));
    });
    expect(w.sendAsync).toHaveBeenCalledWith({ to: gas, value: 5n * 10n ** 16n, chainId: 43113 });
  });
});
