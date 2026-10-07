import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
  gas: '0x0000000000000000000000000000000000000abc' as string | null,
  state: { phase: 'idle' } as Record<string, unknown>,
  start: vi.fn(),
  stop: vi.fn(),
  release: vi.fn(),
  busy: false,
  dismiss: vi.fn(),
}));
// QR の中身 (URL) を読む (お店負担の QR は URL を画面に出さないため)。
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
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
  StoreGasWalletPanel: ({ onAddressChange }: { onAddressChange?: (a: string | null) => void }) => {
    useEffect(() => {
      onAddressChange?.(hold.gas);
    }, [onAddressChange]);
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

// 決済モードの 3 つ目 (お店がガス代を肩代わり) は決済QRタブで選び、レジは引き継ぐ。
function seed(receiver = VALID, storePays = true) {
  window.localStorage.setItem(
    'openpay:qr-settings:v2',
    JSON.stringify({ receiver, token: 'jpyc', chain: 'polygon', payMode: 'gasless', storePays }),
  );
}

async function addItemAndOpen(user: ReturnType<typeof userEvent.setup>, cta: RegExp = /QRコードを表示する/) {
  await user.click(await screen.findByRole('button', { name: /コーヒー/ }));
  const btns = await screen.findAllByRole('button', { name: cta });
  await user.click(btns[0]);
}

function shownCheckout() {
  const el = screen.queryByTestId('qr');
  return el ? new URL(el.getAttribute('data-value')!).searchParams : null;
}

describe('RegisterMode × お店の端末で送る (flag ON)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hold.registerFee = true;
    hold.gas = '0x0000000000000000000000000000000000000abc';
    hold.state = { phase: 'idle' };
    hold.start.mockReset().mockResolvedValue({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
    hold.stop.mockReset();
    hold.release.mockReset().mockResolvedValue(true);
    hold.busy = false;
    hold.dismiss.mockReset();
    Object.defineProperty(window.navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  });
  afterEach(() => {
    Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
  });

  it('お店負担を選んでいる: QR を出すときに受け渡しを作り、QR は submit=store&hs= (fee_kind は付けない・URL は出さない)', async () => {
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
    expect(screen.getAllByText('お店がガス代を肩代わり（利用料 0 円）').length).toBeGreaterThan(0);
    expect(screen.getByText('お客様の署名を待っています')).toBeTruthy();
    // 画面に表示している間だけ使える QR: URL の表示とコピーは出さない
    expect(screen.queryByText(/\/checkout\?/)).toBeNull();
    expect(screen.queryByRole('button', { name: /URL をコピー|コピー/ })).toBeNull();
    expect(screen.getByText(/この QR は画面に表示している間だけ使えます/)).toBeTruthy();
    expect(screen.queryByText(/圏外でも/)).toBeNull();
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

  it('お店負担を選んでいない: 受け渡しを作らず、今のレジのまま (fee_kind も今のまま)', async () => {
    const user = userEvent.setup();
    seed(VALID, false);
    render(<RegisterMode />);
    await addItemAndOpen(user);
    const sp = await waitFor(() => {
      const v = shownCheckout();
      if (!v) throw new Error('not yet');
      return v;
    });
    expect(hold.start).not.toHaveBeenCalled();
    // 切替 OFF でも、通常の QR の前に切替 ON の頃の受け渡しを片付ける (遅れて署名を送らない)
    expect(hold.release).toHaveBeenCalled();
    expect(sp.get('submit')).toBeNull();
    expect(sp.get('fee_kind')).toBe('register');
  });

  it('Web Locks の無いブラウザでは使えない (理由を出し、店員が「通常の QR を出す」を選ぶ)', async () => {
    Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
    const user = userEvent.setup();
    seed();
    render(<RegisterMode />);
    await addItemAndOpen(user, /通常の QR を出す/);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    expect(hold.start).not.toHaveBeenCalled();
    expect(shownCheckout()!.get('submit')).toBeNull();
    expect(screen.getByText(/このブラウザではガス代の肩代わりを使えません/)).toBeTruthy();
  });

  it('通常の QR に切り替えられない (前の受け渡しに署名が入っていて端末が送る) なら QR を開かない', async () => {
    const user = userEvent.setup();
    seed(FEE);
    hold.release.mockResolvedValue(false);
    render(<RegisterMode />);
    await addItemAndOpen(user, /通常の QR を出す/);
    expect(hold.release).toHaveBeenCalled();
    expect(shownCheckout()).toBeNull();
  });

  it('閉じた後の「受付時間が終わりました」から出し直すと、新しい QR を開く', async () => {
    const user = userEvent.setup();
    seed();
    hold.state = { phase: 'expired' };
    render(<RegisterMode />);
    await user.click(await screen.findByRole('button', { name: /コーヒー/ }));
    await user.click(await screen.findByRole('button', { name: 'QR を出し直す' }));
    expect(hold.start).toHaveBeenCalledWith(VALID, 500n * 10n ** 18n);
    await waitFor(() => expect(shownCheckout()?.get('hs')).toBe(HS));
  });

  it('出し直しの途中で閉じたら、遅れて返った受け渡しで QR を開き直さない (締め切る)', async () => {
    const user = userEvent.setup();
    seed();
    hold.state = { phase: 'expired' };
    render(<RegisterMode />);
    await addItemAndOpen(user);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    let resolve!: (v: unknown) => void;
    hold.start.mockReturnValue(new Promise((r) => { resolve = r; }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'QR を出し直す' }));
    await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: /閉じる/ })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
    const stopsBefore = hold.stop.mock.calls.length;
    resolve({ id: 'ZzZzZzZzZzZzZzZzZzZzZz', token: 'cd'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
    await waitFor(() => expect(hold.stop.mock.calls.length).toBeGreaterThan(stopsBefore));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('「通常の QR を出す」の締め切り待ちの途中で閉じたら、開き直さない', async () => {
    const user = userEvent.setup();
    seed();
    hold.state = { phase: 'waiting', session: { id: HS }, stale: false, degraded: true };
    render(<RegisterMode />);
    await addItemAndOpen(user);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    let resolve!: (v: boolean) => void;
    hold.release.mockReturnValue(new Promise<boolean>((r) => { resolve = r; }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '通常の QR を出す' }));
    await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: /閉じる/ })[0]);
    resolve(true);
    await waitFor(() => expect(hold.release).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('受け渡しを作る間にカートを変えたら、その QR は出さずに締め切る (請求額の違う QR・黙って通常の QR を出さない)', async () => {
    const user = userEvent.setup();
    seed();
    let resolve!: (v: unknown) => void;
    hold.start.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<RegisterMode />);
    await addItemAndOpen(user);
    await user.click(await screen.findByRole('button', { name: /コーヒー/ })); // 500 → 1000
    resolve({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
    await waitFor(() => expect(hold.stop).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('受け取った署名を送っている間は QR のボタンを押せない', async () => {
    seed();
    hold.busy = true;
    render(<RegisterMode />);
    await screen.findByRole('button', { name: /コーヒー/ });
    for (const b of screen.getAllByRole('button', { name: /QRコードを表示する/ })) expect(b).toBeDisabled();
  });

  it('受取先が OpenPay の受取口 (forwarder が revert する) なら使えないと知らせ、店員が通常の QR を選ぶ', async () => {
    const user = userEvent.setup();
    seed(FEE);
    render(<RegisterMode />);
    await addItemAndOpen(user, /通常の QR を出す/);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    expect(hold.start).not.toHaveBeenCalled();
    expect(screen.getByText(/この受取先ではガス代の肩代わりを使えません/)).toBeTruthy();
  });

  it('ガス用ウォレットが無ければ知らせ、店員が通常の QR を選ぶ', async () => {
    const user = userEvent.setup();
    seed();
    hold.gas = null;
    render(<RegisterMode />);
    await addItemAndOpen(user, /通常の QR を出す/);
    await waitFor(() => expect(shownCheckout()).not.toBeNull());
    expect(hold.start).not.toHaveBeenCalled();
    expect(screen.getByText(/ガス用ウォレットが無いため/)).toBeTruthy();
  });

  it('お店負担を選んでいて USDC の会計なら理由を出す (設定は消さない)', async () => {
    seed();
    const raw = JSON.parse(window.localStorage.getItem('openpay:qr-settings:v2')!);
    window.localStorage.setItem('openpay:qr-settings:v2', JSON.stringify({ ...raw, token: 'usdc', chain: 'base' }));
    render(<RegisterMode />);
    expect(await screen.findByText(/この会計ではガス代の肩代わりを使えません/)).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('openpay:qr-settings:v2')!).storePays).toBe(true);
  });
});
