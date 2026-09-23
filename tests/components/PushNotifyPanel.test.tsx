import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { renderWithIntl } from '../_helpers/i18n';

// env / SIWE / PWA display mode / platform を hoisted な可変ホルダで mock し、各 test で
// 状態を差し替える。ブラウザ push API (serviceWorker / PushManager / Notification / fetch) は
// beforeEach で stub する。実 push 保存は route/store test (push-subscribe/pushStore) で担保。
const h = vi.hoisted(() => ({
  enablePushNotify: true,
  pushVapidPublicKey: 'BPublicKeyBase64Url',
  sessionAddress: '0x1111111111111111111111111111111111111111',
  isSignedIn: true,
  isConnected: true,
  signIn: undefined as ReturnType<typeof vi.fn> | undefined,
  isStandalone: false,
  platform: 'other' as 'ios' | 'android' | 'other',
}));

vi.mock('@/lib/env', () => ({
  env: {
    get enablePushNotify() {
      return h.enablePushNotify;
    },
    get pushVapidPublicKey() {
      return h.pushVapidPublicKey;
    },
  },
}));

vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.isSignedIn,
    sessionAddress: h.sessionAddress,
    signIn: h.signIn,
    isSigningIn: false,
  }),
}));

// パネル内蔵 sign-in の接続判定 (未接続はヘッダの「接続」誘導・接続済はその場で署名)。
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: h.isConnected }),
}));

vi.mock('@/hooks/usePwaDisplayMode', () => ({
  usePwaDisplayMode: () => ({ isStandalone: h.isStandalone }),
}));

vi.mock('@/lib/walletDeepLink', () => ({
  detectMobilePlatform: () => h.platform,
}));

import { PushNotifyPanel } from '@/components/PushNotifyPanel';

type SwStub = {
  register: ReturnType<typeof vi.fn>;
  getRegistration: ReturnType<typeof vi.fn>;
};

let subscribeFn: ReturnType<typeof vi.fn>;
let getSubscriptionFn: ReturnType<typeof vi.fn>;
let unsubscribeFn: ReturnType<typeof vi.fn>;
let requestPermissionFn: ReturnType<typeof vi.fn>;
let fetchFn: ReturnType<typeof vi.fn>;

function installBrowserPush({
  permission = 'default' as NotificationPermission,
  existingSub = false,
} = {}) {
  const sub = {
    endpoint: 'https://push.example/sub/xyz',
    toJSON: () => ({
      endpoint: 'https://push.example/sub/xyz',
      keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
    }),
    unsubscribe: (unsubscribeFn = vi.fn().mockResolvedValue(true)),
  };
  subscribeFn = vi.fn().mockResolvedValue(sub);
  getSubscriptionFn = vi.fn().mockResolvedValue(existingSub ? sub : null);
  const reg = {
    pushManager: {
      subscribe: subscribeFn,
      getSubscription: getSubscriptionFn,
    },
  };
  const sw: SwStub = {
    register: vi.fn().mockResolvedValue(reg),
    getRegistration: vi.fn().mockResolvedValue(reg),
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    value: sw,
    configurable: true,
  });
  (window as unknown as { PushManager: unknown }).PushManager = function () {};
  requestPermissionFn = vi.fn().mockResolvedValue('granted');
  (window as unknown as { Notification: unknown }).Notification = {
    permission,
    requestPermission: requestPermissionFn,
  };
  fetchFn = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ subscribed: existingSub, includeAmount: false }),
  });
  global.fetch = fetchFn as unknown as typeof fetch;
}

beforeEach(() => {
  h.enablePushNotify = true;
  h.pushVapidPublicKey = 'BPublicKeyBase64Url';
  h.isSignedIn = true;
  h.sessionAddress = '0x1111111111111111111111111111111111111111';
  h.isConnected = true;
  h.signIn = vi.fn().mockResolvedValue(undefined);
  h.isStandalone = false;
  h.platform = 'other';
  installBrowserPush();
});

afterEach(() => {
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (window as unknown as { Notification?: unknown }).Notification;
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
});

