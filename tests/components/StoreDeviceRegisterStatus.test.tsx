import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { StoreDeviceRegisterStatus } from '@/components/StoreDeviceRegisterStatus';
import type { StoreDeviceRegisterState } from '@/hooks/useStoreDeviceRegister';

const HASH = `0x${'cd'.repeat(32)}` as const;
const MARK = {
  handoffId: 'x', chainId: 80002, nonce: `0x${'33'.repeat(32)}` as const, hash: HASH,
  from: '0x0000000000000000000000000000000000000def' as const, merchant: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
  amount: '500000000000000000000', validBefore: '1', intentSalt: `0x${'11'.repeat(32)}` as const, at: 0,
};
const handlers = () => ({
  onCheckNow: vi.fn(),
  onRetry: vi.fn(),
  onReissue: vi.fn(),
  onShowNormal: vi.fn(),
  onDismiss: vi.fn(),
});
function show(state: StoreDeviceRegisterState, h = handlers()) {
  render(<StoreDeviceRegisterStatus state={state} chainId={80002} formatAmount={() => '500 JPYC'} {...h} />);
  return h;
}

describe('StoreDeviceRegisterStatus (店員向けの表示)', () => {
  it('入金を確認 (品物を渡す合図) は金額つき・確定は別の行', () => {
    show({ phase: 'received', mark: MARK, finalized: false, previous: false });
    expect(screen.getByRole('status')).toHaveTextContent('入金を確認しました（500 JPYC）。品物をお渡しください。');
    expect(screen.queryByText('確定しました。')).toBeNull();
  });

  it('前回の送信の結果には「前回の送信」を添える', () => {
    show({ phase: 'received', mark: MARK, finalized: true, previous: true });
    expect(screen.getByRole('status')).toHaveTextContent(/前回の送信:.*入金を確認しました/);
    expect(screen.getByText('確定しました。')).toBeTruthy();
  });

  it('送らなかった: 理由と「お支払いは行われていません」・再送できるときだけ「もう一度送る」', () => {
    const h = show({ phase: 'not_sent', reason: 'native_insufficient', canRetry: true });
    expect(screen.getByRole('alert')).toHaveTextContent(/POL が足りない/);
    expect(screen.getByRole('alert')).toHaveTextContent(/お支払いは行われていません/);
    fireEvent.click(screen.getByRole('button', { name: 'もう一度送る' }));
    expect(h.onRetry).toHaveBeenCalled();
  });

  it('使用済みは「行われていません」と言わない (お客様の画面で確かめる)', () => {
    show({ phase: 'not_sent', reason: 'used', canRetry: false });
    expect(screen.getByRole('alert')).not.toHaveTextContent(/お支払いは行われていません/);
    expect(screen.queryByRole('button', { name: 'もう一度送る' })).toBeNull();
  });

  it('結果が分からない: 「いま確認する」・取引へのリンク', () => {
    const h = show({ phase: 'unknown', mark: MARK, previous: false });
    fireEvent.click(screen.getByRole('button', { name: 'いま確認する' }));
    expect(h.onCheckNow).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '取引を見る' })).toBeTruthy();
  });

  it('この会計の結果が分からない: 次の QR を出せない理由と、取引を確かめて閉じるボタン', () => {
    const h = show({ phase: 'unknown', mark: MARK, previous: false });
    expect(screen.getByRole('status')).toHaveTextContent(/確かめられるまで次の QR は出せません/);
    fireEvent.click(screen.getByRole('button', { name: '取引を確かめた（閉じる）' }));
    expect(h.onDismiss).toHaveBeenCalled();
  });

  it('成立しなかった (サーバの判定): 「お支払いは行われていません」', () => {
    show({ phase: 'failed', mark: MARK, previous: false });
    expect(screen.getByRole('alert')).toHaveTextContent('送信は成立しませんでした。お支払いは行われていません。');
  });

  it('作れなかった・読み取れない: 「通常の QR を出す」(店員が選ぶ)', () => {
    const h = show({ phase: 'create_failed', reason: 'busy' });
    fireEvent.click(screen.getByRole('button', { name: '通常の QR を出す' }));
    expect(h.onShowNormal).toHaveBeenCalled();
  });

  it('受付時間が残りわずか: 「QR を出し直す」', () => {
    const h = show({ phase: 'waiting', session: { id: 'x', token: 't', expiresAt: 0, merchant: MARK.merchant, amount: '1', chainId: 80002 }, stale: true, degraded: false });
    fireEvent.click(screen.getByRole('button', { name: 'QR を出し直す' }));
    expect(h.onReissue).toHaveBeenCalled();
  });
});
