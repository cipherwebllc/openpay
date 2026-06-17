// 顧客向け注文ページの読み取り専用ビュー (MobileOrderView) を実描画で検証。
// 店舗名 / メニュー (名前・価格・絵文字・画像) / SNS / 「準備中」表示が出ること。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

// 受注リレー flag を切替え可能に (既定 OFF=既存テストの挙動不変)。
const envHold = vi.hoisted(() => ({ enableOrderRelay: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderRelay() {
        return envHold.enableOrderRelay;
      },
    },
  };
});

import { MobileOrderView } from '@/components/MobileOrderView';
import { parseCheckoutParams } from '@/lib/url';
import type { MobileOrderConfig } from '@/lib/mobileOrder';

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

  it('カート空では合計/支払いを出さず案内 (poweredBy の OpenPay はトップへのリンク)', () => {
    renderWithIntl(<MobileOrderView config={config} />);
    expect(screen.getByText('商品を選ぶと合計が表示されます')).toBeInTheDocument();
    expect(screen.queryByText('支払いへ進む')).toBeNull();
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
  });

  it('dineIn: テーブル番号を /checkout の description に載せる', () => {
    renderWithIntl(<MobileOrderView config={{ ...config, dineIn: true }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '数量を増やす' })[0]);
    fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: '7' } });
    const pay = screen.getByRole('link', { name: '支払いへ進む' });
    const u = new URL(pay.getAttribute('href') ?? '', 'http://localhost');
    expect(u.searchParams.get('description')).toBe('テーブル 7');
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
    expect(orderId).toBeTruthy();
    // 受注番号は receiptNo (URL では rcpt) としても渡り、顧客の控え (/scan) に残る
    // (完了画面を閉じても「レシート番号」として再確認可)。
    expect(u.searchParams.get('rcpt')).toBe(orderId);
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
    // SNS は https でないので 1 件も描画されない (残るのは poweredBy の OpenPay リンクのみ)。
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toHaveAttribute('href', '/');
    // 危険スキームを持つ要素は一切無い。商品名は残る (画像だけ落ちる)。
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('[src^="data:"]')).toBeNull();
    expect(screen.getByText('罠')).toBeInTheDocument();
  });
});