describe('PushNotifyPanel', () => {
  it('flag OFF → null (完全 inert)', () => {
    h.enablePushNotify = false;
    const { container } = renderWithIntl(<PushNotifyPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('VAPID 公開鍵が空 → null', () => {
    h.pushVapidPublicKey = '';
    const { container } = renderWithIntl(<PushNotifyPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('未サインイン → サインイン誘導', () => {
    h.isSignedIn = false;
    renderWithIntl(<PushNotifyPanel />);
    expect(
      screen.getByText(/ウォレットでサインイン/),
    ).toBeInTheDocument();
    // 有効化ボタンは出さない。
    expect(screen.queryByText('通知を有効にする')).not.toBeInTheDocument();
  });

  it('未サインイン + 接続済み → パネル内蔵の sign-in ボタン。押下で SIWE signIn を呼ぶ', () => {
    h.isSignedIn = false;
    h.isConnected = true;
    renderWithIntl(<PushNotifyPanel />);
    const cta = screen.getByRole('button', { name: 'サインインして通知を設定' });
    fireEvent.click(cta);
    // 文言は WalletBadge と同じ Nav.siweStatement (署名プロンプトの一貫性)。
    expect(h.signIn).toHaveBeenCalledWith('OpenPay にこのウォレットでログインします。');
  });

  it('未サインイン + 未接続 → sign-in ボタンは出さない (ヘッダの「接続」誘導に委ねる)', () => {
    h.isSignedIn = false;
    h.isConnected = false;
    renderWithIntl(<PushNotifyPanel />);
    expect(
      screen.queryByRole('button', { name: 'サインインして通知を設定' }),
    ).not.toBeInTheDocument();
  });

  it('iOS Safari 通常タブ (非 standalone) → 購読 UI でなく A2HS hint', async () => {
    h.platform = 'ios';
    h.isStandalone = false;
    renderWithIntl(<PushNotifyPanel />);
    expect(
      await screen.findByText('通知を受け取るにはホーム画面に追加'),
    ).toBeInTheDocument();
    expect(screen.queryByText('通知を有効にする')).not.toBeInTheDocument();
  });

  it('対応ブラウザ・未購読 → 有効化ボタンを出し、押下で SW 登録 + 購読 + POST する', async () => {
    renderWithIntl(<PushNotifyPanel />);
    const btn = await screen.findByText('通知を有効にする');

    fireEvent.click(btn);

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(requestPermissionFn).toHaveBeenCalled();
    expect(subscribeFn).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/push/subscribe');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      locale: 'ja',
      includeAmount: false,
      subscription: { endpoint: 'https://push.example/sub/xyz' },
    });
    expect(await screen.findByText('通知は有効です')).toBeInTheDocument();
  });

  it('permission denied → ブロック中メッセージ (購読 UI は出さない)', async () => {
    installBrowserPush({ permission: 'denied' });
    renderWithIntl(<PushNotifyPanel />);
    expect(
      await screen.findByText(/通知がブロックされています/),
    ).toBeInTheDocument();
    expect(screen.queryByText('通知を有効にする')).not.toBeInTheDocument();
  });

  it('金額 opt-in チェックで includeAmount:true を送る (購読済みは再 POST)', async () => {
    installBrowserPush({ existingSub: true });
    renderWithIntl(<PushNotifyPanel />);
    // ブラウザとサーバの両方に購読がある。
    expect(await screen.findByText('通知は有効です')).toBeInTheDocument();

    fetchFn.mockClear();
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.includeAmount).toBe(true);
  });

  it('購読済み → 「テスト通知を送る」で /api/push/test に POST・成功文言を出す', async () => {
    installBrowserPush({ existingSub: true });
    fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({ subscribed: true, includeAmount: false, ok: true, attempted: 1, sent: 1 }),
    });
    renderWithIntl(<PushNotifyPanel />);
    expect(await screen.findByText('通知は有効です')).toBeInTheDocument();

    fetchFn.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'テスト通知を送る' }));
    await waitFor(() =>
      expect(screen.getByText(/テスト通知を送りました/)).toBeInTheDocument(),
    );
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/push/test');
    expect(init.method).toBe('POST');
  });

  it('テスト通知が rate limit (429) → 失敗文言 (再試行誘導)', async () => {
    installBrowserPush({ existingSub: true });

    renderWithIntl(<PushNotifyPanel />);
    expect(await screen.findByText('通知は有効です')).toBeInTheDocument();

    fetchFn.mockResolvedValue({ ok: false, json: async () => ({ error: 'rate_limited' }) });
    fireEvent.click(screen.getByRole('button', { name: 'テスト通知を送る' }));
    await waitFor(() =>
      expect(screen.getByText(/テスト通知を送れませんでした/)).toBeInTheDocument(),
    );
  });
});

