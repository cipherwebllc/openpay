// 存在しない @handle (handle.resolve.miss) の扱い。普通の not-found は Sentry に送らず (info)、
// KV の設定が解決時に見えない疑い (kvConfigured=false) のときだけ warn で Sentry に上げる。
// mock 群は tests/app/handle-page-jsonld.test.tsx と同じ (resolveHandle だけ「未存在」を返す)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { HandleRecord } from '@/lib/handle';

const state = vi.hoisted(() => ({
  enableHandles: true,
  enableMobileOrder: false,
  enableShopLive: false,
  enableCreatorStore: false,
  enableCreatorStoreUi: false,
  hostedProducts: [] as unknown[] | null,
  renderedStorefrontProducts: [] as unknown[],
  renderedAutoOpenProductId: undefined as string | undefined,
  record: null as unknown,
}));
const listAvailableHostedForOwner = vi.hoisted(() => vi.fn());

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return state.enableHandles;
      },
      get enableMobileOrder() {
        return state.enableMobileOrder;
      },
      get enableShopLive() {
        return state.enableShopLive;
      },
      get enableCreatorStore() {
        return state.enableCreatorStore;
      },
      get enableCreatorStoreUi() {
        return state.enableCreatorStoreUi;
      },
    },
  };
});

vi.mock('@/lib/handleStore', () => ({
  resolveHandle: vi.fn(async () => ({ ok: true, record: null })),
}));

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: logs }));

const kv = vi.hoisted(() => ({ configured: true }));
vi.mock('@/lib/kv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kv')>();
  return { ...actual, isKvConfigured: () => kv.configured };
});

vi.mock('@/lib/handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handle')>();
  return {
    ...actual,
    handleStorefrontConfig: (record: HandleRecord) =>
      record.storefront ?? null,
  };
});

vi.mock('@/lib/shopLiveStore', () => ({
  readShopLive: vi.fn(async () => undefined),
}));

vi.mock('@/lib/x402/hostedStore', () => ({
  selectProfileProducts: (products: ReadonlyArray<{ featured?: boolean }>) => {
    const featured = products.filter((p) => p.featured === true);
    return featured.length === 0
      ? { shown: [...products], hiddenCount: 0 }
      : { shown: featured, hiddenCount: products.length - featured.length };
  },
  listAvailableHostedForOwner,
}));

vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getLocale: vi.fn(async () => 'ja'),
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock('@/components/LocaleSwitcher', () => ({
  LocaleSwitcher: () => null,
}));

vi.mock('@/components/HandleProfile', () => ({
  HandleProfileView: () => null,
}));

vi.mock('@/components/ReceiveMethodPicker', () => ({
  ReceiveMethodPicker: () => null,
}));

vi.mock('@/components/HandleShareButton', () => ({
  HandleShareButton: () => null,
}));

vi.mock('@/components/MobileOrderView', () => ({
  MobileOrderView: () => null,
}));

vi.mock('@/components/CreatorStorefrontSection', () => ({
  CreatorStorefrontSection: ({
    products,
    autoOpenProductId,
  }: {
    products: Array<{ id: string }>;
    autoOpenProductId?: string;
  }) => {
    state.renderedStorefrontProducts = products;
    state.renderedAutoOpenProductId = autoOpenProductId;
    return (
      <div data-testid="creator-storefront">
        {products.map((product) => product.id).join(',')}
      </div>
    );
  },
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    prefetch: _prefetch,
    ...props
  }: {
    children: ReactNode;
    prefetch?: boolean;
    href: string;
    [key: string]: unknown;
  }) => <a {...props}>{children}</a>,
}));

vi.mock('next/image', () => ({
  default: () => null,
}));

import HandlePage from '@/app/[locale]/[handle]/page';

async function openMissingHandle(handle: string): Promise<unknown> {
  try {
    await HandlePage({ params: Promise.resolve({ locale: 'ja', handle: `@${handle}` }), searchParams: Promise.resolve({}) } as never);
    return null;
  } catch (error) {
    return error;
  }
}

describe('存在しない @handle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kv.configured = true;
  });

  it('普通の not-found は 404 にし、Sentry へは送らない (info)', async () => {
    const error = await openMissingHandle('no_such_name_1');
    expect(String((error as { digest?: string })?.digest ?? error)).toContain('404');
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledWith('handle.resolve.miss', { handle: 'no_such_name_1', kvConfigured: true });
  });

  it('KV の設定が見えないときだけ warn で Sentry に上げる', async () => {
    kv.configured = false;
    const error = await openMissingHandle('no_such_name_2');
    expect(String((error as { digest?: string })?.digest ?? error)).toContain('404');
    expect(logs.warn).toHaveBeenCalledWith('handle.resolve.miss', { handle: 'no_such_name_2', kvConfigured: false });
  });
});
