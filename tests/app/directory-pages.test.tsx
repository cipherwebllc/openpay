import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import ja from '@/messages/ja.json';

const flags = vi.hoisted(() => ({
  enableWeb3Directory: true,
  enableX402Facilitator: true,
  enableShopsApi: false,
  enableOrderRelay: true,
  enableAgentOrder: true,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableWeb3Directory() {
        return flags.enableWeb3Directory;
      },
      get enableX402Facilitator() {
        return flags.enableX402Facilitator;
      },
      get enableShopsApi() {
        return flags.enableShopsApi;
      },
      get enableOrderRelay() {
        return flags.enableOrderRelay;
      },
      get enableAgentOrder() {
        return flags.enableAgentOrder;
      },
    },
  };
});

const notFoundSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
vi.mock('next/navigation', () => ({ notFound: notFoundSpy }));

const setRequestLocaleSpy = vi.hoisted(() => vi.fn());
vi.mock('next-intl/server', () => ({
  setRequestLocale: setRequestLocaleSpy,
  getTranslations: async (namespace: keyof typeof ja) => {
    const messages = ja[namespace] as Record<string, unknown>;
    return (key: string) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (current, segment) =>
            typeof current === 'object' && current !== null
              ? (current as Record<string, unknown>)[segment]
              : undefined,
          messages,
        );
      return typeof value === 'string' ? value : key;
    };
  },
}));

vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/components/CopyableField', () => ({
  CopyableField: ({ value }: { value: string }) => <span>{value}</span>,
}));

const viewProps = vi.hoisted(() => ({
  usdcItems: [] as Array<{ resource: string; jpycTwinPath?: string }>,
}));
vi.mock('@/components/X402DiscoveryView', () => ({
  X402DiscoveryView: ({
    featured,
    usdcItems,
  }: {
    featured?: ReactNode;
    usdcItems?: Array<{ resource: string; jpycTwinPath?: string }>;
  }) => {
    viewProps.usdcItems = usdcItems ?? [];
    return <div data-testid="discovery-view">{featured}</div>;
  },
}));

import DirectoryPage from '@/app/[locale]/directory/page';
import DiscoveryPage from '@/app/[locale]/discovery/page';

beforeEach(() => {
  flags.enableWeb3Directory = true;
  flags.enableX402Facilitator = true;
  flags.enableShopsApi = false;
  flags.enableOrderRelay = true;
  flags.enableAgentOrder = true;
  notFoundSpy.mockClear();
  setRequestLocaleSpy.mockClear();
});

describe('/directory page', () => {
  it('flag ON では published を表示し、draft を表示しない', async () => {
    const ui = await DirectoryPage({
      params: Promise.resolve({ locale: 'ja' }),
    });
    render(ui);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Japan Web3 Directory' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('JPYC').length).toBeGreaterThan(0);
    expect(screen.getByText('SBI VCトレード')).toBeInTheDocument();
    expect(screen.queryByText('Directory Draft Fixture')).toBeNull();
    expect(screen.getByText('一覧')).toBeInTheDocument();
    expect(screen.getAllByText('2 JPYC')).toHaveLength(2);
  });

  it('flag OFF では notFound', async () => {
    flags.enableWeb3Directory = false;
    await expect(
      DirectoryPage({ params: Promise.resolve({ locale: 'ja' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalledOnce();
  });

  it('Shops 4 flag AND が ON のとき価格表へ search endpoint を並記', async () => {
    flags.enableShopsApi = true;
    const ui = await DirectoryPage({
      params: Promise.resolve({ locale: 'ja' }),
    });
    render(ui);
    expect(
      screen.getByText('店舗検索（/api/paid/jpyc-shops/search）'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('2 JPYC')).toHaveLength(3);
  });
});

describe('/discovery directory featured card', () => {
  it('directory flag ON のとき公開カタログの featured 導線を表示する', async () => {
    const ui = await DiscoveryPage({
      params: Promise.resolve({ locale: 'ja' }),
    });
    render(ui);

    expect(screen.getByTestId('discovery-view')).toBeInTheDocument();
    expect(screen.getByText('注目の構造化データ API')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /詳しく/ })).toHaveAttribute(
      'href',
      '/directory',
    );
  });

  it('注目は細いバナー 1 枚のリンク: 件数と最終更新だけで、説明・価格・カテゴリ数は出さない', async () => {
    const ui = await DiscoveryPage({
      params: Promise.resolve({ locale: 'ja' }),
    });
    render(ui);

    const banner = screen.getByRole('link', { name: /詳しく/ });
    expect(banner).toHaveAttribute('href', '/directory');
    expect(banner).toHaveTextContent('注目の構造化データ API');
    expect(banner).toHaveTextContent('Japan Web3 Directory');
    expect(banner).toHaveTextContent(/データ件数 \d+/);
    expect(banner).toHaveTextContent(/最終更新 /);
    expect(banner).not.toHaveTextContent('カテゴリ');
    expect(banner).not.toHaveTextContent('1〜2 JPYC');
  });

  it('見出しは通貨 2 つと 2 つの入口 (#agent / #sell)。「受取は直接着金」のピルは出さない', async () => {
    const ui = await DiscoveryPage({
      params: Promise.resolve({ locale: 'ja' }),
    });
    render(ui);

    expect(screen.getByRole('link', { name: /AI から使う/ })).toHaveAttribute('href', '#agent');
    expect(screen.getByRole('link', { name: /API を出品する/ })).toHaveAttribute('href', '#sell');
    expect(screen.getByText('JPYC · Polygon')).toBeInTheDocument();
    expect(screen.getByText(/^USDC · Base/)).toBeInTheDocument();
    expect(screen.queryByText('受取は直接着金')).toBeNull();
  });

  it('view へ渡す USDC 商品は、双子の対応がある商品にだけ jpycTwinPath を付ける', async () => {
    const { JPYC_TWIN_BY_USDC_PATH } = await import('@/lib/x402/catalogTwins');
    const ui = await DiscoveryPage({
      params: Promise.resolve({ locale: 'ja' }),
    });
    render(ui);

    expect(viewProps.usdcItems.length).toBeGreaterThan(0);
    for (const item of viewProps.usdcItems) {
      expect(item.jpycTwinPath, item.resource).toBe(
        JPYC_TWIN_BY_USDC_PATH[new URL(item.resource).pathname],
      );
    }
    expect(viewProps.usdcItems.some((item) => item.jpycTwinPath)).toBe(true);
    expect(viewProps.usdcItems.some((item) => !item.jpycTwinPath)).toBe(true);
  });

  it('directory flag OFF のとき featured 導線を表示しない', async () => {
    flags.enableWeb3Directory = false;
    const ui = await DiscoveryPage({
      params: Promise.resolve({ locale: 'ja' }),
    });
    render(ui);

    expect(screen.getByTestId('discovery-view')).toBeEmptyDOMElement();
    expect(screen.queryByText('Japan Web3 Directory')).toBeNull();
  });
});
