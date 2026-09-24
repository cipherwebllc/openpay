import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../_helpers/i18n';
import messages from '../../messages/ja.json';
import { CreatorStorefrontProductArtwork } from '@/components/CreatorStorefrontProductArtwork';
import { HandleProfileView } from '@/components/HandleProfile';
import { MenuItemCard } from '@/components/MenuItemCard';
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';

// 第三者画像 (ExternalImage) の呼び出しごとの挙動を DOM で固定する (R7a の抽出前に書いた網)。
// 描画部品は mock しない。属性の有無・順序・class・失敗時の fallback・URL 切替と遅れて届く
// 旧画像の error を固定する。R7a からの意図した差分は B-R7 (D8) の方針だけ:
//   全呼び出しに decoding="async"・メニュー grid に no-referrer/lazy/fallback・ページ最上部の
//   プロフ avatar は lazy をやめる (SSR で preload)・URL が変わると <img> node を作り直す (key={src})。
const A = 'https://images.example/a.png';
const B = 'https://images.example/b.png';
const config: HandleTipConfig = {
  to: '0x1111111111111111111111111111111111111111',
  name: 'Alice',
  methods: [{ token: 'jpyc', chain: 'polygon' }],
};
const menuProps = { qty: 0, isSoldOut: false, hasOptions: false, optionCount: 0, onQtyChange: vi.fn(), onOpenOptions: vi.fn() };

