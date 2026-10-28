import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStoreProductFocus } from '@/components/CreatorStoreProductFocus';
import { CreatorStoreOtherProducts } from '@/components/CreatorStoreOtherProducts';

const { launcherSpy } = vi.hoisted(() => ({ launcherSpy: vi.fn() }));

vi.mock('@/components/CreatorStorePurchaseLauncher', () => ({
  CreatorStorePurchaseLauncher: (props: { variant?: string; totalLabel?: string }) => {
    launcherSpy(props);
    return <button type="button">購入する</button>;
  },
}));

vi.mock('next/link', () => ({
  default: ({ children, prefetch: _prefetch, ...props }: { children: ReactNode; prefetch?: boolean; href: string }) => (
    <a {...props}>{children}</a>
  ),
}));

const licenseFlags = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableLicenseNftUi() { return licenseFlags.enabled; } } };
});

const PRODUCT = {
  id: `h_${'a'.repeat(32)}`,
  title: 'ローポリ カフェ内装キット',
  desc: 'カフェの内装に使える 3D モデル一式',
  emoji: '☕',
  priceJpyc: '1200',
  payTo: '0x2222222222222222222222222222222222222222' as const,
  contentKind: 'url' as const,
  label: 'download' as const,
  category: '3d-game',
};

function renderFocus(product: Parameters<typeof CreatorStoreProductFocus>[0]['product'], locale: 'ja' | 'en' = 'ja') {
  return renderWithIntl(
    <CreatorStoreProductFocus
      product={product}
      sellerName="山田太郎"
      profileHref={`/${locale}/@yamada`}
      sellerDisclosureHref={`/${locale}/store/seller/0x1234`}
    />,
    { locale },
  );
}

