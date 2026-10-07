import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

const hold = vi.hoisted(() => ({
  state: { phase: 'idle' } as Record<string, unknown>,
  dismiss: vi.fn(),
  checkNow: vi.fn(),
  retry: vi.fn(),
}));
vi.mock('@/components/StoreDeviceProvider', () => ({
  useStoreDeviceMode: () => ({
    chainId: 80002,
    deployment: { decimals: 18, displaySymbol: 'JPYC' },
    device: { state: hold.state, dismiss: hold.dismiss, checkNow: hold.checkNow, retry: hold.retry },
  }),
}));

import { StoreDevicePageStatus } from '@/components/StoreDevicePageStatus';

const MARK = { hash: `0x${'cd'.repeat(32)}`, amount: (3n * 10n ** 18n).toString() };

describe('StoreDevicePageStatus (レジ以外のタブでも支払いの行方を見せる)', () => {
  it('何もしていなければ出さない', () => {
    hold.state = { phase: 'idle' };
    const { container } = renderWithIntl(<StoreDevicePageStatus />);
    expect(container.textContent).toBe('');
  });

  it('この会計の結果が分からないとき: 見出しつきで出し、「いま確認する」と「取引を確かめた（閉じる）」が使える', () => {
    hold.state = { phase: 'unknown', mark: MARK, previous: false };
    renderWithIntl(<StoreDevicePageStatus />);
    expect(screen.getByRole('region', { name: 'お店がガス代を肩代わりして送る支払い' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'いま確認する' }));
    expect(hold.checkNow).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取引を確かめた（閉じる）' }));
    expect(hold.dismiss).toHaveBeenCalled();
  });

  it('「もう一度送る」はレジの外では出さない (会計と結びつくのでレジで行う)', () => {
    hold.state = { phase: 'not_sent', reason: 'rpc', canRetry: true };
    renderWithIntl(<StoreDevicePageStatus />);
    expect(screen.queryByRole('button', { name: 'もう一度送る' })).toBeNull();
    expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy();
  });

  it('入金を確認したら金額つきで出す', () => {
    hold.state = { phase: 'received', mark: MARK, finalized: false, previous: false };
    renderWithIntl(<StoreDevicePageStatus />);
    expect(screen.getByText(/入金を確認しました（3 JPYC）/)).toBeTruthy();
  });
});
