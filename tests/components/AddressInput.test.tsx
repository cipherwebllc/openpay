import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({
    data: null,
    isFetching: false,
    error: null,
  })),
}));

import { AddressInput } from '@/components/AddressInput';
import { useResolveAddress } from '@/hooks/useResolveAddress';
import { mockHook } from '../_helpers/wagmiMock';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AddressInput', () => {
  it('入力値を onChange に渡す (前後空白は trim)', () => {
    const onChange = vi.fn();
    render(<AddressInput value="" onChange={onChange} />);
    // controlled input + trim 動作の検証は fireEvent.change で 1 ショット。
    // userEvent.type は文字単位でイベントを撃つため、controlled value が
    // 同期反映されず leading-space ケースで意図しない挙動になる。
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  vitalik.eth  ' },
    });
    expect(onChange).toHaveBeenCalledWith('vitalik.eth');
  });

  it('0x を入れた状態では useResolveAddress に空文字を渡し、RPC を抑制', () => {
    render(
      <AddressInput
        value="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        onChange={() => {}}
      />,
    );
    expect(vi.mocked(useResolveAddress)).toHaveBeenCalledWith('');
  });

  it('vitalik.eth を入れると hook に渡す', () => {
    render(<AddressInput value="vitalik.eth" onChange={() => {}} />);
    expect(vi.mocked(useResolveAddress)).toHaveBeenCalledWith('vitalik.eth');
  });

  it('解決中 → "解決しています" 表示', () => {
    mockHook(useResolveAddress, {
      data: null,
      isFetching: true,
      error: null,
    });
    render(<AddressInput value="vitalik.eth" onChange={() => {}} />);
    expect(screen.getByText(/解決しています/)).toBeInTheDocument();
  });

  it('解決成功 → "✓ name → address" 表示 + onResolved コールバック', () => {
    const onResolved = vi.fn();
    mockHook(useResolveAddress, {
      data: {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        name: 'vitalik.eth',
      },
      isFetching: false,
      error: null,
    });
    render(
      <AddressInput
        value="vitalik.eth"
        onChange={() => {}}
        onResolved={onResolved}
      />,
    );
    expect(screen.getByText(/vitalik\.eth/)).toBeInTheDocument();
    expect(
      screen.getByText('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    ).toBeInTheDocument();
    expect(onResolved).toHaveBeenCalledWith(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    );
  });

  it('解決失敗 → エラー文言表示 + onResolved(null)', () => {
    const onResolved = vi.fn();
    mockHook(useResolveAddress, {
      data: null,
      isFetching: false,
      error: new Error('foo.eth は登録されていません'),
    });
    render(
      <AddressInput
        value="foo.eth"
        onChange={() => {}}
        onResolved={onResolved}
      />,
    );
    expect(
      screen.getByText('foo.eth は登録されていません'),
    ).toBeInTheDocument();
    expect(onResolved).toHaveBeenCalledWith(null);
  });
});
