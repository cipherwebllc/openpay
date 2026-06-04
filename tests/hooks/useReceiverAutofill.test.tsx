import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { getAddress, type Address } from 'viem';

// useAccount をテスト個別に制御する。
const useAccountMock = vi.fn();
vi.mock('wagmi', () => ({ useAccount: () => useAccountMock() }));

import { useReceiverAutofill } from '@/hooks/useReceiverAutofill';

const A1 = getAddress('0x1111111111111111111111111111111111111111');
const A2 = getAddress('0x2222222222222222222222222222222222222222');

function setAccount(addr?: Address) {
  useAccountMock.mockReturnValue(
    addr ? { address: addr, isConnected: true } : { address: undefined, isConnected: false },
  );
}

beforeEach(() => {
  useAccountMock.mockReset();
});

type Props = {
  receiver: string;
  receiverSource: 'auto' | 'manual';
  effectiveReceiver: Address | null;
  hydrated: boolean;
};

function setup(initial: Props) {
  const setReceiver = vi.fn();
  const { result, rerender } = renderHook(
    (p: Props) => useReceiverAutofill({ ...p, setReceiver }),
    { initialProps: initial },
  );
  return { result, rerender, setReceiver };
}

describe('useReceiverAutofill', () => {
  it('hydration 前は自動補完しない', () => {
    setAccount(A1);
    const { setReceiver } = setup({
      receiver: '',
      receiverSource: 'manual',
      effectiveReceiver: null,
      hydrated: false,
    });
    expect(setReceiver).not.toHaveBeenCalled();
  });

  it('空欄 + 接続 + hydrated → 接続アドレスを auto で補完', () => {
    setAccount(A1);
    const { setReceiver } = setup({
      receiver: '',
      receiverSource: 'manual',
      effectiveReceiver: null,
      hydrated: true,
    });
    expect(setReceiver).toHaveBeenCalledTimes(1);
    expect(setReceiver).toHaveBeenCalledWith(A1, 'auto');
  });

  it('receiver が既に入力済みなら自動補完しない', () => {
    setAccount(A1);
    const { setReceiver } = setup({
      receiver: A2,
      receiverSource: 'manual',
      effectiveReceiver: A2,
      hydrated: true,
    });
    expect(setReceiver).not.toHaveBeenCalled();
  });

  it('未接続では自動補完もチップも出ない', () => {
    setAccount(undefined);
    const { result, setReceiver } = setup({
      receiver: '',
      receiverSource: 'manual',
      effectiveReceiver: null,
      hydrated: true,
    });
    expect(setReceiver).not.toHaveBeenCalled();
    expect(result.current.connected).toBeNull();
    expect(result.current.canUseConnected).toBe(false);
    expect(result.current.matchesConnected).toBe(false);
  });

  it('手入力 (handleManualChange) 後はクリアしても再補完しない (userTouched)', () => {
    setAccount(A1);
    const { result, setReceiver, rerender } = setup({
      receiver: '',
      receiverSource: 'manual',
      effectiveReceiver: null,
      hydrated: true,
    });
    // 初回 autofill が 1 回走る。
    expect(setReceiver).toHaveBeenCalledTimes(1);
    // ユーザが手入力 → userTouched。
    act(() => result.current.handleManualChange('0xabc'));
    expect(setReceiver).toHaveBeenLastCalledWith('0xabc', 'manual');
    // 手動でクリア (空) して再 render しても autofill は再発火しない。
    rerender({
      receiver: '',
      receiverSource: 'manual',
      effectiveReceiver: null,
      hydrated: true,
    });
    // 計 2 回 (autofill 1 + manual 1) のまま増えない。
    expect(setReceiver).toHaveBeenCalledTimes(2);
  });

  it("source='auto' はウォレット切替に追従する", () => {
    setAccount(A1);
    const { setReceiver, rerender } = setup({
      receiver: A1,
      receiverSource: 'auto',
      effectiveReceiver: A1,
      hydrated: true,
    });
    // mount 時は receiver===connected なので冗長書込なし。
    expect(setReceiver).not.toHaveBeenCalled();
    // ウォレット切替 → A2 に追従。
    setAccount(A2);
    rerender({
      receiver: A1,
      receiverSource: 'auto',
      effectiveReceiver: A1,
      hydrated: true,
    });
    expect(setReceiver).toHaveBeenCalledTimes(1);
    expect(setReceiver).toHaveBeenCalledWith(A2, 'auto');
  });

  it("source='manual' はウォレット切替に追従しない (据置)", () => {
    setAccount(A1);
    const { setReceiver, rerender } = setup({
      receiver: A1,
      receiverSource: 'manual',
      effectiveReceiver: A1,
      hydrated: true,
    });
    setAccount(A2);
    rerender({
      receiver: A1,
      receiverSource: 'manual',
      effectiveReceiver: A1,
      hydrated: true,
    });
    expect(setReceiver).not.toHaveBeenCalled();
  });

  it('useConnectedWallet() は接続アドレスを auto で流し込む', () => {
    setAccount(A1);
    const { result, setReceiver } = setup({
      receiver: A2,
      receiverSource: 'manual',
      effectiveReceiver: A2,
      hydrated: true,
    });
    act(() => result.current.useConnectedWallet());
    expect(setReceiver).toHaveBeenCalledWith(A1, 'auto');
  });

  it('一致判定: 受取先=接続アドレスなら matches=true / canUse=false', () => {
    setAccount(A1);
    const { result } = setup({
      receiver: A1,
      receiverSource: 'auto',
      effectiveReceiver: A1,
      hydrated: true,
    });
    expect(result.current.matchesConnected).toBe(true);
    expect(result.current.canUseConnected).toBe(false);
  });

  it('一致判定: 別アドレス入力済みなら matches=false / canUse=true (チップ表示)', () => {
    setAccount(A1);
    const { result } = setup({
      receiver: A2,
      receiverSource: 'manual',
      effectiveReceiver: A2,
      hydrated: true,
    });
    expect(result.current.matchesConnected).toBe(false);
    expect(result.current.canUseConnected).toBe(true);
  });
});
