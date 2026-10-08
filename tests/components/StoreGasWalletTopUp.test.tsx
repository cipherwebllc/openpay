// 「接続中のウォレットから補充」: お店のウォレット (wagmi) から、ガス用ウォレットへガス代のトークンを送る。
// 操作の記録 (lib/storeGasTopUp.ts) で、二重に送らない・届く途中の宛先を消さない・画面を離れても続きを見る・
// 取り消しや別の宛先への置き換えを「補充しました」と言わない、を確かめる。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Address } from 'viem';
import { renderWithIntl as render } from '../_helpers/i18n';

type Receipt = {
  data: { status: 'success' | 'reverted'; transactionHash: string } | undefined;
  isError: boolean;
};
type ReceiptArgs = {
  hash?: string;
  chainId?: number;
  onReplaced?: (r: { reason: string; transaction: { to: string | null; value: bigint; hash?: string } }) => void;
};
const w = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined },
  balance: undefined as { value: bigint } | undefined,
  sendAsync: vi.fn(),
  switchChain: vi.fn(),
  receipt: { data: undefined, isError: false } as Receipt,
  receiptArgs: [] as ReceiptArgs[],
  rawReceipt: vi.fn(),
}));
vi.mock('wagmi', () => ({
  useAccount: () => w.account,
  useBalance: () => ({ data: w.balance }),
  useSwitchChain: () => ({ switchChain: w.switchChain, isPending: false }),
  useSendTransaction: () => ({ sendTransactionAsync: w.sendAsync }),
  useWaitForTransactionReceipt: (args: ReceiptArgs) => {
    w.receiptArgs.push(args);
    return args.hash ? w.receipt : { data: undefined, isError: false };
  },
  usePublicClient: () => ({ getTransactionReceipt: w.rawReceipt }),
}));

import { StoreGasWalletTopUp } from '@/components/StoreGasWalletTopUp';
import { createStoreGasWallet, loadStoreGasWallet } from '@/lib/storeGasWallet';
import { attachStoreGasTopUpHash, liveStoreGasTopUps, reserveStoreGasTopUp } from '@/lib/storeGasTopUp';

