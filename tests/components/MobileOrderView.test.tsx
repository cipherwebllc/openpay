// 顧客向け注文ページの読み取り専用ビュー (MobileOrderView) を実描画で検証。
// 店舗名 / メニュー (名前・価格・絵文字・画像) / SNS / 「準備中」表示が出ること。

import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { MobileOrderView } from '@/components/MobileOrderView';
import { parseCheckoutParams } from '@/lib/url';
import type { MobileOrderConfig } from '@/lib/mobileOrder';

const config: MobileOrderConfig = {
  receiver: '0x1111111111111111111111111111111111111111',
  chain: 'polygon',
  shopName: 'テスト珈琲店',
  mode: 'storefront',
  feePayer: 'merchant',
  socials: { x: 'https://x.com/shop' },
  menu: [
    { id: 'a', name: 'ブレンド', price: '500', visual: { kind: 'emoji', value: '☕' } },
    { id: 'b', name: 'チーズケーキ', price: '650', visual: { kind: 'image', url: 'https://img/x.png' } },
    { id: 'c', name: '水', price: '100' },
  ],
};

describe('MobileOrderView', () => {
  it('店舗名 + 受取チェーン + メニュー (名前/価格) を描画', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.getByText('テスト珈琲店')).toBeInTheDocument();
    expect(screen.getByText('Polygon で JPYC を受け取り')).toBeInTheDocument();
    expect(screen.getByText('ブレンド')).toBeInTheDocument();
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
    expect(screen.getByText('チーズケーキ')).toBeInTheDocument();
    expect(screen.getByText('650 JPYC')).toBeInTheDocument();
    expect(screen.getByText('100 JPYC')).toBeInTheDocument();
  });

  it('絵文字はテキスト・画像は <img> で描画', () => {
    // 画像は装飾扱い (alt="" → role=presentation) なので src で取得する。
    const { container } = renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.getByText('☕')).toBeInTheDocument();
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://img/x.png');
  });

  it('SNS をアイコンのリンク行 (target=_blank・nofollow・svg アイコン) で描画', () => {
    const { container } = renderWithIntl(<MobileOrderView config={config} />);
    const x = container.querySelector('a[href="https://x.com/shop"]');
    expect(x).not.toBeNull();
    expect(x).toHaveAttribute('target', '_blank');
    expect(x?.getAttribute('rel')).toContain('nofollow');
    // テキストリンクでなくアイコン (svg) を内包する (プロフと同じ表示)。
    expect(x?.querySelector('svg')).not.toBeNull();
  });

  it('カート空では合計/支払いを出さず案内 (poweredBy は出る)', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.getByText('商品を選ぶと合計が表示されます')).toBeInTheDocument();
    expect(screen.queryByText('支払いへ進む')).toBeNull();
    expect(screen.getByText('このお店は OpenPay で受け取っています')).toBeInTheDocument();
  });

  it('数量を選ぶと合計 + /checkout への支払いリンク (手数料0・既存決済流用・chain伝播)', () => {
    // chain は kaia (JPYC 既定 polygon でない) で URL に明示されることを確認。
    renderWithIntl(<MobileOrderView config={{ ...config, chain: 'kaia' }} />);
    // ブレンド(500) + 水(100) を各 +1 → 合計 600 JPYC
    const inc = screen.getAllByRole('button', { name: '数量を増やす' });
    fireEvent.click(inc[0]); // ブレンド
    fireEvent.click(inc[2]); // 水
    expect(screen.getByText('600 JPYC')).toBeInTheDocument();
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const url = new URL(pay.getAttribute('href') ?? '', 'http://localhost');
    expect(url.pathname).toBe('/checkout');
    expect(url.searchParams.get('to')?.toLowerCase()).toBe(config.receiver.toLowerCase());
    expect(url.searchParams.get('chain')).toBe('kaia');
  });

  it('税率付き商品はカート→/checkout の items に税率/税区分が伝播する (レシート小計/うち税額)', () => {
    const taxed: MobileOrderConfig = {
      ...config,
      menu: [{ id: 'a', name: '課税商品', price: '500', taxRate: 10, taxCategory: 'taxable_10' }],
    };
    renderWithIntl(<MobileOrderView config={taxed} />);
    fireEvent.click(screen.getByRole('button', { name: '数量を増やす' }));
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const u = new URL(pay.getAttribute('href') ?? '', 'http://localhost');
    const parsed = parseCheckoutParams(u.searchParams);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.items[0].taxRate).toBe(10);
      expect(parsed.params.items[0].taxCategory).toBe('taxable_10');
    }
  });

  // 二重防御: 通常 config は validateOrderConfig で https のみに検証済みだが、検証を
  // 迂回した (attacker-crafted) config を直接渡しても href/src に危険スキームが出ないこと。
  it('javascript:/data: スキームは href/src に描画しない (XSS 防御)', () => {
    const hostile: MobileOrderConfig = {
      receiver: '0x1111111111111111111111111111111111111111',
      chain: 'polygon',
      shopName: '悪意の店',
      mode: 'storefront',
      feePayer: 'merchant',
      socials: { x: 'javascript:alert(1)', instagram: 'data:text/html,<script>1</script>' },
      menu: [{ id: 'a', name: '罠', price: '1', visual: { kind: 'image', url: 'data:image/svg+xml,x' } }],
    };
    const { container } = renderWithIntl(<MobileOrderView config={hostile} />);
    // SNS は https でないので 1 件も描画されない → アンカー自体ゼロ。
    expect(container.querySelectorAll('a')).toHaveLength(0);
    // 危険スキームを持つ要素は一切無い。商品名は残る (画像だけ落ちる)。
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('[src^="data:"]')).toBeNull();
    expect(screen.getByText('罠')).toBeInTheDocument();
  });
});
