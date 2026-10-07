import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';

vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({ data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' }, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({ isSignedIn: false, sessionAddress: null, mismatch: false, isLoading: false, signIn: vi.fn(), isSigningIn: false, signInError: null, signOut: vi.fn() }),
}));

const FEE = '0x428483FbA62eDCef1E3a100d3799F6d71759c560';
const hold = vi.hoisted(() => ({
  registerFee: true,
  on: true,
  gas: '0x0000000000000000000000000000000000000abc' as string | null,
  state: { phase: 'idle' } as Record<string, unknown>,
  start: vi.fn(),
  stop: vi.fn(),
  release: vi.fn(),
  busy: false,
  dismiss: vi.fn(),
  setOn: vi.fn(),
  panelBlocked: [] as unknown[],
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableStoreGasWallet: true,
      networkEnv: 'testnet',
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
      get enableRegisterFee() {
        return hold.registerFee;
      },
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));
vi.mock('@/hooks/useStoreDeviceRegister', () => ({
  useStoreDeviceToggle: () => [hold.on, hold.setOn],
  useStoreDeviceRegister: () => ({
    state: hold.state,
    busy: hold.busy,
    start: hold.start,
    stop: hold.stop,
    releaseForNormal: hold.release,
    checkNow: vi.fn(),
    retry: vi.fn(),
    dismiss: hold.dismiss,
  }),
}));
vi.mock('@/components/StoreGasWalletPanel', () => ({
  StoreGasWalletPanel: ({
    onAddressChange,
    storeDevice,
  }: {
    onAddressChange?: (a: string | null) => void;
    storeDevice?: { blocked: unknown };
  }) => {
    useEffect(() => {
      onAddressChange?.(hold.gas);
    }, [onAddressChange]);
    hold.panelBlocked.push(storeDevice?.blocked);
    return <div>gas-wallet-panel</div>;
  },
}));

import { RegisterMode } from '@/components/RegisterMode';
import { parseCheckoutParams } from '@/lib/url';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HS = 'AbCdEfGhIjKlMnOpQrStUv';

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function seed(receiver = VALID) {
  window.localStorage.setItem(
    'openpay:qr-settings:v2',
    JSON.stringify({ receiver, token: 'jpyc', chain: 'polygon' }),
  );
}

async function addItemAndOpen(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /コーヒー/ }));
  const btns = await screen.findAllByRole('button', { name: /QRコードを表示する/ });
  await user.click(btns[0]);
}

function shownCheckout() {
  const el = screen.queryByText(/\/checkout\?/);
  return el ? new URL(el.textContent!).searchParams : null;
}

describe('RegisterMode × お店の端末で送る (flag ON)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hold.registerFee = true;
    hold.on = true;
    hold.gas = '0x0000000000000000000000000000000000000abc';
    hold.state = { phase: 'idle' };
    hold.start.mockReset().mockResolvedValue({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
    hold.stop.mockReset();
    hold.release.mockReset().mockResolvedValue(true);
    hold.busy = false;
    hold.dismiss.mockReset();
    hold.panelBlocked.length = 0;
    Object.defineProperty(window.navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  });
  afterEach(() => {
    Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
  });

  it('切替 ON: QR を出すときに受け渡しを作り、QR は submit=store&hs= (fee_kind は付けない)', async () => {
    const user = userEvent.setup();
    seed();
    hold.state = { phase: 'waiting', session: { id: HS }, stale: false, degraded: false };
    render(<RegisterMode />);
    await addItemAndOpen(user);
    expect(hold.start).toHaveBeenCalledWith(VALID, 500n * 10n ** 18n);
    const sp = await waitFor(() => {
      const v = shownCheckout();
      if (!v) throw new Error('not yet');
      return v;
    });
    expect(sp.get('submit')).toBe('store');
    expect(sp.get('hs')).toBe(HS);
    expect(sp.get('fee_kind')).toBeNull();
    const parsed = parseCheckoutParams(sp);
    expect(parsed.ok).toBe(true);
    expect(screen.getAllByText('お店の端末で送る（利用料 0 円）').length).toBeGreaterThan(0);
    expect(screen.getByText('お客様の署名を待っています')).toBeTruthy();
  });

  it('受け渡しを作れなければ QR を開かない (黙って通常の QR に切り替えない)', async () => {
    const user = userEvent.setup();
    seed();
    hold.start.mockResolvedValue(null);
    render(<RegisterMode />);
    await addItemAndOpen(user);
    expect(hold.start).toHaveBeenCalled();
    expect(shownCheckout()).toBeNull();
  });

  it('QR を閉じたら受け渡しを締め切る', async () => {
    const user = userEvent.setup();
    seed();
    hold.state = { phase: 'waiting', session: { id: HS }, stale: false, degraded: false };
    render(<RegisterMode />);
    await addItemAndOpen(user);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    expect(hold.stop).toHaveBeenCalled();
  });

  it('切替 OFF: 受け渡しを作らず、今のレジのまま (fee_kind も今のまま)', async () => {
    const user = userEvent.setup();
    seed();
    hold.on = false;
    render(<RegisterMode />);
    await addItemAndOpen(user);
    const sp = await waitFor(() => {
      const v = shownCheckout();
      if (!v) throw new Error('not yet');
      return v;
    });
    expect(hold.start).not.toHaveBeenCalled();
    expect(sp.get('submit')).toBeNull();
    expect(sp.get('fee_kind')).toBe('register');
  });

  it('Web Locks の無いブラウザでは使えない (理由をパネルに渡し、通常の QR)', async () => {
    Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
    const user = userEvent.setup();
    seed();
    render(<RegisterMode />);
    await addItemAndOpen(user);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    expect(hold.start).not.toHaveBeenCalled();
    expect(hold.panelBlocked).toContain('no_locks');
  });

  it('通常の QR に切り替えられない (前の受け渡しに署名が入っていて端末が送る) なら QR を開かない', async () => {
    const user = userEvent.setup();
    seed(FEE);
    hold.release.mockResolvedValue(false);
    render(<RegisterMode />);
    await addItemAndOpen(user);
    expect(hold.release).toHaveBeenCalled();
    expect(shownCheckout()).toBeNull();
  });

  it('受け取った署名を送っている間は QR のボタンを押せない', async () => {
    seed();
    hold.busy = true;
    render(<RegisterMode />);
    await screen.findByRole('button', { name: /コーヒー/ });
    for (const b of screen.getAllByRole('button', { name: /QRコードを表示する/ })) expect(b).toBeDisabled();
  });

  it('受取先が OpenPay の受取口 (forwarder が revert する) なら使えないと知らせて通常の QR を出す', async () => {
    const user = userEvent.setup();
    seed(FEE);
    render(<RegisterMode />);
    await addItemAndOpen(user);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    expect(hold.start).not.toHaveBeenCalled();
    expect(screen.getByText(/この受取先ではお店の端末で送るを使えません/)).toBeTruthy();
  });

  it('ガス用ウォレットが無ければ知らせて通常の QR を出す', async () => {
    const user = userEvent.setup();
    seed();
    hold.gas = null;
    render(<RegisterMode />);
    await addItemAndOpen(user);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    expect(hold.start).not.toHaveBeenCalled();
    expect(screen.getByText(/ガス用ウォレットが無いため/)).toBeTruthy();
  });
});
