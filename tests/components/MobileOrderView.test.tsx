// 顧客向け注文ページの読み取り専用ビュー (MobileOrderView) を実描画で検証。
// 店舗名 / メニュー (名前・価格・絵文字・画像) / SNS / 「準備中」表示が出ること。

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { MobileOrderView } from '@/components/MobileOrderView';
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

  it('注文・支払いは「準備中」を明示 (P2 未配線) + OpenPay 受取の表示', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    expect(
      screen.getByText('注文・お支払い機能は現在準備中です。店頭でご注文ください。'),
    ).toBeInTheDocument();
    expect(screen.getByText('このお店は OpenPay で受け取っています')).toBeInTheDocument();
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
