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
  render(<StoreDeviceRegisterStatus state={state} formatAmount={() => '500 JPYC'} {...h} />);
  return h;
}

describe('StoreDeviceRegisterStatus (店員向けの表示)', () => {
  it('入金を確認 (品物を渡す合図) は金額つき・確定は別の行', () => {
    show({ phase: 'received', mark: MARK, finalized: false, previous: false });
    expect(screen.getByRole('status')).toHaveTextContent('入金を確認しました（500 JPYC）。品物をお渡しください。');
    expect(screen.queryByText('確定しました。')).toBeNull();
  });

  it('前回の送信の結果には「前回の送信」を添え、「品物をお渡しください」は付けない', () => {
    show({ phase: 'received', mark: MARK, finalized: true, previous: true });
    expect(screen.getByRole('status')).toHaveTextContent(/前回の送信:.*入金を確認しました/);
    expect(screen.getByRole('status')).not.toHaveTextContent(/品物をお渡しください/);
    expect(screen.getByText('確定しました。')).toBeTruthy();
  });

  it('送らなかった: 理由と「お支払いは行われていません」・再送できるときだけ「もう一度送る」', () => {
    const h = show({ phase: 'not_sent', reason: 'native_insufficient', canRetry: true });
    expect(screen.getByRole('alert')).toHaveTextContent('残高 (ガス代) が足りない');
    expect(screen.getByRole('alert')).toHaveTextContent(/お支払いは行われていません/);
    fireEvent.click(screen.getByRole('button', { name: 'もう一度送る' }));
    expect(h.onRetry).toHaveBeenCalled();
  });

  it('入金の確認の「取引を見る」は、判定が見つけた実際の tx (第三者が同じ署名を先に送ったときは端末の tx と違う・第 7 回レビュー A11)', () => {
    const SETTLED = `0x${'ef'.repeat(32)}` as const;
    show({ phase: 'received', mark: MARK, finalized: true, previous: false, txHash: SETTLED });
    const href = screen.getByRole('link', { name: '取引を見る' }).getAttribute('href') ?? '';
    expect(href).toContain(SETTLED);
    expect(href).not.toContain(HASH);
  });

  describe('店の tx が revert した後の「結果が分からない」(第 7 回レビュー A3)', () => {
    it('店の revert 済みの tx を確認先として出さず、「確かめた（閉じる）」も出さない (店の tx の確認だけで次の QR を出させない)', () => {
      const h = show({ phase: 'unknown', mark: MARK, previous: false, storeTxReverted: true });
      expect(screen.getByRole('status')).toHaveTextContent('お店の端末の送信は失敗しましたが');
      expect(screen.queryByRole('link', { name: '取引を見る' })).toBeNull();
      expect(screen.queryByRole('button', { name: '取引を確かめた（閉じる）' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'いま確認する' }));
      expect(h.onCheckNow).toHaveBeenCalled();
      expect(h.onDismiss).not.toHaveBeenCalled();
    });

    it('判定が見つけた確定待ちの tx があれば、確認先はその tx (店の revert 済みの tx ではない)', () => {
      const PENDING = `0x${'ef'.repeat(32)}` as const;
      show({ phase: 'unknown', mark: MARK, previous: true, storeTxReverted: true, txHash: PENDING });
      expect(screen.getByRole('status')).toHaveTextContent(/前回の送信:.*お店の端末の送信は失敗しましたが/);
      const href = screen.getByRole('link', { name: '取引を見る' }).getAttribute('href') ?? '';
      expect(href).toContain(PENDING);
      expect(href).not.toContain(HASH);
      expect(screen.queryByRole('button', { name: '取引を確かめた（閉じる）' })).toBeNull();
    });

    it('通常の「結果が分からない」は従来どおり (端末の tx へのリンクと「取引を確かめた（閉じる）」)', () => {
      const h = show({ phase: 'unknown', mark: MARK, previous: false });
      expect(screen.getByRole('link', { name: '取引を見る' }).getAttribute('href')).toContain(HASH);
      fireEvent.click(screen.getByRole('button', { name: '取引を確かめた（閉じる）' }));
      expect(h.onDismiss).toHaveBeenCalled();
    });
  });

  it('判定の tx が無い入金の確認は、端末が送った tx へのリンク (従来どおり)', () => {
    show({ phase: 'received', mark: MARK, finalized: false, previous: false });
    expect(screen.getByRole('link', { name: '取引を見る' }).getAttribute('href')).toContain(HASH);
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

  it.each([
    [{ phase: 'expired' } as const],
    [{ phase: 'create_failed', reason: 'unavailable' } as const],
  ])('受付時間の終わり・作れなかった (%o) も「閉じる」で消せる (レジ以外のタブでも残り続けない)', (state) => {
    const h = show(state);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(h.onDismiss).toHaveBeenCalled();
  });

  it('受付時間が残りわずか: 「QR を出し直す」', () => {
    const h = show({ phase: 'waiting', session: { id: 'x', token: 't', expiresAt: 0, merchant: MARK.merchant, amount: '1', chainId: 80002 }, stale: true, degraded: false });
    fireEvent.click(screen.getByRole('button', { name: 'QR を出し直す' }));
    expect(h.onReissue).toHaveBeenCalled();
  });
});