describe('CreatorStoreProductFocus', () => {
  beforeEach(() => {
    launcherSpy.mockClear();
    licenseFlags.enabled = false;
  });

  it('商品名を h1・主画像の alt に入れ、出品者・支払総額・種類と主の購入ボタンを出す', () => {
    const { container } = renderFocus({
      ...PRODUCT,
      imageUrl: 'https://cdn.example.com/main.png',
      galleryUrls: ['https://cdn.example.com/side.png'],
    });
    expect(screen.getByRole('heading', { level: 1, name: PRODUCT.title })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: PRODUCT.title })).toHaveAttribute('src', 'https://cdn.example.com/main.png');
    // サムネイルは番号から a11y 名を導出する (掟 8)。
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '山田太郎' })).toHaveAttribute('href', '/ja/@yamada');
    // 価格 1200 + 利用料 12 = 支払総額 (カード・JSON-LD と同じ値)。
    expect(container.textContent).toContain('1,212 JPYC');
    expect(container.textContent).toContain('3D・ゲーム素材');
    expect(container.textContent).toContain('ダウンロード');
    expect(launcherSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'focus', totalLabel: '1,212 JPYC' }));
  });

  it('画像の無い商品は絵文字のカバーを出す', () => {
    renderFocus(PRODUCT);
    expect(screen.queryByRole('img', { name: PRODUCT.title })).not.toBeInTheDocument();
    expect(screen.getByText('☕')).toHaveAttribute('aria-hidden', 'true');
  });

  it('利用条件が無い商品は、購入画面と同じ既定の文 (私的利用のみ・再配布不可) を常に出す', () => {
    renderFocus(PRODUCT);
    const section = screen.getByRole('heading', { level: 2, name: '利用条件' }).closest('section')!;
    expect(section).toHaveTextContent('販売者が別途定めない限り、購入者本人の私的利用に限り、再配布はできません。');
  });

  it('利用条件がある商品は 3 行 (可・不可・記載なし) を h2 の節で出す', () => {
    renderFocus({ ...PRODUCT, usage: { commercial: 'allowed', redistribute: 'not_allowed' } });
    const section = screen.getByRole('heading', { level: 2, name: '利用条件' }).closest('section')!;
    expect([...section.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(['可', '記載なし', '不可']);
  });

  it('受け取り方は購入画面の開示と同じ文 (提供中である限り) で、言い切らない', () => {
    renderFocus(PRODUCT);
    const section = screen.getByRole('heading', { level: 2, name: '受け取り方' }).closest('section')!;
    expect(section).toHaveTextContent('決済成立後、即時に提供します。');
    expect(section).toHaveTextContent('商品が提供中である限り、ライブラリから何度でも再ダウンロードできます。');
    expect(section).not.toHaveTextContent('販売を停止しても');
    expect(within(section).getByRole('link')).toHaveAttribute('href', '/ja/store/library');
  });

  it('説明・仕様・実際に試す・販売者情報を出す', () => {
    renderFocus({
      ...PRODUCT,
      details: '<b>内容物</b>\nGLB 3 点',
      specs: [{ label: '形式', value: 'GLB' }],
      demoUrl: 'https://example.com/world',
    });
    const about = screen.getByRole('heading', { level: 2, name: '商品について' }).closest('section')!;
    expect(about).toHaveTextContent(PRODUCT.desc);
    expect(about.querySelector('b')).toBeNull();
    const specs = screen.getByRole('heading', { level: 2, name: '仕様' }).closest('section')!;
    expect([...specs.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['形式']);
    const demo = screen.getByRole('link', { name: /^実際に試す/ });
    expect(demo).toHaveAttribute('href', 'https://example.com/world');
    expect(demo).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(demo).toHaveTextContent('example.com');
    expect(screen.getByRole('link', { name: '出品者の販売者情報を確認' })).toHaveAttribute('href', '/ja/store/seller/0x1234');
  });

  it('USDC 可の商品だけ、Base のロゴつきで「USDC でも購入可」を添える (読み上げでは Base と分かる)', () => {
    const { container, rerender } = renderFocus(PRODUCT);
    expect(container.textContent).not.toContain('USDC');
    expect(container.querySelector('img[src="/chains/base.svg"]')).toBeNull();
    expect(container.querySelector('img[src="/chains/polygon.svg"]')).not.toBeNull();
    rerender(
      <CreatorStoreProductFocus
        product={{ ...PRODUCT, usdcEnabled: true }}
        sellerName="山田太郎"
        profileHref="/ja/@yamada"
        sellerDisclosureHref="/ja/store/seller/0x1234"
      />,
    );
    const note = container.querySelector('img[src="/chains/base.svg"]')!.parentElement!;
    expect(note).toHaveTextContent('USDC（Base） でも購入可');
    expect(note.querySelector('.sr-only')).toHaveTextContent('（Base）');
  });

  it('license 商品の種類は「ライセンス」', () => {
    licenseFlags.enabled = true;
    const { container } = renderFocus({
      ...PRODUCT,
      label: 'api',
      productKind: 'license',
      license: { supply: 10, remaining: 3, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '1' },
    });
    expect(container.textContent).toContain('ライセンス');
    expect(container.textContent).not.toContain('API');
    // 受け取り方は最終確認と同じく、ウォレットへ NFT が届く案内 (ライブラリの再ダウンロードの文ではない)。
    const delivery = screen.getByRole('heading', { level: 2, name: '受け取り方' }).closest('section')!;
    expect(delivery).toHaveTextContent('NFT は購入後、通常数分で支払いに使ったウォレットへ届きます');
    expect(delivery).not.toHaveTextContent('ライブラリから何度でも再ダウンロードできます');
  });

  it('license 商品の利用条件は出品者が選んだ条件へのリンクだけで、既定の文 (私的利用に限る) は出さない', () => {
    licenseFlags.enabled = true;
    renderFocus({
      ...PRODUCT,
      label: 'api',
      productKind: 'license',
      license: { supply: 100, remaining: 99, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: 'v1' },
    });
    const section = screen.getByRole('heading', { level: 2, name: '利用条件' }).closest('section')!;
    expect(within(section).getByRole('link', { name: '利用条件（バージョン v1）' })).toHaveAttribute('href', 'https://example.com/terms');
    expect(section).not.toHaveTextContent('私的利用');
    expect(document.body).not.toHaveTextContent('販売者が別途定めない限り');
  });

  it('長いホスト名の「実際に試す」は折り返せる', () => {
    renderFocus({ ...PRODUCT, demoUrl: `https://${'a'.repeat(63)}.example.com/world` });
    const host = screen.getByText(`${'a'.repeat(63)}.example.com`);
    expect(host).toHaveClass('min-w-0', 'break-all');
    expect(host.parentElement).toHaveClass('flex-wrap');
  });

  it('英語でも見出しと既定の利用条件を出す', () => {
    renderFocus(PRODUCT, 'en');
    expect(screen.getByRole('heading', { level: 2, name: 'Usage terms' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'How you receive it' })).toBeInTheDocument();
  });
});

describe('CreatorStoreOtherProducts', () => {
  const others = [
    { ...PRODUCT, id: `h_${'b'.repeat(32)}`, title: '和風ジングル素材集' },
    { ...PRODUCT, id: `h_${'c'.repeat(32)}`, title: 'AI プロンプト 100 選' },
  ];

  it('各カードは商品ページへのリンク (購入ボタンは持たない)・Store から来た訪問は from=store を保つ', () => {
    renderWithIntl(
      <CreatorStoreOtherProducts products={others} handle="yamada" fromStore dark={false} viewAllHref="/ja/store?q=%40yamada" totalCount={3} />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'このクリエイターの他の商品' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/ja/@yamada?product=${others[0].id}&from=store`,
      `/ja/@yamada?product=${others[1].id}&from=store`,
    ]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('厳選で省いた商品があるときだけ「すべての商品を見る (総数)」を出す', () => {
    const { rerender } = renderWithIntl(
      <CreatorStoreOtherProducts products={others} handle="yamada" fromStore={false} dark={false} viewAllHref="/ja/store?q=%40yamada" totalCount={5} />,
    );
    expect(screen.getByRole('link', { name: 'すべての商品を見る (5 件)' })).toHaveAttribute('href', '/ja/store?q=%40yamada');
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', `/ja/@yamada?product=${others[0].id}`);
    rerender(
      <CreatorStoreOtherProducts products={others} handle="yamada" fromStore={false} dark={false} viewAllHref="/ja/store?q=%40yamada" totalCount={3} />,
    );
    expect(screen.queryByRole('link', { name: /すべての商品を見る/ })).not.toBeInTheDocument();
  });

  it('他の商品が無ければ節ごと出さない', () => {
    const { container } = renderWithIntl(
      <CreatorStoreOtherProducts products={[]} handle="yamada" fromStore={false} dark={false} totalCount={1} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
