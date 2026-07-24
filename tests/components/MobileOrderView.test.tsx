// 顧客向け注文ページの読み取り専用ビュー (MobileOrderView) を実描画で検証。
// 店舗名 / メニュー (名前・価格・絵文字・画像) / SNS / 「準備中」表示が出ること。

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { renderWithIntl } from '../_helpers/i18n';
import messages from '../../messages/ja.json';

// 受注リレー / モバイル注文利用料 flag を切替え可能に (既定 OFF=既存テストの挙動不変)。
const envHold = vi.hoisted(() => ({
  enableOrderRelay: false,
  enableMobileOrderFee: false,
  enableShopLive: false,
  enableMenuOptions: false,
  enablePreorderTime: false,
  enableOrderMemo: false,
  enableOrderCall: false,
}));
const originHold = vi.hoisted(() => ({ value: 'https://test.local' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderRelay() {
        return envHold.enableOrderRelay;
      },
      get enableMobileOrderFee() {
        return envHold.enableMobileOrderFee;
      },
      get enableShopLive() {
        return envHold.enableShopLive;
      },
      get enableMenuOptions() {
        return envHold.enableMenuOptions;
      },
      get enablePreorderTime() {
        return envHold.enablePreorderTime;
      },
      get enableOrderMemo() {
        return envHold.enableOrderMemo;
      },
      get enableOrderCall() {
        return envHold.enableOrderCall;
      },
    },
  };
});
vi.mock('@/hooks/useOrigin', () => ({
  useOrigin: () => originHold.value,
}));

import { MobileOrderView } from '@/components/MobileOrderView';
import { handleStorefrontConfig, type HandleRecord } from '@/lib/handle';
import { buildPayerReceipt, type PayerReceipt } from '@/lib/payerReceipt';
import { parseCheckoutParams } from '@/lib/url';
import type { MobileOrderConfig } from '@/lib/mobileOrder';
import type { AgentCartItem } from '@/lib/agentOrder';

const config: MobileOrderConfig = {
  receiver: '0x1111111111111111111111111111111111111111',
  chain: 'polygon',
  shopName: 'テスト珈琲店',
  mode: 'storefront',
  feePayer: 'merchant',
  socials: ['https://x.com/shop'],
  menu: [
    { id: 'a', name: 'ブレンド', price: '500', visual: { kind: 'emoji', value: '☕' } },
    { id: 'b', name: 'チーズケーキ', price: '650', visual: { kind: 'image', url: 'https://img/x.png' } },
    { id: 'c', name: '水', price: '100' },
  ],
};

