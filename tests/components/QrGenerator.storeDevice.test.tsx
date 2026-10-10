import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';

// 決済QR タブ × 「お店がガス代を肩代わりして送る」(内部名「お店の端末で送る」・flag ON・plans/store-gas-wallet.md §19)。
// 状態は作成ページで 1 つ (useStoreDeviceMode をここでは差し替える)。
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({ data: null, isFetching: false, error: null })),
}));
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
  useReadContract: vi.fn(() => ({ data: undefined })),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useMarketRates', () => ({
  useMarketRates: () => ({
    data: { usdcJpy: 150, updatedAt: '2026-06-03T00:00:00.000Z' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
// envHold.eip3009 = JPYC のガスレスが EIP-3009 relay (= 通常の QR が回収・利用料あり) か。false は Pimlico 経路 (利用料なし)。
const envHold = vi.hoisted(() => ({ eip3009: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableStoreGasWallet: true,
      networkEnv: 'testnet',
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
      get enableJpycEip3009() {
        return envHold.eip3009;
      },
    },
  };
});
// 対象のチェーン = forwarder を設定したチェーン (Amoy・Kairos)。
// fwdHold.none = どのチェーンにも forwarder が無い (無料のガスレス) を再現する。
const fwdHold = vi.hoisted(() => ({ none: false }));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) =>
    !fwdHold.none && (chainId === 80002 || chainId === 1001) ? '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' : null,
}));
// QR の中身 (URL) を読む (お店負担の QR は URL を画面に出さないため)。
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
}));
vi.mock('@/components/StoreGasWalletPanel', () => ({
  StoreGasWalletPanel: () => <div>gas-wallet-panel</div>,
}));
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const sd = vi.hoisted(() => ({
  busy: false,
  enabled: true,
  blocked: null as null | 'no_locks' | 'config',
  gasAddress: '0x0000000000000000000000000000000000000abc' as string | null | undefined,
  state: { phase: 'idle' } as Record<string, unknown>,
  start: vi.fn(),
  stop: vi.fn(),
  releaseForNormal: vi.fn(),
  setOn: vi.fn(),
  pending: false,
}));
vi.mock('@/components/StoreDeviceProvider', () => ({
  useStoreDeviceMode: () => ({
    on: true,
    setOn: sd.setOn,
    gasAddress: sd.gasAddress,
    setGasAddress: vi.fn(),
    chainIds: [80002, 1001],
    blocked: sd.blocked,
    enabled: sd.enabled,
    device: {
      state: sd.state,
      busy: sd.busy,
      start: sd.start,
      stop: sd.stop,
      releaseForNormal: sd.releaseForNormal,
      hasPendingSale: () => sd.pending,
      checkNow: vi.fn(),
      retry: vi.fn(),
      dismiss: vi.fn(),
    },
  }),
}));

import { QrGenerator } from '@/components/QrGenerator';
import { calcCheckoutPayable, parseCheckoutParams } from '@/lib/url';
import { LAST_QR_KEY } from '@/lib/offlineQr';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const KEY = 'openpay:qr-settings:v2';

function seed(over: Record<string, unknown> = {}) {
  window.localStorage.setItem(
    KEY,
    JSON.stringify({ receiver: VALID, token: 'jpyc', chain: 'polygon', payMode: 'gasless', storePays: true, ...over }),
  );
}

async function ready(user: ReturnType<typeof userEvent.setup>, amount = '500') {
  render(<QrGenerator />);
  const input = await screen.findByPlaceholderText('1,000');
  if (amount) await user.type(input, amount);
  return screen.findAllByRole('button', { name: /QRコードを表示する/ });
}

function shownQr() {
  const el = screen.queryByTestId('qr');
  return el ? el.getAttribute('data-value')! : null;
}

