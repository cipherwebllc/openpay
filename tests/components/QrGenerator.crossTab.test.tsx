// 決済 QR タブの会計の途中 (金額を入れた・QR を見せている) は、別のタブで変えた通貨・受取先を取り込まない
// (PR D10 の最終監査 P1・P2-2)。金額は通貨を持たない数字なので、取り込むと同じ数字のまま別の通貨の QR になる
// (1000 円のつもりが 1000 ドル・5 ドルのつもりが 5 円)。開いている QR の宛先も変えない。会計が終わったら取り込む。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
  useReadContract: vi.fn(() => ({ data: undefined })),
}));
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => 'https://test.local',
}));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/jpycGaslessProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/jpycGaslessProvider')>();
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'pimlico-7702' as const) };
});

import { QrGenerator } from '@/components/QrGenerator';
import { switchTokenKeepingPrefs } from '@/hooks/useQrSettings';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER = '0x2020202020202020202020202020202020202020';
const QR_KEY = 'openpay:qr-settings:v2';

function amountBox() {
  return screen.getByRole('textbox', { name: /請求金額/ });
}

async function openQrModal(user: ReturnType<typeof userEvent.setup>) {
  const btns = await screen.findAllByRole('button', { name: /QRコードを表示する/ });
  await user.click(btns[0]);
}

/** 開いている QR の決済 URL の query。 */
async function payParams() {
  const el = await screen.findByText((t) => t.includes('/pay?'));
  return new URL(el.textContent!.slice(el.textContent!.indexOf('https://'))).searchParams;
}

function otherTabWrites(update: (cur: Record<string, unknown>) => Record<string, unknown>) {
  const cur = JSON.parse(window.localStorage.getItem(QR_KEY)!);
  window.localStorage.setItem(QR_KEY, JSON.stringify(update(cur)));
}

function focusTab() {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

async function closeQrAndClearAmount(user: ReturnType<typeof userEvent.setup>) {
  const dialog = screen.getByRole('dialog', { name: '決済用 QR コード' });
  await user.click(within(dialog).getByRole('button', { name: '閉じる' }));
  await user.clear(amountBox());
}

describe('QrGenerator × 別のタブの設定の取り込み (会計の途中は保留)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('JPYC 1000 の QR を見せている間に別のタブで USDC に切り替えても、QR は開いたまま JPYC 1000・会計が終わったら取り込む', async () => {
    window.localStorage.setItem(QR_KEY, JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon' }));
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => amountBox());
    await user.type(amountBox(), '1000');
    await openQrModal(user);
    expect((await payParams()).get('token')).toBe('jpyc');

    otherTabWrites((cur) => switchTokenKeepingPrefs(cur as never, 'usdc'));
    focusTab();
    expect(screen.getByRole('dialog', { name: '決済用 QR コード' })).toBeTruthy();
    const held = await payParams();
    expect(held.get('token')).toBe('jpyc');
    expect(held.get('amount')).toBe('1000');

    // 会計が終わった (QR を閉じて金額を消した) → 取り込む。次の会計は USDC。
    await closeQrAndClearAmount(user);
    await user.type(amountBox(), '5');
    await openQrModal(user);
    expect((await payParams()).get('token')).toBe('usdc');
  });

  it('逆向き: USDC 5 の QR を見せている間に別のタブで JPYC に切り替えても、QR は USDC 5 のまま', async () => {
    window.localStorage.setItem(QR_KEY, JSON.stringify({ receiver: VALID, token: 'usdc', chain: 'base', payMode: 'gasless' }));
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => amountBox());
    await user.type(amountBox(), '5');
    await openQrModal(user);
    expect((await payParams()).get('token')).toBe('usdc');

    otherTabWrites((cur) => switchTokenKeepingPrefs(cur as never, 'jpyc'));
    focusTab();
    const held = await payParams();
    expect(held.get('token')).toBe('usdc');
    expect(held.get('amount')).toBe('5');
  });

  it('金額を入れている間は QR を閉じていても取り込まない', async () => {
    window.localStorage.setItem(QR_KEY, JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon' }));
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => amountBox());
    await user.type(amountBox(), '1000');
    otherTabWrites((cur) => switchTokenKeepingPrefs(cur as never, 'usdc'));
    focusTab();
    await openQrModal(user);
    expect((await payParams()).get('token')).toBe('jpyc');
  });

  it('QR を見せている間に別のタブで受取先を変えても、開いている QR の宛先は変えない・会計が終わったら取り込む', async () => {
    window.localStorage.setItem(QR_KEY, JSON.stringify({ receiver: VALID, receiverSource: 'manual', token: 'jpyc', chain: 'polygon' }));
    const user = userEvent.setup();
    render(<QrGenerator />);
    await waitFor(() => amountBox());
    await user.type(amountBox(), '1000');
    await openQrModal(user);
    expect((await payParams()).get('to')).toBe(VALID);

    otherTabWrites((cur) => ({ ...cur, receiver: OTHER, receiverSource: 'manual' }));
    focusTab();
    expect((await payParams()).get('to')).toBe(VALID);

    await closeQrAndClearAmount(user);
    await user.type(amountBox(), '1000');
    await openQrModal(user);
    expect((await payParams()).get('to')?.toLowerCase()).toBe(OTHER);
  });
});