function ssrTags(ui: ReactElement): string[] {
  const html = renderToString(
    <NextIntlClientProvider locale="ja" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
  // 画像そのものと、画像から派生し得る preload link を拾う。
  return html.match(/<(?:img|link)\b[^>]*>/g) ?? [];
}

describe('external image consumer policies', () => {
  it.each(['thumb', 'cover'] as const)('storefront %s: DOM・fallback・失敗 URL の記録', (variant) => {
    const props = { inverted: false, variant };
    const { container, rerender } = renderWithIntl(<CreatorStorefrontProductArtwork {...props} imageUrl={A} />);
    const first = container.querySelector('img')!;
    const dimensions = variant === 'thumb' ? ' width="40" height="40"' : '';
    const imageClass = variant === 'thumb'
      ? 'h-10 w-10 shrink-0 rounded-xl object-cover'
      : 'aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]';
    expect(container.innerHTML).toBe(`<img alt="" aria-hidden="true"${dimensions} referrerpolicy="no-referrer" loading="lazy" decoding="async" class="${imageClass}" src="${A}">`);
    fireEvent.error(first);
    const fallbackClass = variant === 'thumb'
      ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl bg-slate-100'
      : 'flex aspect-[4/3] w-full items-center justify-center text-4xl bg-gradient-to-br from-slate-50 to-slate-200/70';
    expect(container.innerHTML).toBe(`<span aria-hidden="true" class="${fallbackClass}">✦</span>`);
    rerender(<CreatorStorefrontProductArtwork {...props} imageUrl={B} />);
    const second = container.querySelector('img')!;
    expect(second).toHaveAttribute('src', B);
    fireEvent.error(first); // A 失敗 → B を描画 → 外れた A の node に遅れて error が届く。
    expect(container.querySelector('img')).toBe(second);
    rerender(<CreatorStorefrontProductArtwork {...props} imageUrl={A} />);
    expect(container.querySelector('img')).toBeNull(); // 失敗した URL は覚えている。
    rerender(<CreatorStorefrontProductArtwork {...props} imageUrl={B} />);
    fireEvent.error(container.querySelector('img')!);
    rerender(<CreatorStorefrontProductArtwork {...props} imageUrl={A} />);
    expect(container.querySelector('img')).toHaveAttribute('src', A); // 記録は直近の失敗 1 件だけ。
  });

  it.each(['thumb', 'cover'] as const)('storefront %s (inverted): 絵文字 fallback', (variant) => {
    const { container } = renderWithIntl(<CreatorStorefrontProductArtwork imageUrl={A} emoji="🎁" inverted variant={variant} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.innerHTML).toBe(variant === 'thumb'
      ? '<span aria-hidden="true" class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl bg-white/15">🎁</span>'
      : '<span aria-hidden="true" class="flex aspect-[4/3] w-full items-center justify-center text-4xl bg-white/10">🎁</span>');
  });

  it('storefront: 失敗前の URL 変更は img node を作り直し、旧 node に遅れて届く error を新 URL の失敗にしない (B-R7)', () => {
    const { container, rerender } = renderWithIntl(<CreatorStorefrontProductArtwork imageUrl={A} inverted={false} />);
    const image = container.querySelector('img')!;
    rerender(<CreatorStorefrontProductArtwork imageUrl={B} inverted={false} />);
    const second = container.querySelector('img')!;
    expect(second).not.toBe(image);
    expect(second).toHaveAttribute('src', B);
    // error event は URL を持たない: R7a までは使い回した node の error が B の失敗になっていた。
    fireEvent.error(image);
    expect(container.querySelector('img')).toBe(second);
    fireEvent.error(second);
    expect(container.textContent).toBe('✦');
    rerender(<CreatorStorefrontProductArtwork imageUrl={A} inverted={false} />);
    expect(container.querySelector('img')).toHaveAttribute('src', A);
  });

  it.each(['cover', 'avatar'] as const)('profile %s: 属性・URL 変更での reset・外れた node の遅れ error', (kind) => {
    const { container, rerender } = renderWithIntl(<HandleProfileView config={config} profile={{ [kind]: A }} />);
    const first = container.querySelector('img')!;
    expect(first.outerHTML).toBe(kind === 'cover'
      ? `<img alt="" aria-hidden="true" referrerpolicy="no-referrer" decoding="async" class="aspect-[3/1] max-h-[160px] w-full rounded-2xl object-cover" src="${A}">`
      // avatar はページ最上部なので lazy をやめた (B-R7)。
      : `<img alt="Alice" referrerpolicy="no-referrer" decoding="async" class="h-full w-full object-cover" src="${A}">`);
    const parent = first.parentElement!;
    fireEvent.error(first);
    expect(container.querySelector('img')).toBeNull();
    if (kind === 'avatar') expect(parent.innerHTML).toBe('<span aria-hidden="true">A</span>');
    rerender(<HandleProfileView config={config} profile={{ [kind]: B }} />);
    const second = container.querySelector('img')!;
    fireEvent.error(first);
    expect(container.querySelector('img')).toBe(second);
    expect(second).toHaveAttribute('src', B);
    // storefront の失敗 URL 記録と違い、プロフは URL が変わるたびに失敗状態を reset する (A に戻すと再試行)。
    rerender(<HandleProfileView config={config} profile={{ [kind]: A }} />);
    expect(container.querySelector('img')).toHaveAttribute('src', A);
    // 失敗前の URL 変更も node を作り直す (B-R7)。旧 node に遅れて届く error は B に波及しない。
    const live = container.querySelector('img')!;
    rerender(<HandleProfileView config={config} profile={{ [kind]: B }} />);
    const next = container.querySelector('img')!;
    expect(next).not.toBe(live);
    expect(next).toHaveAttribute('src', B);
    fireEvent.error(live);
    expect(container.querySelector('img')).toBe(next);
  });

  it.each(['🌐', undefined])('profile link 画像 (emoji=%s): fallback と A/B/遅れ A', (emoji) => {
    const profile = (imageUrl: string): HandleProfile => ({ links: [{ label: 'Site', url: 'https://example.com', imageUrl, emoji }] });
    const { rerender } = renderWithIntl(<HandleProfileView config={config} profile={profile(A)} />);
    const link = screen.getByRole('link', { name: 'Site' });
    const first = link.querySelector('img')!;
    expect(link.innerHTML).toBe(`<img alt="" aria-hidden="true" width="20" height="20" referrerpolicy="no-referrer" loading="lazy" decoding="async" class="mr-1.5 h-5 w-5 shrink-0 rounded object-cover" src="${A}">Site`);
    fireEvent.error(first);
    expect(link.innerHTML).toBe(emoji ? '<span class="mr-1.5" aria-hidden="true">🌐</span>Site' : 'Site');
    rerender(<HandleProfileView config={config} profile={profile(B)} />);
    const second = link.querySelector('img')!;
    fireEvent.error(first);
    expect(link.querySelector('img')).toBe(second);
    expect(second).toHaveAttribute('src', B);
    // link 画像は storefront と同じく失敗 URL を覚える (A に戻しても再試行しない)。
    rerender(<HandleProfileView config={config} profile={profile(A)} />);
    expect(link.querySelector('img')).toBeNull();
  });

  it('menu grid: no-referrer・lazy・失敗時は画像なしと同じアイコンへ戻す・URL を直すと再試行 (B-R7)', () => {
    const item = { id: 'a', name: 'Coffee', price: '500', visual: { kind: 'image' as const, url: A } };
    const { container, rerender } = renderWithIntl(<MenuItemCard {...menuProps} item={item} />);
    const image = container.querySelector('img')!;
    expect(image.outerHTML).toBe(`<img alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" class="h-full w-full object-cover" src="${A}">`);
    const frame = image.parentElement!;
    expect(frame.children).toHaveLength(1);
    fireEvent.error(image);
    // 壊れ画像 icon の代わりに、画像未設定の商品と同じ UtensilsCrossed (aria-hidden) を出す。
    expect(container.querySelector('img')).toBeNull();
    expect(frame.children).toHaveLength(1);
    expect(frame.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(frame.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(frame.firstElementChild).toHaveClass('h-8', 'w-8', 'text-slate-300');
    rerender(<MenuItemCard {...menuProps} item={{ ...item, visual: { kind: 'image', url: B } }} />);
    const second = container.querySelector('img')!;
    expect(second).toHaveAttribute('src', B);
    fireEvent.error(image); // 外れた A の node に遅れて届く error は B に波及しない。
    expect(container.querySelector('img')).toBe(second);
    // 失敗前の URL 変更も node を作り直す。
    const C = 'https://images.example/c.png';
    rerender(<MenuItemCard {...menuProps} item={{ ...item, visual: { kind: 'image', url: C } }} />);
    const third = container.querySelector('img')!;
    expect(third).not.toBe(second);
    expect(third).toHaveAttribute('src', C);
  });

  it('SSR の HTML (公開ページの初回描画) も同じ属性・順序で出す', () => {
    expect(ssrTags(
      <HandleProfileView
        config={config}
        profile={{ cover: A, avatar: B, links: [{ label: 'Site', url: 'https://example.com', imageUrl: A }] }}
      />,
    )).toEqual([
      // lazy でない画像だけ React が preload を出す: ページ最上部のカバーと (B-R7 で lazy をやめた)
      // アバター。preload にも no-referrer が載る。リンク画像は lazy のまま preload なし。
      `<link rel="preload" as="image" href="${A}" referrerPolicy="no-referrer"/>`,
      `<link rel="preload" as="image" href="${B}" referrerPolicy="no-referrer"/>`,
      `<img src="${A}" alt="" aria-hidden="true" referrerPolicy="no-referrer" decoding="async" class="aspect-[3/1] max-h-[160px] w-full rounded-2xl object-cover"/>`,
      `<img src="${B}" alt="Alice" referrerPolicy="no-referrer" decoding="async" class="h-full w-full object-cover"/>`,
      `<img src="${A}" alt="" aria-hidden="true" width="20" height="20" referrerPolicy="no-referrer" loading="lazy" decoding="async" class="mr-1.5 h-5 w-5 shrink-0 rounded object-cover"/>`,
    ]);
    expect(ssrTags(<CreatorStorefrontProductArtwork imageUrl={A} inverted={false} />)).toEqual([
      `<img src="${A}" alt="" aria-hidden="true" width="40" height="40" referrerPolicy="no-referrer" loading="lazy" decoding="async" class="h-10 w-10 shrink-0 rounded-xl object-cover"/>`,
    ]);
    expect(ssrTags(<CreatorStorefrontProductArtwork imageUrl={A} inverted={false} variant="cover" />)).toEqual([
      `<img src="${A}" alt="" aria-hidden="true" referrerPolicy="no-referrer" loading="lazy" decoding="async" class="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"/>`,
    ]);
    expect(ssrTags(
      <MenuItemCard {...menuProps} item={{ id: 'a', name: 'Coffee', price: '500', visual: { kind: 'image', url: A } }} />,
    )).toEqual([
      // B-R7: lazy になったので preload を出さず、Referer も送らない。
      `<img src="${A}" alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" class="h-full w-full object-cover"/>`,
    ]);
  });
});