const SHOP = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER = '0x1111111111111111111111111111111111111111';
const TX = `0x${'ab'.repeat(32)}` as const;
const TX2 = `0x${'cd'.repeat(32)}` as const;
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
function show(chains = [AMOY]) {
  const props = { onDone: vi.fn(), onPendingChange: vi.fn() };
  const ui = () => <StoreGasWalletTopUp chains={chains} gasAddress={gas} {...props} />;
  const r = render(ui());
  return { ...props, rerender: () => r.rerender(ui()), unmount: r.unmount };
}
const sendButton = () => screen.getByRole('button', { name: /を送る/ });
const records = () => liveStoreGasTopUps(gas);
const lastReplaced = () => w.receiptArgs.filter((a) => a.hash).at(-1)!.onReplaced!;

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
    w.receipt = { data: undefined, isError: false };
    w.receiptArgs = [];
    w.rawReceipt.mockReset().mockRejectedValue(new Error('not found'));
  });

  it('未接続なら、右上で接続するよう案内するだけ (送る欄は出さない)', () => {
    w.account = { address: undefined, isConnected: false, chainId: undefined };
    show();
    expect(screen.getByText(/右上の「接続」でお店のウォレットをつなぐと/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /を送る/ })).toBeNull();
  });

  it('既定額は目安の下限・保存されている鍵と同じ宛先へ送る・送る前に記録を置き、送ったら tx を記録に残す', async () => {
    let duringApproval: ReturnType<typeof records> = [];
    w.sendAsync.mockImplementation(async () => {
      duringApproval = records();
      return TX;
    });
    show();
    expect(screen.getByRole('textbox', { name: '送る額 (POL)' })).toHaveValue('1');
    expect(screen.getByText(/目安 1〜2 POL・1 回 2 POL まで/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1 POL を送る' }));
    });
    expect(w.sendAsync).toHaveBeenCalledWith({ to: gas, value: 10n ** 18n, chainId: 80002 });
    expect(duringApproval).toHaveLength(1);
    expect(duringApproval[0].hash).toBeUndefined();
    expect(records()[0]).toMatchObject({ hash: TX, chainId: 80002 });
  });

  it('二度押ししても 1 回だけ送る (描画やロック待ちの前に止める)', async () => {
    let approve!: (h: string) => void;
    w.sendAsync.mockImplementation(() => new Promise((r) => { approve = r; }));
    show();
    const button = sendButton();
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(w.sendAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      approve(TX);
    });
  });

  it('別のタブで鍵が作り直されていたら送らない (古いアドレスへ送らない)', async () => {
    show();
    window.localStorage.clear();
    createStoreGasWallet();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(w.sendAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('ガス用ウォレットが変わりました');
  });

  it('別の画面で同じ宛先への補充が途中なら、送らせない (その旨を出す)', () => {
    reserveStoreGasTopUp(gas, 80002);
    const v = show();
    expect(screen.getByRole('status')).toHaveTextContent('別の画面で、ウォレットの確認中の補充があります。');
    expect(sendButton()).toBeDisabled();
    expect(v.onPendingChange).toHaveBeenLastCalledWith(true);
  });

  it('確認中・結果待ちの間は、次の送信・額・チェーンを変えさせない', async () => {
    let approve!: (h: string) => void;
    w.sendAsync.mockImplementation(() => new Promise((r) => { approve = r; }));
    show([AMOY, FUJI]);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(screen.getByRole('status')).toHaveTextContent('ウォレットで確認してください');
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '送る額 (POL)' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '補充するチェーン' })).toBeDisabled();
    await act(async () => {
      approve(TX);
    });
    expect(screen.getByRole('status')).toHaveTextContent('送っています。確定を待っています');
    expect(sendButton()).toBeDisabled();
  });

  it('画面を離れた後にウォレットで確認されても tx を記録に残し、戻ったら続きを見て結果を出す', async () => {
    let approve!: (h: string) => void;
    w.sendAsync.mockImplementation(() => new Promise((r) => { approve = r; }));
    const first = show();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    first.unmount();
    await act(async () => {
      approve(TX);
    });
    expect(records()[0]).toMatchObject({ hash: TX });
    // 戻る
    const again = show();
    expect(screen.getByRole('status')).toHaveTextContent('送っています。確定を待っています');
    expect(sendButton()).toBeDisabled();
    w.receipt = { data: { status: 'success', transactionHash: TX }, isError: false };
    await act(async () => {
      again.rerender();
    });
    expect(screen.getByRole('status')).toHaveTextContent('補充しました。');
    expect(screen.getByRole('link', { name: '取引を見る' }).getAttribute('href')).toContain(TX);
    expect(records()).toHaveLength(0);
    expect(again.onDone).toHaveBeenCalledTimes(1);
    again.rerender();
    expect(again.onDone).toHaveBeenCalledTimes(1);
  });

  it('確定の確認が失敗したら receipt を直接読む: 取引の失敗 (revert) なら結果にする・見つからなければ途中のまま', async () => {
    attachStoreGasTopUpHash({ id: 'a', address: gas, chainId: 80002 }, TX);
    w.receipt = { data: undefined, isError: true };
    w.rawReceipt.mockRejectedValue(new Error('not found'));
    const v = show();
    await waitFor(() => expect(w.rawReceipt).toHaveBeenCalled());
    expect(screen.getByRole('alert')).toHaveTextContent('送った取引の結果をまだ確かめられません');
    expect(sendButton()).toBeDisabled();
    expect(records()).toHaveLength(1);
    w.rawReceipt.mockResolvedValue({ status: 'reverted', transactionHash: TX });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '結果を確かめ直す' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('補充に失敗しました');
    expect(records()).toHaveLength(0);
    expect(v.onDone).toHaveBeenCalledTimes(1);
  });

  it('ウォレットでの置き換え: 取り消し・別の宛先なら「補充しました」と言わない・同じ宛先への額の変更は補充', async () => {
    for (const [reason, to, value, text] of [
      ['cancelled', SHOP, 0n, 'ウォレットで取り消されました。補充されていません。'],
      ['replaced', OTHER, 10n ** 18n, 'ウォレットで別の取引に置き換えられました。補充されていません。'],
      ['replaced', null, 10n ** 18n, 'ウォレットで別の取引に置き換えられました。補充されていません。'],
      ['replaced', 'GAS', 5n * 10n ** 17n, '補充しました。'],
      ['repriced', 'GAS', 10n ** 18n, '補充しました。'],
    ] as const) {
      window.localStorage.removeItem('openpay:store-gas-wallet:topup:v2');
      w.receipt = { data: undefined, isError: false };
      const v = show();
      await act(async () => {
        fireEvent.click(sendButton());
      });
      act(() => {
        lastReplaced()({ reason, transaction: { to: to === 'GAS' ? gas : to, value } });
      });
      w.receipt = { data: { status: 'success', transactionHash: TX2 }, isError: false };
      await act(async () => {
        v.rerender();
      });
      expect(screen.getByText(text)).toBeTruthy();
      expect(records()).toHaveLength(0);
      cleanup();
    }
  });

  it('置き換え先の取引が失敗 (revert) しても、置き換え先の receipt で結果を出す', async () => {
    const v = show();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await act(async () => {
      lastReplaced()({ reason: 'repriced', transaction: { to: gas, value: 10n ** 18n, hash: TX2 } as never });
    });
    // 記録の tx は置き換え先に変わる (画面を離れても置き換え先を見る)
    expect(records()[0]).toMatchObject({ hash: TX2 });
    w.receipt = { data: undefined, isError: true }; // wagmi は revert を失敗で返す
    w.rawReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      if (hash !== TX2) throw new Error('not found');
      return { status: 'reverted', transactionHash: TX2 };
    });
    await act(async () => {
      v.rerender();
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('補充に失敗しました'));
    expect(records()).toHaveLength(0);
  });

  it('前の操作の置き換え (取り消し) を、次の操作の結果に持ち越さない', async () => {
    const v = show();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    act(() => {
      lastReplaced()({ reason: 'cancelled', transaction: { to: SHOP, value: 0n, hash: TX2 } as never });
    });
    w.receipt = { data: { status: 'success', transactionHash: TX2 }, isError: false };
    await act(async () => {
      v.rerender();
    });
    expect(screen.getByText('ウォレットで取り消されました。補充されていません。')).toBeTruthy();
    // 別の画面で始めた補充 (送った) を、この画面が続きから見る
    w.receipt = { data: undefined, isError: false };
    attachStoreGasTopUpHash({ id: 'other', address: gas, chainId: 80002 }, TX);
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'openpay:store-gas-wallet:topup:v2' }));
    });
    w.receipt = { data: { status: 'success', transactionHash: TX }, isError: false };
    await act(async () => {
      v.rerender();
    });
    expect(screen.getByText('補充しました。')).toBeTruthy();
  });

  it('送った tx を記録に残せなくても (端末の保存容量)、この画面で見張って結果を出す', async () => {
    const realSetItem = Storage.prototype.setItem;
    let calls = 0;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, val: string) {
      // 1 回目 (記録を置く) は通し、tx を残す 2 回目は失敗させる
      calls += 1;
      if (k === 'openpay:store-gas-wallet:topup:v2' && calls > 1) throw new Error('QuotaExceededError');
      return realSetItem.call(this, k, val);
    });
    try {
      const v = show();
      await act(async () => {
        fireEvent.click(sendButton());
      });
      expect(screen.getByRole('status')).toHaveTextContent('送っています。確定を待っています');
      expect(screen.getByRole('link', { name: '取引を見る' }).getAttribute('href')).toContain(TX);
      expect(sendButton()).toBeDisabled();
      w.receipt = { data: { status: 'success', transactionHash: TX }, isError: false };
      await act(async () => {
        v.rerender();
      });
      expect(screen.getByText('補充しました。')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('ウォレットで断ったら記録を片付けて元に戻す (失敗の表示は出さない)・それ以外の失敗は出す', async () => {
    w.sendAsync.mockRejectedValueOnce(new Error('User rejected the request.'));
    show();
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(records()).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sendButton()).not.toBeDisabled();
    w.sendAsync.mockRejectedValueOnce(new Error('rpc down'));
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(screen.getByRole('alert')).toHaveTextContent('送れませんでした');
    expect(records()).toHaveLength(0);
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
