// /store のブラウズ UI (P3)。フィルタリングと deep link (購入面を持たない) のフェンス。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { StoreBrowser } from '@/components/StoreBrowser';
import type { StoreListing } from '@/lib/x402/storeListing';

const state = vi.hoisted(() => ({ licenseEnabled: false }));
vi.mock('@/lib/env', () => ({ env: { get enableLicenseNftUi() { return state.licenseEnabled; } } }));
beforeEach(() => { state.licenseEnabled = false; });

const LISTINGS: StoreListing[] = [
  {
    id: `h_${'a'.repeat(32)}`,
    title: 'AI プロンプト集',
    handle: 'alice',
    priceJpyc: '100',
    label: 'prompt',
    category: 'ai',
    tags: ['chatgpt'],
    updatedAt: 2000,
    totalJpyc: '101',
    feeJpyc: '1',
  },
  {
    id: `h_${'b'.repeat(32)}`,
    title: 'VRM アバター',
    handle: 'bob',
    priceJpyc: '500',
    label: 'download',
    category: '3d-game',
    tags: ['vrm'],
    updatedAt: 1000,
    totalJpyc: '505',
    feeJpyc: '5',
  },
];

describe('StoreBrowser', () => {
  it('カードは @handle の商品 deep link へ送る (購入面を新設しない)', () => {
    renderWithIntl(<StoreBrowser listings={LISTINGS} locale="ja" />, {
      locale: 'ja',
    });
    const link = screen.getByRole('link', { name: /AI プロンプト集/ });
    // from=store: プロフ側が「← Store に戻る」ピルを出すための目印 (通常訪問には付かない)
    expect(link.getAttribute('href')).toBe(
      `/ja/@alice?product=h_${'a'.repeat(32)}&from=store`,
    );
    // 合計主役 (2026-07-31 user 裁定)。手数料内訳はショーケース化 (P1) でカードから
    // 除去し、購入モーダル側の開示に一本化 (plans/store-showcase-polish.md)
    expect(screen.getByText('101 JPYC')).toBeInTheDocument();
    expect(screen.queryByText('(価格 100 + 手数料 1)')).toBeNull();
  });

  it('カテゴリーフィルターと AI カテゴリーの /discovery 導線 (裁定 M1)', () => {
    renderWithIntl(<StoreBrowser listings={LISTINGS} locale="ja" />, {
      locale: 'ja',
    });
    expect(screen.queryByText(/AI エージェント向けカタログ/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'AI', pressed: false }));
    expect(screen.getByRole('link', { name: /AI プロンプト集/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /VRM アバター/ })).toBeNull();
    const discovery = screen.getByRole('link', {
      name: 'AI エージェント向けカタログ',
    });
    expect(discovery.getAttribute('href')).toBe('/ja/discovery');
  });

  it('キーワード検索はタイトル/タグ/@handle に効き、不一致は noMatch 表示', () => {
    renderWithIntl(<StoreBrowser listings={LISTINGS} locale="ja" />, {
      locale: 'ja',
    });
    const input = screen.getByPlaceholderText('キーワード・タグ・@handle で検索');
    fireEvent.change(input, { target: { value: 'vrm' } });
    expect(screen.getByRole('link', { name: /VRM アバター/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /AI プロンプト集/ })).toBeNull();
    fireEvent.change(input, { target: { value: '存在しない語' } });
    expect(screen.getByText('条件に合う商品が見つかりません。')).toBeInTheDocument();
  });

  it('@ 付き handle 検索 (プロフの「すべての商品を見る」?q=@handle 経由) がヒットする', () => {
    renderWithIntl(
      <StoreBrowser listings={LISTINGS} locale="ja" initialQuery="@alice" />,
      { locale: 'ja' },
    );
    expect(screen.getByRole('link', { name: /AI プロンプト集/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /VRM アバター/ })).toBeNull();
  });

  it('商品ゼロは empty 表示', () => {
    renderWithIntl(<StoreBrowser listings={[]} locale="ja" />, { locale: 'ja' });
    expect(
      screen.getByText('まだ商品がありません。最初の出品者になりませんか？'),
    ).toBeInTheDocument();
  });
});


it('ライセンスカードの外部条件リンクを商品リンク内に入れず、OFF では隠す', () => {
  const listing = { ...LISTINGS[0], productKind: 'license' as const, sellerRole: 'third_party' as const, license: { supply: 12, remaining: 9, transferable: true, termsUrl: 'https://example.com/terms', termsVersion: '3' } };
  state.licenseEnabled = true;
  const { container, rerender } = renderWithIntl(<StoreBrowser listings={[listing]} locale="ja" />);
  expect(screen.getByText('利用ライセンス NFT')).toBeInTheDocument();
  expect(screen.getByText('残り 9 / 12 · 譲渡可')).toBeInTheDocument();
  expect(screen.getByText('販売者: 第三者出品者 (@alice)')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '利用条件（版 3）' })).toHaveAttribute('href', 'https://example.com/terms');
  expect(container.querySelector('a a')).toBeNull();
  expect(container.querySelector('ul')).toHaveClass('grid-cols-1');
  state.licenseEnabled = false;
  rerender(<StoreBrowser listings={[{ ...listing }]} locale="ja" />);
  expect(screen.queryByText('利用ライセンス NFT')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /AI プロンプト集/ })).not.toBeInTheDocument();
});

it.each([true, false, undefined])('protectedDelivery=%s controls the store card badge', (protectedDelivery) => {
  renderWithIntl(<StoreBrowser listings={[{ ...LISTINGS[0], protectedDelivery }]} locale="ja" />);
  const badge = screen.queryByText('保護配布', { exact: true });
  if (protectedDelivery) { expect(badge).toBeVisible(); expect(badge).not.toHaveAttribute('title'); }
  else expect(badge).not.toBeInTheDocument();
});