describe('D6: wallet-scoped push truth', () => {
  it('a browser subscription for A does not enable notifications for B', async () => {
    installBrowserPush({ existingSub: true });
    const view = renderWithIntl(<PushNotifyPanel />);
    expect(await screen.findByText('通知は有効です')).toBeInTheDocument();
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ subscribed: false, includeAmount: false }) });
    h.sessionAddress = '0x2222222222222222222222222222222222222222';
    await act(async () => view.rerender(<PushNotifyPanel />));
    expect(screen.queryByText('通知は有効です')).toBeNull();
    expect(screen.getByRole('button', { name: '通知を有効にする' })).toBeInTheDocument();
  });

  it.each([401, 503])('DELETE %i reports failure and keeps the subscription retryable', async (status) => {
    installBrowserPush({ existingSub: true });
    renderWithIntl(<PushNotifyPanel />);
    await screen.findByText('通知は有効です');
    fetchFn.mockResolvedValue({ ok: false, status });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '通知を無効にする' })));
    expect(screen.getByText('通知の設定に失敗しました。しばらくしてからもう一度お試しください。')).toBeInTheDocument();
    expect(screen.getByText('通知は有効です')).toBeInTheDocument();
    expect(unsubscribeFn).not.toHaveBeenCalled();
  });

  it('failed server status lookup does not claim the browser subscription is enabled', async () => {
    installBrowserPush({ existingSub: true });
    fetchFn.mockResolvedValue({ ok: false, status: 503 });
    await act(async () => renderWithIntl(<PushNotifyPanel />));
    expect(screen.queryByText('通知は有効です')).toBeNull();
    expect(screen.getByText('通知の設定に失敗しました。しばらくしてからもう一度お試しください。')).toBeInTheDocument();
  });

  it('late status response for A cannot enable B', async () => {
    installBrowserPush({ existingSub: true });
    let resolve!: (value: unknown) => void;
    fetchFn.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const view = renderWithIntl(<PushNotifyPanel />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ subscribed: false, includeAmount: false }) });
    h.sessionAddress = '0x2222222222222222222222222222222222222222';
    await act(async () => view.rerender(<PushNotifyPanel />));
    await act(async () => resolve({ ok: true, json: async () => ({ subscribed: true, includeAmount: false }) }));
    expect(screen.queryByText('通知は有効です')).toBeNull();
  });
});

it('D6: disables the server endpoint even if the browser subscription has disappeared', async () => {
  installBrowserPush({ existingSub: true });
  renderWithIntl(<PushNotifyPanel />);
  await screen.findByText('通知は有効です');
  getSubscriptionFn.mockResolvedValue(null);
  fetchFn.mockClear();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '通知を無効にする' })));
  expect(fetchFn).toHaveBeenCalledWith('/api/push/subscribe', expect.objectContaining({
    method: 'DELETE', body: JSON.stringify({ endpoint: 'https://push.example/sub/xyz' }),
  }));
  expect(screen.queryByText('通知は有効です')).toBeNull();
});

it('D6: server deletion remains reflected when browser unsubscribe rejects', async () => {
  installBrowserPush({ existingSub: true });
  renderWithIntl(<PushNotifyPanel />);
  await screen.findByText('通知は有効です');
  unsubscribeFn.mockRejectedValue(new Error('browser failure'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '通知を無効にする' })));
  expect(screen.queryByText('通知は有効です')).toBeNull();
  expect(screen.getByText('通知の設定に失敗しました。しばらくしてからもう一度お試しください。')).toBeInTheDocument();
});

it('D6 review: reads only this endpoint status without putting the endpoint URL in the request URL', async () => {
  installBrowserPush({ existingSub: true });
  renderWithIntl(<PushNotifyPanel />);
  await waitFor(() => expect(fetchFn).toHaveBeenCalled());
  const hash = createHash('sha256').update('https://push.example/sub/xyz').digest('hex');
  expect(fetchFn).toHaveBeenCalledWith(`/api/push/subscribe?endpointHash=${hash}`, { cache: 'no-store' });
});
