// レジの会計の途中 (カートに商品がある・QR を見せている) は、別のタブで変えた通貨を取り込まない (PR D10 の最終監査 P1)。
// カートの単価は通貨を持たない数字なので、取り込むと同じ数字のまま別の通貨の QR になる (500 円のつもりが 500 ドル)。
// 会計が終わったら (カートが空になったら) 取り込む。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
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
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: false,
    sessionAddress: null,
    mismatch: false,
    isLoading: false,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
  }),
}));

import { RegisterMode } from '@/components/RegisterMode';
import { switchTokenKeepingPrefs } from '@/hooks/useQrSettings';
import { parseCheckoutParams } from '@/lib/url';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const QR_KEY = 'openpay:qr-settings:v2';

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function tiles() {
  return within(screen.getByRole('region', { name: /^(商品|Products)$/ }));
}
function orderPanel() {
  return within(screen.getByRole('region', { name: /^(ご注文|Order)$/ }));
}

/** 「QRコードを表示する」で開いたモーダルの checkout URL を読む (開いていれば開き直さない)。 */
async function checkoutInModal(user: ReturnType<typeof userEvent.setup>) {
  if (!screen.queryByText(/\/checkout\?/)) {
    const btns = await screen.findAllByRole('button', { name: /QRコードを表示する/ });
    await user.click(btns[0]);
  }
  const el = await screen.findByText(/\/checkout\?/);
  return parseCheckoutParams(new URL(el.textContent!).searchParams);
}

/** 別のタブが通貨を切り替えて保存した。 */
function otherTabSwitchesTo(token: 'jpyc' | 'usdc') {
  const cur = JSON.parse(window.localStorage.getItem(QR_KEY)!);
  window.localStorage.setItem(QR_KEY, JSON.stringify(switchTokenKeepingPrefs(cur, token)));
}

function focusTab() {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

describe('RegisterMode × 別のタブの設定の取り込み (会計の途中は保留)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    window.localStorage.setItem(QR_KEY, JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon' }));
  });

  it('JPYC のカートの QR を見せている間に別のタブで USDC に切り替えても、QR は JPYC・同じ単価のまま', async () => {
    const user = userEvent.setup();
    render(<RegisterMode />);
    await user.click(await within(await screen.findByRole('region', { name: /^(商品|Products)$/ })).findByRole('button', { name: /コーヒー/ }));
    const before = await checkoutInModal(user);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.params).toMatchObject({ token: 'jpyc', chain: 'polygon' });

    otherTabSwitchesTo('usdc');
    focusTab();
    const after = await checkoutInModal(user);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.params.token).toBe('jpyc');
    expect(after.params.chain).toBe('polygon');
    expect(after.params.items).toEqual(before.params.items);
  });

  it('カートに商品がある間は取り込まず (QR を閉じていても)、カートを空にしたら取り込む', async () => {
    const user = userEvent.setup();
    render(<RegisterMode />);
    await user.click(await within(await screen.findByRole('region', { name: /^(商品|Products)$/ })).findByRole('button', { name: /コーヒー/ }));

    otherTabSwitchesTo('usdc');
    focusTab();
    const held = await checkoutInModal(user);
    expect(held.ok && held.params.token).toBe('jpyc');
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    focusTab();
    expect(screen.queryAllByText('USDC', { exact: true })).toHaveLength(0);

    // カートを空にする (会計が終わった) → 保留していた取り込みをする。
    await user.click(orderPanel().getByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getByRole('button', { name: 'この商品を削除' }));
    await waitFor(() => expect(screen.getAllByText('USDC', { exact: true }).length).toBeGreaterThan(0));
    expect(tiles().getByRole('button', { name: /コーヒー/ })).toBeTruthy();
  });
});
