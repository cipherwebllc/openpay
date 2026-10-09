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
  await user.click(await findTile(/コーヒー/));
  const btns = await screen.findAllByRole('button', { name: cta });
  await user.click(btns[0]);
}

function shownCheckout() {
  const el = screen.queryByTestId('qr');
  return el ? new URL(el.getAttribute('data-value')!).searchParams : null;
}


// 2026-10 磨き上げ P3: カートの行にも商品名のボタン (詳細の開閉) があるので、商品のタイルは「商品」の区切りの中で探す。
function tiles() {
  return within(screen.getByRole('region', { name: /^(商品|Products)$/ }));
}
async function findTile(name: RegExp) {
  const region = await screen.findByRole('region', { name: /^(商品|Products)$/ });
  return within(region).findByRole('button', { name });
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
    expect(hold.start).toHaveBeenCalledWith(VALID, 500n * 10n ** 18n, 80002);
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

  it('値引きを付けた会計: 受け渡しの額も QR の disc も値引き後 (500 − 20 = 480)', async () => {
    const user = userEvent.setup();
    seed();
    hold.state = { phase: 'waiting', session: { id: HS }, stale: false, degraded: false };
    render(<RegisterMode />);
    await waitFor(() => screen.getAllByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getAllByRole('button', { name: /コーヒー/ })[0]);
    await user.click(screen.getByRole('button', { name: '＋ 値引きを追加' }));
    await user.type(screen.getByLabelText('値引きの金額'), '20');
    await user.click(screen.getAllByRole('button', { name: /QRコードを表示する/ })[0]);
    await waitFor(() => expect(hold.start).toHaveBeenCalledWith(VALID, 480n * 10n ** 18n, 80002));
    const sp = await waitFor(() => {
      const v = shownCheckout();
      if (!v) throw new Error('not yet');
      return v;
    });
    expect(sp.get('disc')).toBe('20');
    expect(sp.get('submit')).toBe('store');
  });

  it('値引きを直している途中 (小計以上) は「通常の QR を出す」を出さない (直した瞬間に途中の額の QR が開かない)', async () => {
    const user = userEvent.setup();
    seed();
    hold.state = { phase: 'create_failed', reason: 'network' };
    render(<RegisterMode />);
    await waitFor(() => screen.getAllByRole('button', { name: /コーヒー/ }));
    await user.click(screen.getAllByRole('button', { name: /コーヒー/ })[0]);
    expect(screen.getByRole('button', { name: '通常の QR を出す' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '＋ 値引きを追加' }));
    await user.type(screen.getByLabelText('値引きの金額'), '500');
    expect(screen.queryByRole('button', { name: '通常の QR を出す' })).toBeNull();
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

  it('作れなかった理由には、JPYC の通常の QR は利用料 (店舗負担) がかかることを添える・USDC には添えない', async () => {
    seed();
    hold.state = { phase: 'create_failed', reason: 'unavailable' };
    const view = render(<RegisterMode />);
    expect(await screen.findByText('ガス代を肩代わりする QR を作れませんでした。通常の QR を出してください。')).toBeTruthy();
    expect(screen.queryByText('通常の QR は OpenPay 利用料が店舗負担でかかります。')).toBeNull(); // カートが空 = 通常の QR を出せない間は出さない
    view.unmount();
    const raw = JSON.parse(window.localStorage.getItem('openpay:qr-settings:v2')!);
    window.localStorage.setItem('openpay:qr-settings:v2', JSON.stringify({ ...raw, token: 'usdc', chain: 'base' }));
    render(<RegisterMode />);
    expect(await screen.findByText('ガス代を肩代わりする QR を作れませんでした。通常の QR を出してください。')).toBeTruthy();
    expect(screen.queryByText(/OpenPay 利用料/)).toBeNull();
    hold.state = { phase: 'idle' };
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

  it('ガス用ウォレットの枠は「お店がガス代を肩代わりして送る」を選んでいるときだけ出す (決済QR と同じ)', async () => {
    seed(VALID, true);
    const first = render(<RegisterMode />);
    await findTile(/コーヒー/);
    expect(await screen.findByText('gas-wallet-panel')).toBeTruthy();
    first.unmount();
    seed(VALID, false);
    render(<RegisterMode />);
    await findTile(/コーヒー/);
    expect(screen.queryByText('gas-wallet-panel')).toBeNull();
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
    await user.click(await findTile(/コーヒー/));
    await user.click(await screen.findByRole('button', { name: 'QR を出し直す' }));
    expect(hold.start).toHaveBeenCalledWith(VALID, 500n * 10n ** 18n, 80002);
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
    await user.click(await findTile(/コーヒー/)); // 500 → 1000
    resolve({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
    await waitFor(() => expect(hold.stop).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('受け取った署名を送っている間は QR のボタンを押せない', async () => {
    seed();
    hold.busy = true;
    render(<RegisterMode />);
    await findTile(/コーヒー/);
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
    // JPYC の通常の QR は回収 (OpenPay 利用料・店舗負担) なので、その旨を添える (第 7 回レビュー D4)。
    expect(screen.getByText(/OpenPay 利用料は店舗負担でかかります/)).toBeTruthy();
  });

  it('お店負担を選んでいて USDC の会計なら理由を出す (設定は消さない)', async () => {
    seed();
    const raw = JSON.parse(window.localStorage.getItem('openpay:qr-settings:v2')!);
    window.localStorage.setItem('openpay:qr-settings:v2', JSON.stringify({ ...raw, token: 'usdc', chain: 'base' }));
    render(<RegisterMode />);
    expect(await screen.findByText(/この会計ではガス代の肩代わりを使えません/)).toBeTruthy();
    // USDC の通常の QR には OpenPay の利用料がかからないので、利用料の一文は付けない。
    expect(screen.queryByText(/OpenPay 利用料/)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('openpay:qr-settings:v2')!).storePays).toBe(true);
  });
});
