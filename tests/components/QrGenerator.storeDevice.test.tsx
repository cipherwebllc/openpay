import { describe, it, expect, beforeEach, vi } from 'vitest';
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
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableStoreGasWallet: true,
      networkEnv: 'testnet',
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
    },
  };
});
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
    chainId: 80002,
    deployment: { decimals: 18, displaySymbol: 'JPYC' },
    forwarder: '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
    feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
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
import { parseCheckoutParams } from '@/lib/url';
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
  const input = await screen.findByPlaceholderText('1000');
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
      const [btn] = await ready(user);
      await user.click(btn);
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
      const toggle = await screen.findByRole('button', { name: /高度な設定/ });
      if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /お店が\s?ガス代を肩代わり/ }));
      resolve(true);
      await waitFor(() => expect(sd.releaseForNormal).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('dialog')).toBeNull();
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
    async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
      const toggle = await screen.findByRole('button', { name: /高度な設定/ });
      if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
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
      expect(sd.start).toHaveBeenCalledWith(VALID, 500n * 10n ** 18n);
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
      expect(screen.getByText('ガス代はお店が負担')).toBeTruthy();
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
      await user.type(screen.getByPlaceholderText('1000'), '0'); // 500 → 5000
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
      await user.type(await screen.findByPlaceholderText('1000'), '500');
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
      await user.click(btn);
      expect(screen.queryByRole('dialog')).toBeNull();
      await user.click(await screen.findByRole('button', { name: '通常の QR を出す' }));
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(sd.releaseForNormal).toHaveBeenCalled();
      expect(shownQr()).toMatch(/\/pay\?/);
    });

    it('作れなかった後の「通常の QR を出す」の締め切り待ちの間に金額を変えたら、開かない', async () => {
      const user = userEvent.setup();
      seed();
      sd.state = { phase: 'create_failed', reason: 'unavailable' };
      let resolve!: (v: boolean) => void;
      sd.releaseForNormal.mockReturnValue(new Promise<boolean>((r) => { resolve = r; }));
      await ready(user);
      await user.click(await screen.findByRole('button', { name: '通常の QR を出す' }));
      await user.type(screen.getByPlaceholderText('1000'), '0'); // 500 → 5000
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
        await screen.findByPlaceholderText('1000');
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
      await screen.findByPlaceholderText('1000');
      if (kind === 'static') {
        await user.click(screen.getByRole('button', { name: /据え置き/ }));
      } else {
        await user.type(screen.getByPlaceholderText('1000'), '500');
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
      expect(sd.setOn).toHaveBeenLastCalledWith(false);
    });
  });
});