describe('QrGenerator × お店の端末で送る (flag ON)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    sd.busy = false;
    sd.enabled = true;
    sd.blocked = null;
    sd.gasAddress = '0x0000000000000000000000000000000000000abc';
    sd.state = { phase: 'idle' };
    sd.start.mockReset().mockResolvedValue({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
    sd.stop.mockReset();
    sd.releaseForNormal.mockReset().mockResolvedValue(true);
    sd.setOn.mockReset();
    sd.pending = false;
  });

  describe('通常の決済モード (お店負担を選んでいない)', () => {
    beforeEach(() => seed({ storePays: false }));

    it('お店の端末が送っている・結果を待っている間は、通常の QR を開かない', async () => {
      const user = userEvent.setup();
      sd.busy = true;
      render(<QrGenerator />);
      await user.type(await screen.findByPlaceholderText('1,000'), '500');
      const btns = await screen.findAllByRole('button', { name: /QRコードを表示する/ });
      for (const b of btns) expect(b).toBeDisabled();
      await user.click(btns[0]);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(sd.releaseForNormal).not.toHaveBeenCalled();
    });

    it('締め切っていない受け渡しに署名が入っていた (端末が送る) → 通常の QR を開かない', async () => {
      const user = userEvent.setup();
      sd.releaseForNormal.mockResolvedValue(false);
      const [btn] = await ready(user);
      await user.click(btn);
      await waitFor(() => expect(sd.releaseForNormal).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('圏外のとき、保存した通常の QR を出す (今までどおり)・送っている間は出さない', async () => {
      window.localStorage.setItem(
        LAST_QR_KEY,
        JSON.stringify({ payUrl: 'https://test.local/pay?to=x', amountLabel: '500 JPYC', tokenChainLabel: 'JPYC · Polygon', ts: 1 }),
      );
      const online = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
      Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
      try {
        const r = render(<QrGenerator />);
        expect(await screen.findByText(/圏外です/)).toBeTruthy();
        sd.busy = true;
        r.rerender(<QrGenerator />);
        expect(screen.queryByText(/圏外です/)).toBeNull();
        // 締め切れなかったお店負担の受け渡しが残っている間も出さない
        sd.busy = false;
        sd.pending = true;
        r.rerender(<QrGenerator />);
        expect(screen.queryByText(/圏外です/)).toBeNull();
        sd.pending = false;
        r.rerender(<QrGenerator />);
        expect(await screen.findByText(/圏外です/)).toBeTruthy();
      } finally {
        if (online) Object.defineProperty(window.navigator, 'onLine', online);
        else delete (window.navigator as { onLine?: boolean }).onLine;
      }
    });

    it('締め切りを待つ間にお店負担へ切り替えたら、通常の QR は出さない', async () => {
      const user = userEvent.setup();
      let resolve!: (v: boolean) => void;
      sd.releaseForNormal.mockReturnValue(new Promise<boolean>((r) => { resolve = r; }));
      const [btn] = await ready(user);
      await user.click(btn);
      // 支払い方法は「お店の設定」シートの中 (2026-10 磨き上げ P2)。
      await user.click(await screen.findByRole('button', { name: /^設定$/ }));
      await user.click(screen.getByRole('button', { name: /お店が\s?ガス代を肩代わり/ }));
      resolve(true);
      await waitFor(() => expect(sd.releaseForNormal).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      // QR の画面は開かない (開いているのはお店の設定シートだけ)。
      expect(screen.queryByRole('dialog', { name: '決済用 QR コード' })).toBeNull();
    });

    it('QR を出す準備の間に設定を開いても、QR が開いたら設定シートは閉じる (dialog を重ねない)', async () => {
      const user = userEvent.setup();
      let resolve!: (v: boolean) => void;
      sd.releaseForNormal.mockReturnValue(new Promise<boolean>((r) => { resolve = r; }));
      const [btn] = await ready(user);
      await user.click(btn);
      await user.click(screen.getByRole('button', { name: /^設定$/ }));
      expect(screen.getByRole('dialog', { name: 'お店の設定' })).toBeTruthy();
      resolve(true);
      expect(await screen.findByRole('dialog', { name: '決済用 QR コード' })).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'お店の設定' })).toBeNull());
    });

    it('受け渡しを締め切れたら (または無ければ) 通常の QR を開く・お店の端末には「使わない」と知らせる', async () => {
      const user = userEvent.setup();
      const [btn] = await ready(user);
      await user.click(btn);
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(sd.start).not.toHaveBeenCalled();
      expect(shownQr()).toMatch(/\/pay\?/);
      expect(sd.setOn).toHaveBeenLastCalledWith(false);
    });
  });

  // 3 枚目のカードの見出しは「お店が<wbr>ガス代を肩代わり」(折り返し位置の指定)。jsdom は <wbr> を名前の空白として
  // 数えるので、名前の照合は空白を許す (実際のブラウザでは空白なし)。
  describe('決済モードの 3 つ目のカード', () => {
    // 支払い方法は「お店の設定」シートの中 (2026-10 磨き上げ P2)。
    async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
      if (screen.queryByRole('dialog', { name: 'お店の設定' })) return;
      await user.click(await screen.findByRole('button', { name: /^設定$/ }));
    }

    it('選ぶと {payMode: gasless, storePays: true}・1 枚目に戻すと storePays は false', async () => {
      const user = userEvent.setup();
      seed({ storePays: false, payMode: 'standard' });
      render(<QrGenerator />);
      await openAdvanced(user);
      await user.click(screen.getByRole('button', { name: /お店が\s?ガス代を肩代わり/ }));
      await waitFor(() => {
        const saved = JSON.parse(window.localStorage.getItem(KEY)!);
        expect(saved.storePays).toBe(true);
        expect(saved.payMode).toBe('gasless');
      });
      expect(screen.getByText(/画面に表示する金額指定の QR だけで使えます/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: /ガス代不要/ }));
      await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).storePays).toBe(false));
    });

    it.each([
      ['polygon', 'POL'],
      ['kaia', 'KAIA'],
    ] as const)('注記: ガス用ウォレットに入れるのは選んでいるチェーンの通貨 (%s → %s)', async (chain, symbol) => {
      const user = userEvent.setup();
      seed({ chain });
      render(<QrGenerator />);
      await openAdvanced(user);
      expect(screen.getByText(new RegExp(`ガス用ウォレット」に ${symbol} を入れてお使いください`))).toBeTruthy();
    });

    it('JPYC・対象チェーン以外では押せない (理由を出す)', async () => {
      const user = userEvent.setup();
      seed({ storePays: false, token: 'usdc', chain: 'base' });
      render(<QrGenerator />);
      await openAdvanced(user);
      const card = screen.getByRole('button', { name: /お店が\s?ガス代を肩代わり/ });
      expect(card).toBeDisabled();
      expect(card).toHaveTextContent(/JPYC・.* のときだけ選べます/);
    });
  });

  describe('お店負担を選んでいる', () => {
    it('受け渡しを作ってから、1 品の /checkout (submit=store&hs=・fee_kind なし) を出す', async () => {
      const user = userEvent.setup();
      seed();
      const [btn] = await ready(user);
      expect(sd.setOn).toHaveBeenLastCalledWith(true);
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      expect(sd.start).toHaveBeenCalledWith(VALID, 500n * 10n ** 18n, 80002);
      const url = new URL(shownQr()!);
      expect(url.pathname).toBe('/checkout');
      expect(url.searchParams.get('submit')).toBe('store');
      expect(url.searchParams.get('hs')).toBe(HS);
      expect(url.searchParams.get('fee_kind')).toBeNull();
      const parsed = parseCheckoutParams(url.searchParams);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.params.items).toEqual([{ name: 'お支払い', qty: 1, price: '500' }]);
      expect(parsed.params.mode).toBe('gasless');
    });

    it('値引きがあれば、受け渡しは値引き後の額・/checkout は値引き前の 1 行 + disc (plans/discount-common.md)', async () => {
      const user = userEvent.setup();
      seed();
      await ready(user, '1000');
      await user.click(screen.getByRole('button', { name: '＋ 値引きを追加' }));
      await user.type(screen.getByLabelText('値引きの金額'), '20');
      const [btn] = screen.getAllByRole('button', { name: /QRコードを表示する/ });
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      expect(sd.start).toHaveBeenCalledWith(VALID, 980n * 10n ** 18n, 80002);
      const parsed = parseCheckoutParams(new URL(shownQr()!).searchParams);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.params.items).toEqual([{ name: 'お支払い', qty: 1, price: '1000' }]);
      expect(parsed.params.discount).toBe('20');
      expect(calcCheckoutPayable(parsed.params, 18)).toBe(980n * 10n ** 18n);
    });

    it('Kaia を選んでいれば、受け渡しも QR も Kaia (QR の写しと同じチェーンで作る)', async () => {
      const user = userEvent.setup();
      seed({ chain: 'kaia' });
      const [btn] = await ready(user);
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      expect(sd.start).toHaveBeenCalledWith(VALID, 500n * 10n ** 18n, 1001);
      const url = new URL(shownQr()!);
      expect(url.searchParams.get('chain')).toBe('kaia');
      expect(parseCheckoutParams(url.searchParams)).toMatchObject({ ok: true, params: { submit: 'store', handoffId: HS } });
    });

    it('商品名・メモ・税率・店名を引き継ぐ', async () => {
      const user = userEvent.setup();
      seed({ productName: 'ランチ', memo: '2 名', taxRate: 10, storeName: 'Cafe' });
      const [btn] = await ready(user, '1200');
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      const parsed = parseCheckoutParams(new URL(shownQr()!).searchParams);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.params.items).toEqual([{ name: 'ランチ', qty: 1, price: '1200', memo: '2 名' }]);
      expect(parsed.params.taxRate).toBe(10);
      expect(parsed.params.storeName).toBe('Cafe');
    });

    it('画面に表示している間だけ使える: 印刷・保存・URL のコピー・URL の表示は出さず、前回の QR にも残さない', async () => {
      const user = userEvent.setup();
      seed();
      const [btn] = await ready(user);
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      for (const name of [/印刷/, /コピー/, /SVG/, /PNG/]) {
        expect(within(screen.getByRole('dialog')).queryByRole('button', { name })).toBeNull();
      }
      expect(screen.queryByText(/\/checkout\?/)).toBeNull();
      expect(screen.getByText(/この QR は画面に表示している間だけ使えます/)).toBeTruthy();
      // 会計画面の要約にも同じ語が出るので、QR の画面の中で照合する。
      expect(within(screen.getByRole('dialog', { name: '決済用 QR コード' })).getByText('ガス代はお店が負担')).toBeTruthy();
      // 端末が通信して送るので「圏外でも提示できます」は出さない
      expect(screen.queryByText(/圏外でも/)).toBeNull();
      expect(window.localStorage.getItem(LAST_QR_KEY)).toBeNull();
    });

    it('閉じたら受け渡しを締め切る', async () => {
      const user = userEvent.setup();
      seed();
      const [btn] = await ready(user);
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: /閉じる/ })[0]);
      expect(sd.stop).toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('受け渡しを作れなければ QR を開かない (黙って通常の QR にしない)', async () => {
      const user = userEvent.setup();
      seed();
      sd.start.mockResolvedValue(null);
      const [btn] = await ready(user);
      await user.click(btn);
      await waitFor(() => expect(sd.start).toHaveBeenCalled());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('受け渡しを作る間に金額を変えたら、その QR は出さずに締め切る (請求額の違う QR を出さない)', async () => {
      const user = userEvent.setup();
      seed();
      let resolve!: (v: unknown) => void;
      sd.start.mockReturnValue(new Promise((r) => { resolve = r; }));
      const [btn] = await ready(user);
      await user.click(btn);
      await user.type(screen.getByPlaceholderText('1,000'), '0'); // 500 → 5000
      resolve({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
      await waitFor(() => expect(sd.stop).toHaveBeenCalled());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('受け渡しを作る間に金額なしへ切り替えても、通常の QR を黙って出さない', async () => {
      const user = userEvent.setup();
      seed();
      let resolve!: (v: unknown) => void;
      sd.start.mockReturnValue(new Promise((r) => { resolve = r; }));
      const [btn] = await ready(user);
      await user.click(btn);
      await user.click(screen.getByRole('button', { name: /据え置き/ }));
      resolve({ id: HS, token: 'ab'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
      await waitFor(() => expect(sd.stop).toHaveBeenCalled());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('出し直しの途中で閉じたら、遅れて返った受け渡しで QR を開き直さない (締め切る)', async () => {
      const user = userEvent.setup();
      seed();
      sd.state = { phase: 'expired' };
      const [btn] = await ready(user);
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      let resolve!: (v: unknown) => void;
      sd.start.mockReturnValue(new Promise((r) => { resolve = r; }));
      // 状態の表示は遅延読み込み (お店負担を選んだときだけ) なので現れるのを待つ
      await user.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'QR を出し直す' }));
      await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: /閉じる/ })[0]);
      expect(screen.queryByRole('dialog')).toBeNull();
      const stopsBefore = sd.stop.mock.calls.length;
      resolve({ id: 'ZzZzZzZzZzZzZzZzZzZzZz', token: 'cd'.repeat(32), expiresAt: 0, merchant: VALID, amount: '1', chainId: 80002 });
      await waitFor(() => expect(sd.stop.mock.calls.length).toBeGreaterThan(stopsBefore));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('「通常の QR を出す」の締め切り待ちの途中で閉じたら、開き直さない', async () => {
      const user = userEvent.setup();
      seed();
      sd.state = { phase: 'waiting', session: { id: HS }, stale: false, degraded: true };
      const [btn] = await ready(user);
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      let resolve!: (v: boolean) => void;
      sd.releaseForNormal.mockReturnValue(new Promise<boolean>((r) => { resolve = r; }));
      await user.click(await within(screen.getByRole('dialog')).findByRole('button', { name: '通常の QR を出す' }));
      await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: /閉じる/ })[0]);
      resolve(true);
      await waitFor(() => expect(sd.releaseForNormal).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('この QR の受け渡しが署名を待っている間だけはっきり出し、出し直しの途中は薄くする', async () => {
      const user = userEvent.setup();
      seed();
      sd.state = { phase: 'waiting', session: { id: HS }, stale: false, degraded: false };
      const r = render(<QrGenerator />);
      await user.type(await screen.findByPlaceholderText('1,000'), '500');
      await user.click((await screen.findAllByRole('button', { name: /QRコードを表示する/ }))[0]);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      const wrapper = () => screen.getByTestId('qr').parentElement!;
      expect(wrapper().className).not.toMatch(/opacity-40/);
      sd.state = { phase: 'creating' };
      r.rerender(<QrGenerator />);
      expect(wrapper().className).toMatch(/opacity-40/);
      sd.state = { phase: 'waiting', session: { id: 'ZzZzZzZzZzZzZzZzZzZzZz' }, stale: false, degraded: false };
      r.rerender(<QrGenerator />);
      expect(wrapper().className).toMatch(/opacity-40/); // 別の受け渡しの「署名待ち」ではこの QR をはっきり出さない
    });

    it('作れなかったときは、店員が選んで通常の QR を出せる (モーダルの外に出す)', async () => {
      const user = userEvent.setup();
      seed();
      sd.state = { phase: 'create_failed', reason: 'unavailable' };
      sd.start.mockResolvedValue(null);
      const [btn] = await ready(user);
      // お店負担の QR を出すつもりの間は、利用料の開示を出さない (利用料 0 円の経路)。
      expect(screen.queryByText(/決済手数料/)).toBeNull();
      await user.click(btn);
      expect(screen.queryByRole('dialog')).toBeNull();
      // 作れなかった理由に、通常の QR は利用料 (店舗負担) がかかることを添える。
      expect(await screen.findByText('通常の QR は OpenPay 利用料が店舗負担でかかります。')).toBeInTheDocument();
      await user.click(await screen.findByRole('button', { name: '通常の QR を出す' }));
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(sd.releaseForNormal).toHaveBeenCalled();
      expect(shownQr()).toMatch(/\/pay\?/);
      // 出した QR は回収 (利用料・店舗負担) なので、QR の画面の中で開示する (第 7 回レビュー D4・裏に隠さない)。
      expect(within(screen.getByRole('dialog')).getByText(/決済手数料/)).toBeInTheDocument();
    });

    it('作れなかった後に USDC の会計になったら、通常の QR に利用料の一文を付けない (USDC には OpenPay の利用料が無い)', async () => {
      const user = userEvent.setup();
      seed({ token: 'usdc', chain: 'base' });
      sd.state = { phase: 'create_failed', reason: 'unavailable' };
      render(<QrGenerator />);
      await user.type(await screen.findByPlaceholderText('10.00'), '5');
      expect(await screen.findByRole('button', { name: '通常の QR を出す' })).toBeTruthy();
      expect(screen.queryByText('通常の QR は OpenPay 利用料が店舗負担でかかります。')).toBeNull();
    });

    // Fable 最終監査 (#758) の持ち越し: 利用料の一文は開示 (RecoverFeeNotice) と同じ条件 (JPYC かつ forwarder あり)。
    // forwarder の無いチェーンの JPYC の通常の QR は無料のガスレスなので「利用料がかかります」と言わない。
    it('JPYC でも forwarder の無いチェーンなら、通常の QR に利用料の一文を付けない', async () => {
      const user = userEvent.setup();
      fwdHold.none = true;
      try {
        seed();
        sd.state = { phase: 'create_failed', reason: 'unavailable' };
        render(<QrGenerator />);
        await user.type(await screen.findByPlaceholderText('1,000'), '5');
        expect(await screen.findByRole('button', { name: '通常の QR を出す' })).toBeTruthy();
        expect(screen.queryByText('通常の QR は OpenPay 利用料が店舗負担でかかります。')).toBeNull();
      } finally {
        fwdHold.none = false;
      }
    });

    // forwarder があっても EIP-3009 relay が無効なら、支払いは Pimlico 経路で回収しない (利用料なし)。
    it('forwarder があっても EIP-3009 relay が無効なら、通常の QR に利用料の一文を付けない', async () => {
      const user = userEvent.setup();
      envHold.eip3009 = false;
      try {
        seed();
        sd.state = { phase: 'create_failed', reason: 'unavailable' };
        render(<QrGenerator />);
        await user.type(await screen.findByPlaceholderText('1,000'), '5');
        expect(await screen.findByRole('button', { name: '通常の QR を出す' })).toBeTruthy();
        expect(screen.queryByText('通常の QR は OpenPay 利用料が店舗負担でかかります。')).toBeNull();
        // 通常の QR に切り替えても、回収の開示 (決済手数料) は QR の画面にも会計の画面にも出さない (recoverBillAmount)。
        await user.click(screen.getByRole('button', { name: '通常の QR を出す' }));
        expect(await screen.findByRole('dialog')).toBeTruthy();
        expect(shownQr()).toMatch(/\/pay\?/);
        expect(screen.queryByText(/決済手数料/)).toBeNull();
      } finally {
        envHold.eip3009 = true;
      }
    });

    it('作れなかった後でも、金額を消したら「通常の QR を出す」は出さない (後の入力で QR が勝手に開かない)', async () => {
      const user = userEvent.setup();
      seed();
      sd.state = { phase: 'create_failed', reason: 'unavailable' };
      await ready(user);
      expect(await screen.findByRole('button', { name: '通常の QR を出す' })).toBeTruthy();
      await user.clear(screen.getByPlaceholderText('1,000'));
      expect(screen.queryByRole('button', { name: '通常の QR を出す' })).toBeNull();
      // 金額を入れ直しても、押していない QR は開かない。
      await user.type(screen.getByPlaceholderText('1,000'), '5');
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('dialog', { name: '決済用 QR コード' })).toBeNull();
    });

    it('作れなかった後の「通常の QR を出す」の締め切り待ちの間に金額を変えたら、開かない', async () => {
      const user = userEvent.setup();
      seed();
      sd.state = { phase: 'create_failed', reason: 'unavailable' };
      let resolve!: (v: boolean) => void;
      sd.releaseForNormal.mockReturnValue(new Promise<boolean>((r) => { resolve = r; }));
      await ready(user);
      await user.click(await screen.findByRole('button', { name: '通常の QR を出す' }));
      await user.type(screen.getByPlaceholderText('1,000'), '0'); // 500 → 5000
      resolve(true);
      await waitFor(() => expect(sd.releaseForNormal).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('圏外のときも、お店負担を選んでいる間は保存した通常の QR を出さない', async () => {
      seed();
      window.localStorage.setItem(
        LAST_QR_KEY,
        JSON.stringify({ payUrl: 'https://test.local/pay?to=x', amountLabel: '500 JPYC', tokenChainLabel: 'JPYC · Polygon', ts: 1 }),
      );
      const online = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
      Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
      try {
        render(<QrGenerator />);
        await screen.findByPlaceholderText('1,000');
        expect(screen.queryByText(/圏外です/)).toBeNull();
      } finally {
        if (online) Object.defineProperty(window.navigator, 'onLine', online);
        else delete (window.navigator as { onLine?: boolean }).onLine;
      }
    });

    it('ガス用ウォレットのパネルを出す', async () => {
      seed();
      render(<QrGenerator />);
      expect(await screen.findByText('gas-wallet-panel')).toBeTruthy();
    });

    it.each([
      ['金額なし (据え置き)', 'static', /金額ありの QR だけで使えます/],
      ['ガス用ウォレットなし', 'no_wallet', /ガス用ウォレットがありません/],
      ['Web Locks なし', 'no_locks', /このブラウザでは使えません/],
      ['受取先が OpenPay の受取口', 'receiver', /この受取先では使えません/],
    ])('%s: 「QRコードを表示する」を押せなくして理由を出す', async (_label, kind, reason) => {
      const user = userEvent.setup();
      seed(kind === 'receiver' ? { receiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560' } : {});
      if (kind === 'no_wallet') sd.gasAddress = null;
      if (kind === 'no_locks') sd.blocked = 'no_locks';
      render(<QrGenerator />);
      await screen.findByPlaceholderText('1,000');
      if (kind === 'static') {
        await user.click(screen.getByRole('button', { name: /据え置き/ }));
      } else {
        await user.type(screen.getByPlaceholderText('1,000'), '500');
      }
      const btns = await screen.findAllByRole('button', { name: /QRコードを表示する/ });
      for (const b of btns) expect(b).toBeDisabled();
      expect(screen.getByText(reason)).toBeTruthy();
      expect(sd.start).not.toHaveBeenCalled();
    });

    it('1 JPYC 未満は使えない', async () => {
      const user = userEvent.setup();
      seed();
      const btns = await ready(user, '0.5');
      for (const b of btns) expect(b).toBeDisabled();
      expect(screen.getByText(/1 JPYC 未満の会計では使えません/)).toBeTruthy();
    });

    it('USDC では使えない (設定は消さず、理由を出す)', async () => {
      const user = userEvent.setup();
      seed({ token: 'usdc', chain: 'base' });
      render(<QrGenerator />);
      await user.type(await screen.findByRole('textbox', { name: /請求金額/ }), '5');
      const btns = await screen.findAllByRole('button', { name: /QRコードを表示する/ });
      for (const b of btns) expect(b).toBeDisabled();
      expect(screen.getByText(/JPYC・.* のときだけです/)).toBeTruthy();
      expect(JSON.parse(window.localStorage.getItem(KEY)!).storePays).toBe(true);
      // 選んでいる状態は保つ (送る設定は OFF にしない = 送れなかった支払いの「もう一度送る」を消さない)
      expect(sd.setOn).toHaveBeenLastCalledWith(true);
    });
  });

  // 第 7 回レビュー G1 (Codex P1): 受取先の名前 (shop.eth 等) は QrGenerator 自身が解決結果を常時見る。設定シートを
  // 閉じて AddressInput が消えた後に再解決が失敗しても (react-query は前回の data を残す)、前回の解決結果で
  // 通常の QR もお店負担の受け渡し (device.start) も作らない。
  describe('受取先の名前 (ENS) の再解決に失敗している間', () => {
    const ens = { data: null as unknown, error: null as Error | null, isFetching: false };
    beforeEach(async () => {
      ens.data = { address: VALID, name: 'shop.eth' };
      ens.error = null;
      ens.isFetching = false;
      const { useResolveAddress } = await import('@/hooks/useResolveAddress');
      vi.mocked(useResolveAddress).mockImplementation(
        (input: string) => (input ? { ...ens } : { data: null, isFetching: false, error: null }) as never,
      );
    });
    afterEach(async () => {
      // 既定 (未解決) に戻して、ほかのテストに解決結果を漏らさない
      const { useResolveAddress } = await import('@/hooks/useResolveAddress');
      vi.mocked(useResolveAddress).mockImplementation(() => ({ data: null, isFetching: false, error: null }) as never);
    });

    // 解決成功 → 設定シートを開く (再解決の開始) → 「完了」で閉じる (AddressInput が消える) → 再解決の失敗 (data は残る)。
    async function resolveThenFailAfterSheetClosed(user: ReturnType<typeof userEvent.setup>) {
      await ready(user);
      await user.click(screen.getByRole('button', { name: /^設定$/ }));
      const sheet = await screen.findByRole('dialog', { name: 'お店の設定' });
      ens.isFetching = true;
      await user.click(within(sheet).getByRole('button', { name: '完了' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'お店の設定' })).toBeNull());
      ens.isFetching = false;
      ens.error = new Error('rpc down');
      // 再描画のきっかけ (会計の金額を打ち足す)
      await user.type(screen.getByPlaceholderText('1,000'), '0');
      return screen.getAllByRole('button', { name: /QRコードを表示する/ });
    }

    it('解決できていれば、解決したアドレスで受け渡しを作り QR を出す', async () => {
      const user = userEvent.setup();
      seed({ receiver: 'shop.eth' });
      const [btn] = await ready(user);
      await user.click(btn);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      expect(sd.start).toHaveBeenCalledWith(VALID, 500n * 10n ** 18n, 80002);
      expect(new URL(shownQr()!).searchParams.get('to')?.toLowerCase()).toBe(VALID.toLowerCase());
    });

    it('お店負担: 前回の解決結果が残っていても受け渡し (device.start) を作らず QR も出さない', async () => {
      const user = userEvent.setup();
      seed({ receiver: 'shop.eth' });
      const btns = await resolveThenFailAfterSheetClosed(user);
      for (const b of btns) expect(b).toBeDisabled();
      await user.click(btns[0]);
      expect(sd.start).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('通常の QR: 前回の解決結果が残っていても QR を出さない', async () => {
      const user = userEvent.setup();
      seed({ receiver: 'shop.eth', storePays: false });
      const btns = await resolveThenFailAfterSheetClosed(user);
      for (const b of btns) expect(b).toBeDisabled();
      await user.click(btns[0]);
      expect(sd.releaseForNormal).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Codex 再レビュー P1: QR を出した後に再解決が失敗したら、画面から消えるだけ (qrModalOpen・storeQr・受け渡しが残る)
    // にせず「閉じる」と同じ終了処理を通す。残すと、受取先を B に直した瞬間に A 宛の受け渡しの QR が勝手に出直る。
    const OTHER = '0x1111111111111111111111111111111111111111';
    async function openThenFail(user: ReturnType<typeof userEvent.setup>) {
      const r = render(<QrGenerator />);
      await user.type(await screen.findByPlaceholderText('1,000'), '500');
      await user.click((await screen.findAllByRole('button', { name: /QRコードを表示する/ }))[0]);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      // 再解決の失敗 (react-query は前回の data を残す)
      ens.error = new Error('rpc down');
      r.rerender(<QrGenerator />);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    async function changeReceiverTo(user: ReturnType<typeof userEvent.setup>, addr: string) {
      // 解決できていないので会計画面に受取先の欄が出る → そこで直す
      const field = await screen.findByPlaceholderText(/0x\.\.\./);
      await user.clear(field);
      await user.paste(addr);
      await new Promise((r) => setTimeout(r, 0));
    }

    it('お店負担: QR を出した後に再解決が失敗したら受け渡しを締め切り、受取先を B に直しても A 宛の QR を出し直さない', async () => {
      const user = userEvent.setup();
      seed({ receiver: 'shop.eth' });
      await openThenFail(user);
      expect(sd.start).toHaveBeenCalledTimes(1);
      // 閉じたときと同じ終了処理 (受け渡しの締め切りは 1 回だけ)
      await waitFor(() => expect(sd.stop).toHaveBeenCalledTimes(1));
      await changeReceiverTo(user, OTHER);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(shownQr()).toBeNull();
      expect(sd.start).toHaveBeenCalledTimes(1);
      expect(sd.stop).toHaveBeenCalledTimes(1);
      // 押し直したら B 宛で新しい受け渡しを作る (正常時の順序は変えない)
      await user.click(screen.getAllByRole('button', { name: /QRコードを表示する/ })[0]);
      await waitFor(() => expect(shownQr()).not.toBeNull());
      expect(sd.start).toHaveBeenLastCalledWith(OTHER, 500n * 10n ** 18n, 80002);
      expect(new URL(shownQr()!).searchParams.get('to')?.toLowerCase()).toBe(OTHER.toLowerCase());
    });

    it('通常の QR: 出した後に再解決が失敗したら閉じ、受取先を直しても勝手に開き直さない', async () => {
      const user = userEvent.setup();
      seed({ receiver: 'shop.eth', storePays: false });
      await openThenFail(user);
      expect(sd.releaseForNormal).toHaveBeenCalledTimes(1);
      await changeReceiverTo(user, OTHER);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(shownQr()).toBeNull();
      // 受け渡しは無いので締め切るものがない・押し直すまで開かない
      expect(sd.stop).not.toHaveBeenCalled();
      expect(sd.releaseForNormal).toHaveBeenCalledTimes(1);
    });
  });
});