afterEach(() => {
  envHold.enableOrderRelay = false; // 受注リレー flag を毎回 OFF に戻す
  envHold.enableMobileOrderFee = false; // モバイル注文利用料 flag も毎回 OFF に戻す
  envHold.enableShopLive = false; // Phase 1 flag も毎回 OFF に戻す
  envHold.enableMenuOptions = false; // Phase 2 flag も毎回 OFF に戻す
  envHold.enablePreorderTime = false; // Phase 4 flag も毎回 OFF に戻す
  envHold.enableOrderMemo = false;
  envHold.enableOrderCall = false;
  originHold.value = 'https://test.local';
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('MobileOrderView', () => {
  it('店舗名 + 受取チェーン + メニュー (名前/価格) を描画', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.getByText('テスト珈琲店')).toBeInTheDocument();
    expect(screen.getByText('Polygon で JPYC を受け取り')).toBeInTheDocument();
    expect(screen.getByText('ブレンド')).toBeInTheDocument();
    // 価格は数値(大) と JPYC(小) を別 span で描画するので数値で検証。
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('チーズケーキ')).toBeInTheDocument();
    expect(screen.getByText('650')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('店名の下に tagline (ひとこと) を表示する', () => {
    renderWithIntl(
      <MobileOrderView config={{ ...config, tagline: '自家焙煎の一杯をあなたに' }} />,
    );
    expect(screen.getByText('自家焙煎の一杯をあなたに')).toBeInTheDocument();
  });

  it('tagline 未設定なら ひとこと 行を出さない (base config)', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.queryByText('自家焙煎の一杯をあなたに')).toBeNull();
  });

  it('カテゴリーがあれば 上部カテゴリーナビ (アンカー) + 見出し別 2 カラムを描画', () => {
    const categorized: MobileOrderConfig = {
      ...config,
      menu: [
        { id: 'a', name: 'ブレンド', price: '500', category: 'ドリンク' },
        { id: 'b', name: 'チーズケーキ', price: '650', category: 'フード' },
        { id: 'c', name: 'カフェラテ', price: '600', category: 'ドリンク' },
      ],
    };
    const { container } = renderWithIntl(<MobileOrderView config={categorized} />);
    // 上部ナビ: カテゴリー出現順に #mo-cat-0=ドリンク / #mo-cat-1=フード のアンカーリンク。
    expect(container.querySelector('a[href="#mo-cat-0"]')?.textContent).toBe('ドリンク');
    expect(container.querySelector('a[href="#mo-cat-1"]')?.textContent).toBe('フード');
    // セクションに対応する id アンカー。
    expect(container.querySelector('#mo-cat-0')).not.toBeNull();
    expect(container.querySelector('#mo-cat-1')).not.toBeNull();
    // 見出しは nav + h3 の 2 箇所に「ドリンク」が出る。商品も描画。
    expect(screen.getAllByText('ドリンク').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('カフェラテ')).toBeInTheDocument();
  });

  it('カテゴリーが 1 種以下なら 上部ナビ (アンカー) を出さない', () => {
    // base config の menu は category 無し → 単一グリッド・ナビ無し・「その他」見出しも無し。
    const { container } = renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.queryByText('その他')).toBeNull();
    expect(container.querySelector('a[href^="#mo-cat-"]')).toBeNull();
  });

  it('価格は数値を大きく (text-base) JPYC を小さく (text-[10px]) 別 span で描画', () => {
    const { container } = renderWithIntl(<MobileOrderView config={config} />);
    // 数値だけの独立 span が大きい (text-base font-bold)。
    const price = screen.getByText('500');
    expect(price.className).toContain('text-base');
    expect(price.className).toContain('font-bold');
    // JPYC は小さい別 span (各商品行に 1 つずつ)。
    const jpycSmall = Array.from(container.querySelectorAll('span')).filter(
      (s) => s.textContent === 'JPYC' && s.className.includes('text-[10px]'),
    );
    expect(jpycSmall.length).toBeGreaterThanOrEqual(1);
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

  it('複数 SNS を配列の順序どおりにアイコン行で描画 (@handle と同型・並び替え可)', () => {
    const multi: MobileOrderConfig = {
      ...config,
      socials: ['https://instagram.com/shop', 'https://x.com/shop', 'https://youtube.com/@shop'],
    };
    const { container } = renderWithIntl(<MobileOrderView config={multi} />);
    // poweredBy の OpenPay リンク (href="/") は除外し、SNS (https) のみ順序検証。
    const hrefs = Array.from(container.querySelectorAll('a[href^="https://"]')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual([
      'https://instagram.com/shop',
      'https://x.com/shop',
      'https://youtube.com/@shop',
    ]);
  });

  it('店舗アイコン (avatar) を円形 <img> で先頭に描画 (referrerPolicy=no-referrer)', () => {
    const withAvatar: MobileOrderConfig = { ...config, avatar: 'https://img.example/icon.png' };
    const { container } = renderWithIntl(<MobileOrderView config={withAvatar} />);
    const imgs = Array.from(container.querySelectorAll('img'));
    // 先頭の img が店舗アイコン (ヘッダーがメニューより前)。
    expect(imgs[0]).toHaveAttribute('src', 'https://img.example/icon.png');
    expect(imgs[0]).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('cover (カバー画像・https) をヘッダー背景に <img> で描画 (no-referrer)', () => {
    const withCover: MobileOrderConfig = { ...config, cover: 'https://img.example/cover.jpg' };
    const { container } = renderWithIntl(<MobileOrderView config={withCover} />);
    const cover = container.querySelector('img[src="https://img.example/cover.jpg"]');
    expect(cover).not.toBeNull();
    expect(cover).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('cover が javascript: は描画しない (XSS 防御)', () => {
    const hostile: MobileOrderConfig = { ...config, cover: 'javascript:alert(1)' };
    const { container } = renderWithIntl(<MobileOrderView config={hostile} />);
    expect(container.querySelector('[src^="javascript:"]')).toBeNull();
  });

  it('avatar 未設定なら店名の頭文字を表示 (img でなく @handle と同型のイニシャル)', () => {
    renderWithIntl(<MobileOrderView config={config} />); // config は avatar 無し
    expect(screen.getByText('テ')).toBeInTheDocument(); // 'テスト珈琲店' の先頭
  });

  it('avatar が javascript: は <img> に描画せず頭文字へ fallback (XSS 防御)', () => {
    const hostileAvatar: MobileOrderConfig = { ...config, avatar: 'javascript:alert(1)' };
    const { container } = renderWithIntl(<MobileOrderView config={hostileAvatar} />);
    expect(container.querySelector('[src^="javascript:"]')).toBeNull();
    expect(screen.getByText('テ')).toBeInTheDocument();
  });

  it('カート空では下部カートバー (合計/支払い) を出さない (poweredBy の OpenPay はトップへのリンク)', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    // 空のときは sticky カートバー自体を描画しない (メニューが主役・アプリ風)。
    expect(screen.queryByText('支払いへ進む')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ご注文内容' })).toBeNull();
    // 「このお店は OpenPay で受け取っています」の OpenPay をテキストリンク化 (→ トップ)。
    const op = screen.getByRole('link', { name: 'OpenPay' });
    expect(op).toHaveAttribute('href', '/');
  });

  it('backHref/backLabel を渡すと /checkout に back + backName が付く (店舗へ戻る導線)', () => {
    renderWithIntl(
      <MobileOrderView config={config} backHref="/ja/@shop" backLabel="テスト珈琲店" />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const url = new URL(pay.getAttribute('href') ?? '', 'http://localhost');
    expect(url.searchParams.get('back')).toBe('/ja/@shop');
    expect(url.searchParams.get('backName')).toBe('テスト珈琲店');
  });

  it('backHref 未指定なら /checkout に back を付けない (直接 /order 等)', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const url = new URL(pay.getAttribute('href') ?? '', 'http://localhost');
    expect(url.searchParams.get('back')).toBeNull();
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

  it('chains 複数なら支払いチェーン選択を出し、選択が /checkout の chain に反映', () => {
    const multiChain: MobileOrderConfig = { ...config, chain: 'polygon', chains: ['polygon', 'kaia'] };
    renderWithIntl(<MobileOrderView config={multiChain} />);
    const polygonBtn = screen.getByRole('button', { name: 'JPYC (Polygon)' });
    const kaiaBtn = screen.getByRole('button', { name: 'JPYC (Kaia)' });
    expect(polygonBtn).toHaveAttribute('aria-pressed', 'true'); // 既定=先頭
    expect(kaiaBtn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    // chain は parseCheckoutParams で解決 (既定 polygon は URL から省略されるため)。
    const chainOf = () => {
      const u = new URL(
        screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
        'http://localhost',
      );
      const p = parseCheckoutParams(u.searchParams);
      return p.ok ? p.params.chain : null;
    };
    expect(chainOf()).toBe('polygon'); // 既定 (先頭)
    fireEvent.click(kaiaBtn); // Kaia に切替
    expect(kaiaBtn).toHaveAttribute('aria-pressed', 'true');
    expect(chainOf()).toBe('kaia'); // 切替が /checkout の chain に反映
  });

  it('chains 単一/未指定なら選択を出さず受取バッジを表示 (従来どおり)', () => {
    renderWithIntl(<MobileOrderView config={config} />); // config は chain のみ (polygon)
    expect(screen.queryByRole('button', { name: 'JPYC (Polygon)' })).toBeNull();
    expect(screen.getByText('Polygon で JPYC を受け取り')).toBeInTheDocument();
  });

  it('店舗情報 (住所=地図リンク / 営業時間 / 電話=tel リンク) を入力時のみ描画', () => {
    const withInfo: MobileOrderConfig = {
      ...config,
      address: '東京都渋谷区テスト 1-2-3',
      hours: '11:00〜22:00（水曜定休）',
      phone: '03-1234-5678',
    };
    const { container } = renderWithIntl(<MobileOrderView config={withInfo} />);
    expect(screen.getByText('11:00〜22:00（水曜定休）')).toBeInTheDocument();
    const map = container.querySelector('a[href^="https://www.google.com/maps/search/"]');
    expect(map?.textContent).toBe('東京都渋谷区テスト 1-2-3');
    const tel = container.querySelector('a[href="tel:0312345678"]');
    expect(tel?.textContent).toBe('03-1234-5678');
  });

  it('店舗情報が無ければ地図/電話リンクを描画しない', () => {
    const { container } = renderWithIntl(<MobileOrderView config={config} />);
    expect(container.querySelector('a[href^="https://www.google.com/maps/search/"]')).toBeNull();
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('受付停止中 (acceptingOrders=false) は告知を出し、商品があっても支払いを出さない', () => {
    const closed: MobileOrderConfig = { ...config, acceptingOrders: false };
    renderWithIntl(<MobileOrderView config={closed} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.queryByRole('link', { name: '支払いへ進む' })).toBeNull();
    // 告知は上部バナー + 支払い欄の 2 箇所に出る。
    expect(screen.getAllByText('ただいま注文を受け付けていません').length).toBeGreaterThanOrEqual(1);
  });

  it('acceptingOrders=true (既定/未設定) は通常どおり支払いを出す', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.getByRole('link', { name: '支払いへ進む' })).toBeInTheDocument();
    expect(screen.queryByText('ただいま注文を受け付けていません')).toBeNull();
  });

  it('dineIn=店内: テーブル番号入力を出し、未入力は支払い無効・入力で有効化', () => {
    renderWithIntl(<MobileOrderView config={{ ...config, dineIn: true }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const input = screen.getByLabelText('テーブル番号');
    expect(input).toBeInTheDocument();
    // 未入力: 支払いリンクは無く (無効ボタン)、必須メッセージが出る。
    expect(screen.queryByRole('link', { name: '支払いへ進む' })).toBeNull();
    expect(screen.getByText('テーブル番号を入力してください')).toBeInTheDocument();
    // テーブル番号を入力すると支払いリンクへ切り替わる。
    fireEvent.change(input, { target: { value: '12' } });
    expect(screen.getByRole('link', { name: '支払いへ進む' })).toBeInTheDocument();
    expect(screen.queryByText('テーブル番号を入力してください')).toBeNull();
    expect(window.sessionStorage.length).toBe(0); // handle 無しページでは永続化しない
  });

  it('dineIn: テーブル番号案内は blur 前はニュートラル・blur 後の未入力で警告色 + aria-invalid', () => {
    renderWithIntl(<MobileOrderView config={{ ...config, dineIn: true }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const input = screen.getByLabelText('テーブル番号');
    const hint = screen.getByText('テーブル番号を入力してください');
    // 触れる前: エラー扱いにしない (案内はニュートラル色・aria-invalid なし)。
    expect(hint.className).toContain('text-slate-500');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    // blur 後の未入力: 警告色 + aria-invalid。
    fireEvent.blur(input);
    expect(screen.getByText('テーブル番号を入力してください').className).toContain(
      'text-amber-700',
    );
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('dineIn: テーブル番号を /checkout の description に載せる', () => {
    renderWithIntl(<MobileOrderView config={{ ...config, dineIn: true }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '7' } });
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const u = new URL(pay.getAttribute('href') ?? '', 'http://localhost');
    expect(u.searchParams.get('description')).toBe('テーブル 7');
  });

  it('dineIn + handle: テーブル番号を sessionStorage へ write-through し、再 mount で復元', () => {
    const dineIn = { ...config, dineIn: true };
    const first = renderWithIntl(<MobileOrderView config={dineIn} handle="coffee" />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '12' } });
    expect(window.sessionStorage.getItem('openpay:order-table:coffee')).toBe('12');

    first.unmount();
    renderWithIntl(<MobileOrderView config={dineIn} handle="coffee" />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.getByLabelText('テーブル番号')).toHaveValue('12');
    expect(screen.getByRole('link', { name: '支払いへ進む' })).toBeInTheDocument();
  });

  it('テイクアウト (dineIn 未設定) はテーブル番号入力を出さず即支払い可', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.queryByLabelText('テーブル番号')).toBeNull();
    expect(screen.getByRole('link', { name: '支払いへ進む' })).toBeInTheDocument();
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const u = new URL(pay.getAttribute('href') ?? '', 'http://localhost');
    expect(u.searchParams.get('description')).toBeNull(); // テイクアウトは description 無し
  });

  it('カート要約: 🛒+点数トグルで明細を開閉し、明細の −/+ で増減できる (合計の上)', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    // ブレンド(500) を +2。
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const toggle = screen.getByRole('button', { name: 'ご注文内容' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false'); // 既定は明細を畳む
    expect(screen.getByText('1000 JPYC')).toBeInTheDocument(); // 500×2 (トグルの総額)
    // タップで明細を開く → 数量ステッパが menu(3) + カート(1=ブレンド) = 4 に増える。
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('button', { name: '数量を増やす' }).length).toBe(4);
    // カート明細の − (DOM 末尾) で減らすと合計が下がる (1000 → 500)。
    const dec = screen.getAllByRole('button', { name: '数量を減らす' });
    fireEvent.click(dec[dec.length - 1]);
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
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

  it('受注リレー flag ON + handle: /checkout に webhook(/api/order/notify?h=) + order_id が付く', () => {
    envHold.enableOrderRelay = true;
    renderWithIntl(<MobileOrderView config={config} handle="alice" />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const u = new URL(
      screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
      'http://localhost',
    );
    const webhook = u.searchParams.get('webhook');
    expect(webhook).toContain('/api/order/notify');
    expect(webhook).toContain('h=alice');
    const orderId = u.searchParams.get('order_id');
    expect(orderId).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    // 受付番号は receiptNo (URL では rcpt) としても渡り、顧客の控え (/scan) に残る
    // (完了画面を閉じても「レシート番号」として再確認可)。
    expect(u.searchParams.get('rcpt')).toBe(orderId);
  });

  it('注文メモは flag ON + カートありでだけ表示し、orderId keyed sessionStorage へ保存 (URL 不載)', () => {
    envHold.enableOrderRelay = true;
    envHold.enableOrderMemo = true;
    renderWithIntl(<MobileOrderView config={config} handle="alice" />);
    expect(screen.queryByPlaceholderText('アレルギー・要望など（任意）')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const memo = screen.getByPlaceholderText('アレルギー・要望など（任意）');
    fireEvent.change(memo, { target: { value: '卵なし' } });

    const u = new URL(
      screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
      'https://test.local',
    );
    const orderId = u.searchParams.get('order_id');
    expect(orderId).toBeTruthy();
    expect(window.sessionStorage.getItem(`openpay:order-memo:${orderId}`)).toBe('卵なし');
    expect(u.searchParams.has('memo')).toBe(false);
    expect(u.searchParams.has('customerMemo')).toBe(false);
  });

  it('注文メモ flag OFF はカートがあっても入力を表示しない', () => {
    renderWithIntl(<MobileOrderView config={config} handle="alice" />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.queryByPlaceholderText('アレルギー・要望など（任意）')).toBeNull();
  });

  it('受付番号は同一 mount の再描画・チェーン切替でも不変', () => {
    envHold.enableOrderRelay = true;
    const multiChain: MobileOrderConfig = {
      ...config,
      chains: ['polygon', 'kaia'],
    };
    const view = renderWithIntl(<MobileOrderView config={multiChain} handle="alice" />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const orderId = () =>
      new URL(
        screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
        'https://test.local',
      ).searchParams.get('order_id');
    const initial = orderId();

    view.rerender(<MobileOrderView config={multiChain} handle="alice" />);
    fireEvent.click(screen.getByRole('button', { name: 'JPYC (Kaia)' }));

    expect(orderId()).toBe(initial);
    expect(initial).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  });

  it('受注リレー有効でも to/items/chain/gas/fee は従来値のまま', () => {
    envHold.enableOrderRelay = true;
    envHold.enableMobileOrderFee = true;
    renderWithIntl(
      <MobileOrderView
        config={{ ...config, chain: 'kaia', mode: 'preorder', feePayer: 'customer' }}
        handle="alice"
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const u = new URL(
      screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
      'https://test.local',
    );

    expect(u.searchParams.get('to')?.toLowerCase()).toBe(config.receiver.toLowerCase());
    expect(u.searchParams.get('chain')).toBe('kaia');
    expect(u.searchParams.get('gas')).toBeNull();
    expect(u.searchParams.get('fee_kind')).toBe('preorder');
    expect(u.searchParams.get('fee_payer')).toBe('customer');
    const parsed = parseCheckoutParams(u.searchParams);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.items).toEqual([{ name: 'ブレンド', qty: 1, price: '500' }]);
    }
  });

  it('SSR は受付番号を初回 HTML に出さず、生成前は checkout link 無効・hydrate mismatch 無し', async () => {
    envHold.enableOrderRelay = true;
    const ui = (
      <NextIntlClientProvider locale="ja" messages={messages}>
        <MobileOrderView
          config={config}
          handle="alice"
          initialCart={[{ id: 'a', qty: 1 }]}
        />
      </NextIntlClientProvider>
    );
    const serverHtml = renderToString(ui);
    expect(serverHtml).not.toContain('order_id=');
    expect(serverHtml).not.toContain('href="/checkout');
    expect(serverHtml).toContain('disabled=""');

    const container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = serverHtml;
    const onRecoverableError = vi.fn();
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, ui, { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    const href = container.querySelector('a[href*="/checkout"]')?.getAttribute('href') ?? '';
    expect(new URL(href, 'https://test.local').searchParams.get('order_id')).toMatch(
      /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/,
    );
    act(() => root.unmount());
    container.remove();
  });

  it('受注リレー flag OFF (既定): webhook/order_id を付けない (inert)', () => {
    renderWithIntl(<MobileOrderView config={config} handle="alice" />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const u = new URL(
      screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
      'http://localhost',
    );
    expect(u.searchParams.get('webhook')).toBeNull();
    expect(u.searchParams.get('order_id')).toBeNull();
  });

  it('受注リレー flag ON だが handle 無し (bare ?s=): webhook を付けない', () => {
    envHold.enableOrderRelay = true;
    renderWithIntl(<MobileOrderView config={config} />); // handle 無し
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const u = new URL(
      screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
      'http://localhost',
    );
    expect(u.searchParams.get('webhook')).toBeNull();
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
      socials: ['javascript:alert(1)', 'data:text/html,<script>1</script>'],
      menu: [{ id: 'a', name: '罠', price: '1', visual: { kind: 'image', url: 'data:image/svg+xml,x' } }],
    };
    const { container } = renderWithIntl(<MobileOrderView config={hostile} />);
    // SNS は https でないので 1 件も描画されない (残るのは自前の固定リンク 2 件 =
    // やり方ガイド + poweredBy の OpenPay のみ)。
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors).toHaveLength(2);
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      '/guide/mobile-order',
      '/',
    ]);
    // 危険スキームを持つ要素は一切無い。商品名は残る (画像だけ落ちる)。
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('[src^="data:"]')).toBeNull();
    expect(screen.getByText('罠')).toBeInTheDocument();
  });
});

// モバイル注文システム利用料 (flag ON): 顧客上乗せ (preorder + customer) では客の表示総額に上乗せし
// feeIncludedNote を出す。店頭/店舗負担は原価のみ (上乗せ無し)。flag OFF は完全 inert。
describe('MobileOrderView — モバイル注文システム利用料 (feeUpcharge / feeIncludedNote)', () => {
  // ブレンド 500 JPYC を 1 点。preorder=3% → 上乗せ 15 JPYC → 総額 515 JPYC。
  function addBlend() {
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
  }
  function payUrl() {
    return new URL(
      screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
      'http://localhost',
    );
  }

  it('flag ON + preorder + 顧客上乗せ: 総額=原価+3% (515 JPYC) 表示・feeIncludedNote・URL に fee_kind/fee_payer', () => {
    envHold.enableMobileOrderFee = true;
    renderWithIntl(
      <MobileOrderView config={{ ...config, mode: 'preorder', feePayer: 'customer' }} />,
    );
    addBlend();
    // 客の表示総額に 3% (15 JPYC) を上乗せ。
    expect(screen.getByText('515 JPYC')).toBeInTheDocument();
    // 内訳の注記 (システム利用料 15 JPYC（3%）を含みます)。
    expect(screen.getByText(/システム利用料 15 JPYC/)).toBeInTheDocument();
    // /checkout へ feeKind=preorder + fee_payer=customer を伝播 (CheckoutForm/relay が分割)。
    const url = payUrl();
    expect(url.searchParams.get('fee_kind')).toBe('preorder');
    expect(url.searchParams.get('fee_payer')).toBe('customer');
  });

  it('flag ON + storefront (店舗負担): 上乗せ無し (原価 500 JPYC のみ)・note 無し・URL は fee_kind=storefront のみ', () => {
    envHold.enableMobileOrderFee = true;
    renderWithIntl(<MobileOrderView config={{ ...config, mode: 'storefront' }} />);
    addBlend();
    // 店頭は店舗負担 → 客には原価のみ表示 (上乗せしない)。
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
    expect(screen.queryByText(/システム利用料/)).toBeNull();
    const url = payUrl();
    // feeKind は載る (server/CheckoutForm が分割する合図) が、storefront は fee_payer を出さない。
    expect(url.searchParams.get('fee_kind')).toBe('storefront');
    expect(url.searchParams.get('fee_payer')).toBeNull();
  });

  it('flag OFF (既定): preorder+customer でも上乗せ無し・note 無し・URL に fee_kind 無し (完全 inert)', () => {
    // envHold.enableMobileOrderFee は afterEach で false (既定)。
    renderWithIntl(
      <MobileOrderView config={{ ...config, mode: 'preorder', feePayer: 'customer' }} />,
    );
    addBlend();
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
    expect(screen.queryByText(/システム利用料/)).toBeNull();
    expect(payUrl().searchParams.get('fee_kind')).toBeNull();
  });
});

// 事前充填 (?cart=)。@handle 店舗ページが server で decodeAgentCart 済みの検証済みカートを
// initialCart で渡す。qty/optionEntries を初期充填し、明細を既定で開き、通知バナーを出す。
// 改ざん (未知 id) は該当行 drop・価格は menu 由来で再計算 (改ざん無害化)。cart 不在は従来挙動。
describe('MobileOrderView 事前充填 (initialCart / ?cart=)', () => {
  it('cart 不在 (initialCart 未指定): 従来どおり空カート・通知バナー無し (inert)', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.queryByText(/AI が選んだご注文を読み込みました/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'ご注文内容' })).toBeNull();
    expect(screen.queryByRole('link', { name: '支払いへ進む' })).toBeNull();
  });

  it('数量ステッパ商品を充填 → 合計表示 + 通知バナー + 明細を既定で開く + /checkout に items', () => {
    const initialCart: AgentCartItem[] = [
      { id: 'a', qty: 2 }, // ブレンド 500 ×2
      { id: 'c', qty: 1 }, // 水 100 ×1
    ];
    renderWithIntl(
      <MobileOrderView config={config} handle="shop" initialCart={initialCart} />,
    );
    // 通知バナー (M2 の人間確認面)。
    expect(screen.getByText(/AI が選んだご注文を読み込みました/)).toBeInTheDocument();
    // 合計 = 500×2 + 100 = 1100 JPYC。
    expect(screen.getByText('1100 JPYC')).toBeInTheDocument();
    // 事前充填時は明細を既定で開く (人が確認してから払える)。
    expect(screen.getByRole('button', { name: 'ご注文内容' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // /checkout に品目が乗る。
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const parsed = parseCheckoutParams(
      new URL(pay.getAttribute('href') ?? '', 'http://localhost').searchParams,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const names = parsed.params.items.map((i) => i.name).sort();
      expect(names).toEqual(['ブレンド', '水']);
    }
  });

  it('改ざんカート: 未知 id は drop・既知品のみ反映 (価格は menu 由来で再計算)', () => {
    const tampered: AgentCartItem[] = [
      { id: 'a', qty: 1 }, // 実在 (ブレンド 500)
      { id: 'HACK', qty: 99 }, // menu に無い → 無視
    ];
    renderWithIntl(<MobileOrderView config={config} initialCart={tampered} />);
    // 500 のみ (未知 id は反映されない)。
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const parsed = parseCheckoutParams(
      new URL(pay.getAttribute('href') ?? '', 'http://localhost').searchParams,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.items).toHaveLength(1);
      expect(parsed.params.items[0].name).toBe('ブレンド');
      expect(parsed.params.items[0].price).toBe('500'); // menu 由来
    }
  });

  it('全行が未知 id なら空カート・通知バナー無し (解決分ゼロ)', () => {
    renderWithIntl(
      <MobileOrderView config={config} initialCart={[{ id: 'nope', qty: 1 }]} />,
    );
    expect(screen.queryByText(/AI が選んだご注文を読み込みました/)).toBeNull();
    expect(screen.queryByRole('link', { name: '支払いへ進む' })).toBeNull();
  });

  it('options 商品を充填 (flag ON): 実効単価 + サフィックス名でカート追加', () => {
    envHold.enableMenuOptions = true;
    const optCfg: MobileOrderConfig = {
      ...config,
      menu: [
        {
          id: 'gyudon',
          name: '牛丼',
          price: '500',
          options: [
            {
              id: 'g1',
              name: 'サイズ',
              type: 'single',
              required: true,
              choices: [
                { id: 's', label: '小盛り', priceDelta: '0' },
                { id: 'l', label: '大盛り', priceDelta: '200' },
              ],
            },
            {
              id: 'g2',
              name: 'トッピング',
              type: 'multi',
              choices: [{ id: 'ebi', label: 'えび', priceDelta: '150' }],
            },
          ],
        },
      ],
    };
    renderWithIntl(
      <MobileOrderView
        config={optCfg}
        initialCart={[{ id: 'gyudon', qty: 1, options: { g1: 'l', g2: ['ebi'] } }]}
      />,
    );
    // 合計 = 500 + 200 + 150 = 850 JPYC。明細は既定で開くのでサフィックス名も見える。
    expect(screen.getByText('850 JPYC')).toBeInTheDocument();
    expect(screen.getByText('牛丼（大盛り・えび）')).toBeInTheDocument();
  });

  it('グレース劣化 (flag ON): required 未選択の行は drop・有効行のみ反映', () => {
    envHold.enableMenuOptions = true;
    const optCfg: MobileOrderConfig = {
      ...config,
      menu: [
        {
          id: 'gyudon',
          name: '牛丼',
          price: '500',
          options: [
            {
              id: 'g1',
              name: 'サイズ',
              type: 'single',
              required: true,
              choices: [{ id: 's', label: '小盛り', priceDelta: '0' }],
            },
          ],
        },
        { id: 'water', name: '水', price: '100' },
      ],
    };
    renderWithIntl(
      <MobileOrderView
        config={optCfg}
        initialCart={[
          { id: 'gyudon', qty: 1 }, // required (g1) 未選択 → drop
          { id: 'water', qty: 2 }, // 反映
        ]}
      />,
    );
    // 水 100×2 = 200 のみ (牛丼は required 未選択で drop)。牛丼はメニューには残る (カートに入らない)。
    expect(screen.getByText('200 JPYC')).toBeInTheDocument();
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const parsed = parseCheckoutParams(
      new URL(pay.getAttribute('href') ?? '', 'http://localhost').searchParams,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.items.map((i) => i.name)).toEqual(['水']);
    }
  });
});

describe('MobileOrderView ライブ運用状態 (live)', () => {
  it('売り切れ品は「売り切れ」表示 + ステッパ非表示 (注文不可)', () => {
    renderWithIntl(
      <MobileOrderView config={config} live={{ soldOut: ['a'], paused: false, updatedAt: 0 }} />,
    );
    expect(screen.getByText('売り切れ')).toBeInTheDocument();
    // 売り切れ 1 品はステッパを出さない → 3 品中 2 品ぶんの「数量を増やす」のみ。
    expect(screen.getAllByRole('button', { name: '数量を増やす' })).toHaveLength(2);
  });

  it('live 未指定なら売り切れ表示なし (全品注文可)', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.queryByText('売り切れ')).toBeNull();
    expect(screen.getAllByRole('button', { name: '数量を増やす' })).toHaveLength(3);
  });

  it('paused → 一時停止の告知 + 支払い導線を止める', () => {
    renderWithIntl(
      <MobileOrderView config={config} live={{ soldOut: [], paused: true, updatedAt: 0 }} />,
    );
    expect(
      screen.getAllByText('ただいま注文の受付を一時停止しています').length,
    ).toBeGreaterThan(0);
  });

  it('おすすめ品があれば「おすすめ」セクションを先頭に出す (本体グリッドにも残る)', () => {
    envHold.enableShopLive = true; // おすすめ表示は Phase 1 flag 裏
    const rec: MobileOrderConfig = {
      ...config,
      menu: [
        { id: 'a', name: 'ブレンド', price: '500', recommended: true },
        { id: 'b', name: '水', price: '100' },
      ],
    };
    renderWithIntl(<MobileOrderView config={rec} />);
    expect(screen.getByText('おすすめ')).toBeInTheDocument();
    // おすすめ品はセクション + 通常グリッドの 2 箇所に出る。
    expect(screen.getAllByText('ブレンド').length).toBeGreaterThanOrEqual(2);
  });
});

describe('MobileOrderView オプション (options)', () => {
  const sizeTopping: MobileOrderConfig = {
    ...config,
    menu: [
      {
        id: 'gyudon',
        name: '牛丼',
        price: '500',
        options: [
          {
            id: 'g1',
            name: 'サイズ',
            type: 'single',
            required: true,
            choices: [
              { id: 's', label: '小盛り', priceDelta: '0' },
              { id: 'l', label: '大盛り', priceDelta: '200' },
            ],
          },
          {
            id: 'g2',
            name: 'トッピング',
            type: 'multi',
            choices: [{ id: 'ebi', label: 'えび', priceDelta: '150' }],
          },
        ],
      },
    ],
  };

  it('flag OFF: options 商品でも従来の数量ステッパ (モーダル無し)', () => {
    renderWithIntl(<MobileOrderView config={sizeTopping} />);
    expect(screen.getByRole('button', { name: '数量を増やす' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /選ぶ/ })).toBeNull();
  });

  it('flag ON: 選ぶ→選択→実効単価(850)+サフィックス名でカート追加', () => {
    envHold.enableMenuOptions = true;
    renderWithIntl(<MobileOrderView config={sizeTopping} />);
    // options 商品はステッパでなく「選ぶ」ボタン。
    expect(screen.queryByRole('button', { name: '数量を増やす' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /選ぶ/ }));
    fireEvent.click(screen.getByRole('radio', { name: /大盛り/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /えび/ }));
    fireEvent.click(screen.getByRole('button', { name: 'カートに追加' }));
    // 合計 = 500 + 200 + 150 = 850 JPYC (利用料 flag OFF)。
    expect(screen.getByText('850 JPYC')).toBeInTheDocument();
    // 明細を開くとサフィックス名。
    fireEvent.click(screen.getByRole('button', { name: /ご注文内容/ }));
    expect(screen.getByText('牛丼（大盛り・えび）')).toBeInTheDocument();
  });

  it('flag ON: 既定 (single 先頭=小盛り) で確定 → 500 で追加', () => {
    envHold.enableMenuOptions = true;
    renderWithIntl(<MobileOrderView config={sizeTopping} />);
    fireEvent.click(screen.getByRole('button', { name: /選ぶ/ }));
    fireEvent.click(screen.getByRole('button', { name: 'カートに追加' }));
    expect(screen.getByText('500 JPYC')).toBeInTheDocument();
  });
});

describe('MobileOrderView 時間系 (Phase 4・flag enablePreorderTime)', () => {
  // Tokyo 2024-01-15 12:00 (UTC 03:00・15分グリッド境界) に固定し、スロット/ラストオーダーを決定論化。
  const TOKYO_NOON = Date.UTC(2024, 0, 15, 3, 0);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TOKYO_NOON);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const preorder = (over: Partial<MobileOrderConfig> = {}): MobileOrderConfig => ({
    ...config,
    mode: 'preorder',
    ...over,
  });

  it('flag OFF: lastOrder があっても停止せず受取スロットも出さない (inert)', () => {
    renderWithIntl(<MobileOrderView config={preorder({ lastOrder: '00:00' })} />);
    // 00:00 は常に「過ぎている」が flag OFF ゆえ評価されない → 支払い導線は生きている。
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.getByRole('link', { name: '支払いへ進む' })).toBeInTheDocument();
    expect(screen.queryByLabelText('受取時間')).toBeNull();
  });

  it('flag OFF: openFrom が未来でも評価せず受付可能 (inert)', () => {
    renderWithIntl(<MobileOrderView config={preorder({ openFrom: '13:00' })} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.getByRole('link', { name: '支払いへ進む' })).toBeInTheDocument();
    expect(screen.queryByText('本日の受付は 13:00 に開始します。')).toBeNull();
  });

  it('flag ON: openFrom が未来なら時刻入り受付停止バナー + 支払い導線を出さない', () => {
    envHold.enablePreorderTime = true;
    renderWithIntl(<MobileOrderView config={preorder({ openFrom: '13:00' })} />);
    expect(screen.getByText('本日の受付は 13:00 に開始します。')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.queryByRole('link', { name: '支払いへ進む' })).toBeNull();
  });

  it('flag ON: @handle storefront 変換経由でも未来の openFrom で受付停止する', () => {
    envHold.enablePreorderTime = true;
    const record: HandleRecord = {
      owner: config.receiver,
      config: {
        to: config.receiver,
        name: config.shopName,
        methods: [{ token: 'jpyc', chain: 'polygon' }],
      },
      storefront: {
        chain: 'polygon',
        mode: 'preorder',
        feePayer: 'merchant',
        openFrom: '13:00',
        menu: config.menu,
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const handleConfig = handleStorefrontConfig(record, 'shop');
    expect(handleConfig?.openFrom).toBe('13:00');
    renderWithIntl(<MobileOrderView config={handleConfig!} handle="shop" />);
    expect(screen.getByText('本日の受付は 13:00 に開始します。')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.queryByRole('link', { name: '支払いへ進む' })).toBeNull();
  });

  it('flag ON: openFrom が過去なら受付可能', () => {
    envHold.enablePreorderTime = true;
    renderWithIntl(<MobileOrderView config={preorder({ openFrom: '11:00' })} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.getByRole('link', { name: '支払いへ進む' })).toBeInTheDocument();
  });

  it('flag ON: ラストオーダー超過 (00:00) で受付停止バナー + 支払い導線を出さない', () => {
    envHold.enablePreorderTime = true;
    renderWithIntl(<MobileOrderView config={preorder({ lastOrder: '00:00' })} />);
    // バナーは上部 + 会計セクションの 2 箇所に出る (既存の停止表示と同じ)。
    expect(screen.getAllByText('本日のラストオーダーを過ぎました').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.queryByRole('link', { name: '支払いへ進む' })).toBeNull();
  });

  it('flag ON: preorder で受取スロット選択を出し、選ぶと /checkout に pickup_at が乗る', () => {
    envHold.enablePreorderTime = true;
    renderWithIntl(<MobileOrderView config={preorder({ minLeadMinutes: 30 })} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const select = screen.getByLabelText('受取時間') as HTMLSelectElement;
    // 12:00 + 30m = 12:30 が最初のスロット (Tokyo)。
    const opt = within(select).getByRole('option', { name: '12:30' }) as HTMLOptionElement;
    fireEvent.change(select, { target: { value: opt.value } });
    const url = new URL(
      screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
      'http://localhost',
    );
    expect(url.searchParams.get('pickup_at')).toBe(opt.value);
    expect(Number(opt.value)).toBe(Date.UTC(2024, 0, 15, 3, 30)); // Tokyo 12:30 の絶対 ms
  });

  it('flag ON: 未選択 (最短) なら pickup_at を付けない', () => {
    envHold.enablePreorderTime = true;
    renderWithIntl(<MobileOrderView config={preorder({ minLeadMinutes: 30 })} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    const url = new URL(
      screen.getByRole('link', { name: '支払いへ進む' }).getAttribute('href') ?? '',
      'http://localhost',
    );
    expect(url.searchParams.get('pickup_at')).toBeNull();
  });

  it('flag ON: storefront モードは受取スロットを出さない (preorder 限定)', () => {
    envHold.enablePreorderTime = true;
    renderWithIntl(
      <MobileOrderView config={{ ...config, mode: 'storefront', minLeadMinutes: 30 }} />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    expect(screen.queryByLabelText('受取時間')).toBeNull();
  });

  describe('スタッフ呼び出しボタン gating', () => {
    const callTx = `0x${'d'.repeat(64)}`;
    const paidReceipt = (
      over: Partial<Parameters<typeof buildPayerReceipt>[0]> = {},
    ): PayerReceipt =>
      buildPayerReceipt({
        asset: 'jpyc',
        amount: '500',
        merchantAddress: config.receiver,
        txHash: callTx,
        orderId: 'ORDER1',
        ...over,
      });
    const dineIn = { ...config, dineIn: true };
    const prepare = (
      props: {
        enabled?: boolean;
        withReceipt?: boolean;
        handle?: string;
        receipt?: PayerReceipt;
      } = {},
    ) => {
      envHold.enableOrderCall = props.enabled ?? true;
      if (props.withReceipt ?? true) {
        window.localStorage.setItem(
          'openpay:payerReceipts:v1',
          JSON.stringify([props.receipt ?? paidReceipt()]),
        );
      }
      renderWithIntl(<MobileOrderView config={dineIn} handle={props.handle ?? 'coffee'} />);
      fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    };

    it('flag/dineIn/handle/テーブル/2h控えが揃ったときだけ表示', () => {
      prepare();
      expect(screen.queryByRole('button', { name: '🔔 スタッフを呼ぶ' })).toBeNull();
      fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '12' } });
      expect(screen.getByRole('button', { name: '🔔 スタッフを呼ぶ' })).toBeInTheDocument();
    });

    it('flag OFF では出さない', () => {
      prepare({ enabled: false });
      fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '12' } });
      expect(screen.queryByRole('button', { name: '🔔 スタッフを呼ぶ' })).toBeNull();
    });

    it('dineIn でなければ出さない', () => {
      envHold.enableOrderCall = true;
      window.localStorage.setItem('openpay:payerReceipts:v1', JSON.stringify([paidReceipt()]));
      renderWithIntl(<MobileOrderView config={config} handle="coffee" />);
      expect(screen.queryByRole('button', { name: '🔔 スタッフを呼ぶ' })).toBeNull();
    });

    it('handle 無しでは出さない', () => {
      prepare({ handle: '' });
      fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '12' } });
      expect(screen.queryByRole('button', { name: '🔔 スタッフを呼ぶ' })).toBeNull();
    });

    it('該当店舗の2h以内の支払い控えが無ければ出さない', () => {
      prepare({ withReceipt: false });
      fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '12' } });
      expect(screen.queryByRole('button', { name: '🔔 スタッフを呼ぶ' })).toBeNull();
    });

    it('receiptNo だけの旧控えは orderId が無いため出さない', () => {
      prepare({ receipt: paidReceipt({ orderId: undefined, receiptNo: 'ORDER1' }) });
      fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '12' } });
      expect(screen.queryByRole('button', { name: '🔔 スタッフを呼ぶ' })).toBeNull();
    });
  });
});
