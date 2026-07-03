import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

// env / SIWE / PWA display mode / platform を hoisted な可変ホルダで mock し、各 test で
// 状態を差し替える。ブラウザ push API (serviceWorker / PushManager / Notification / fetch) は
// beforeEach で stub する。実 push 保存は route/store test (push-subscribe/pushStore) で担保。
const h = vi.hoisted(() => ({
  enablePushNotify: true,
  pushVapidPublicKey: 'BPublicKeyBase64Url',
  isSignedIn: true,
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
  useSiweSession: () => ({ isSignedIn: h.isSignedIn }),
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
  fetchFn = vi.fn().mockResolvedValue({ ok: true });
  global.fetch = fetchFn as unknown as typeof fetch;
}

beforeEach(() => {
  h.enablePushNotify = true;
  h.pushVapidPublicKey = 'BPublicKeyBase64Url';
  h.isSignedIn = true;
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
    // 既存購読ありなので「有効」状態から始まる。
    expect(await screen.findByText('通知は有効です')).toBeInTheDocument();

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.includeAmount).toBe(true);
  });
});
