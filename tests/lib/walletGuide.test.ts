// /guide/wallet「ウォレットを選ぶ」の content SOT (lib/walletGuide.ts) のフェンス:
// (1) ja/en の構造 parity + 全 leaf 非空 (2) 料率・金額・「無料」・チェーン名・USDC を書かない (掟 14)
// (3) 本文が引用する画面の文言が messages と一致する (4) リンク先のページが実在し、名前が目次と同じ
// (5) お店の QR の読み取り方 (ウォレットのアプリでは開かないものがある・2026-10-13 user 実機確認) を書く (6) metadata
// (7) UPBOND Wallet (2026-11-06 user) は支払い用の一覧の最後 (使い方の補足つき) とお店の受け取り用の節に、確かめた事実の範囲だけを書く。

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { guideNavFor } from '@/lib/guideNav';
import { payGuideContentFor } from '@/lib/payGuide';
import { walletGuideContentFor, walletGuideMetadata } from '@/lib/walletGuide';
import { deploymentForSlug } from '@/lib/tokens';

const LOCALES = ['ja', 'en'] as const;
const PAGE_DIR = path.join(process.cwd(), 'app', '[locale]');

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return { __array: value.length ? shape(value[0]) : 'empty', len: value.length };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = shape((value as Record<string, unknown>)[k]);
    return out;
  }
  return typeof value;
}

function copyLeaves(locale: string): [string, string][] {
  const sink: [string, string][] = [];
  const walk = (value: unknown, at: string) => {
    if (typeof value === 'string') sink.push([at, value]);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`);
  };
  walk(walletGuideContentFor(locale), locale);
  // リンク先 (path) は文言ではないので除く。
  return sink.filter(([at]) => !/\.(path|href)$/.test(at));
}

describe('walletGuide content', () => {
  it('未知ロケールは ja へ・ja / en が同一構造で全 leaf 非空', () => {
    expect(walletGuideContentFor('xx')).toBe(walletGuideContentFor('ja'));
    expect(shape(walletGuideContentFor('en'))).toEqual(shape(walletGuideContentFor('ja')));
    for (const locale of LOCALES) {
      for (const [at, text] of copyLeaves(locale)) expect(text.trim().length, `${at} が空`).toBeGreaterThan(0);
    }
  });

  it('料率・金額・「無料」・チェーン名・USDC を書かない (掟 14 の同期面を増やさない)', () => {
    const AMOUNT = /[0-9０-９]+\s*(%|％|JPYC|円|wei)/;
    const FORBIDDEN =
      /無料|\bfree\b|USDC|Polygon|Kaia|Avalanche|Ethereum|\bBase\b|Arbitrum|Optimism|\bArc\b|World\s?Chain|Sonic|\bSei\b|Unichain|HyperEVM|Hyperliquid/i;
    for (const locale of LOCALES) {
      // 例外は UPBOND Wallet で確かめた事実だけ (OpenPay の対応チェーン・通貨の一覧ではない・ほかのチェーン名と金額はここでも書かない):
      //   - storeNote の「Polygon」: ガス代の例 (Polygon なら POL・2026-10-01 本番で受け取り、送るときに POL が要った)
      //   - UPBOND Wallet のカードの本文の「Polygon」: 支払いを確かめたチェーン (2026-11-06 本番)
      const upbondAt = walletGuideContentFor(locale).wallets.findIndex((w) => w.id === 'upbond');
      const ALLOWED: Record<string, RegExp> = {
        [`${locale}.storeNote`]: /Polygon/g,
        [`${locale}.wallets[${upbondAt}].body`]: /Polygon/g,
      };
      for (const [at, text] of copyLeaves(locale)) {
        const checked = ALLOWED[at] ? text.replace(ALLOWED[at], '') : text;
        expect(AMOUNT.test(checked), `${at} に金額・料率: ${text}`).toBe(false);
        expect(FORBIDDEN.test(checked), `${at} に可変情報: ${text}`).toBe(false);
      }
    }
  });

  // 2026-11-06 user: ウォレットを持っていないお店向けに、ブラウザで使える UPBOND Wallet を「お店の受け取り用」として紹介し、
  // 支払い用の一覧の最後にも使い方の補足つきで載せる (user 最終裁定)。確かめた事実: 本番 Polygon で受け取れた (2026-10-01)・
  // 送るときは POL が要る・Polygon のガス代不要の支払い (EIP-3009) が通った (2026-11-06)・スマホでは
  // 払うときに別のウォレットのアプリが開くことがあり、UPBOND のタブに戻ると承認の画面が出ていた・ほかのチェーンを UPBOND の画面で
  // 扱えるかは試していないが、受け取るチェーンは指定しない (「Polygon を選んでください」は Polygon 以外はダメと読める・試したのが
  // Polygon だっただけ・2026-11-06 user)。通常決済と USDC は試していないので、使えるとも使えないとも書かない (2026-11-06 user
  // 「確実じゃなければわざわざ言わなくてよくない？」・SDK の README の「data 付き tx は未対応」は WalletConnect でつないだ場合の
  // 事実ではない)。
  it('UPBOND Wallet: 一覧の最後 (ガス代不要の支払いだけ・Polygon・Copy link でつなぐ・タブに戻る) とお店の受け取り用 (移す・ガス代の例は Polygon なら POL・チェーンを指定しない)', () => {
    for (const locale of LOCALES) {
      const c = walletGuideContentFor(locale);
      // UPBOND の名前は一覧のカードと受け取り用の節 (題・本文・注意・リンク) にだけ出す。
      const upbondAt = c.wallets.findIndex((w) => w.id === 'upbond');
      const outside = copyLeaves(locale).filter(
        ([at]) => !at.startsWith(`${locale}.store`) && !at.startsWith(`${locale}.wallets[${upbondAt}].`),
      );
      for (const [at, text] of outside) expect(text, `${at} に UPBOND`).not.toContain('UPBOND');
      const card = c.wallets[upbondAt];
      expect(card.name).toBe('UPBOND Wallet');
      expect(card.body).toContain('Polygon');
      // 試していない通常決済・USDC について「使えない」と書かない (USDC は上の検査でも止まる)。
      expect(card.body).not.toMatch(/通常決済|使えません|standard payment|not for/i);
      // 使い方の補足は UPBOND Wallet だけ。つなぎ方は WalletConnect の QR の下の“Copy link” (画面の表記どおり・英語のまま)。
      expect(c.wallets.filter((w) => w.howTo).map((w) => w.id)).toEqual(['upbond']);
      expect(card.howTo).toContain(locale === 'ja' ? '「Copy link」' : '“Copy link”');
      expect(card.howTo).toContain('UPBOND Wallet');
      expect(c.storeBody).toContain('UPBOND Wallet');
      expect(c.storeBody).toContain('JPYC EX');
      expect(c.storeNote).toContain('POL');
      // 受け取るチェーンを指定しない (Polygon はガス代の例として出すだけ)。
      expect(c.storeNote).not.toMatch(/選んで|Choose/);
      // 公式のウォレットへ (別タブで開くのは描画側・tests/app/guide-wallet.test.tsx)。
      expect(c.storeLink.href).toBe('https://wallet.upbond.io/');
    }
    expect(walletGuideContentFor('ja').storeNote).toContain('UPBOND Wallet から送るときは、ガス代 (Polygon なら POL) が要ります');
    expect(walletGuideContentFor('ja').storeNote).toContain('売上がたまったら、マイナウォレットなどへ移してください');
    // 「普段の」ウォレットとは書かない (この節はウォレットを持っていないお店向け・2026-11-06 user)。
    expect(walletGuideContentFor('ja').storeNote).not.toContain('普段');
    expect(walletGuideContentFor('en').storeNote).not.toContain('day to day');
    expect(walletGuideContentFor('ja').wallets[3].body).toContain('OpenPay では、Polygon の JPYC のガス代不要の支払いで使えることを確かめています。');
    expect(walletGuideContentFor('ja').wallets[3].howTo).toContain('UPBOND Wallet のタブに戻ると承認の画面が出ています');
    // 受け取り用の節の「お客様の支払い用には、上のウォレットを」は UPBOND も一覧に入ったので書かない。
    expect(walletGuideContentFor('ja').storeNote).not.toContain('お客様の支払い用');
    expect(walletGuideContentFor('en').storeNote).toContain('sending from UPBOND Wallet requires gas, such as POL on Polygon');
    expect(walletGuideContentFor('en').storeNote).toContain('such as MynaWallet');
    expect(walletGuideContentFor('en').wallets[3].body).toContain('we have confirmed that it works for JPYC payments with no gas fee on Polygon');
    expect(walletGuideContentFor('en').wallets[3].howTo).toContain('go back to the UPBOND Wallet tab');
    expect(walletGuideContentFor('en').storeNote).not.toContain('as a customer');
    // ガス代の例に Polygon を出す以上、OpenPay の JPYC の受け取りに Polygon が残っていること (外したらこの節も直す)。
    expect(() => deploymentForSlug('jpyc', 'polygon')).not.toThrow();
  });

  it('ウォレットは MetaMask → マイナウォレット → HashPort Wallet → UPBOND Wallet の 4 つ (マイナウォレットを先に推す・HashPort も推薦に残す・UPBOND は最後)・WalletConnect は 1..4 の手順で検索の言葉まで書く', () => {
    expect(walletGuideContentFor('ja').wallets.map((w) => w.name)).toEqual(['MetaMask', 'マイナウォレット', 'HashPort Wallet', 'UPBOND Wallet']);
    expect(walletGuideContentFor('en').wallets.map((w) => w.name)).toEqual(['MetaMask', 'MynaWallet', 'HashPort Wallet', 'UPBOND Wallet']);
    for (const locale of LOCALES) {
      const c = walletGuideContentFor(locale);
      expect(c.wcSteps.map((s) => s.n)).toEqual([1, 2, 3, 4]);
      expect(c.wcSteps[1].body).toContain('HashPort');
      expect(c.wcSteps[1].body).toContain('Myna');
    }
    // カードのマークの対応 (MetaMask は同梱の公式 SVG を使う)。
    for (const locale of LOCALES) {
      expect(walletGuideContentFor(locale).wallets.map((w) => w.id)).toEqual(['metamask', 'myna', 'hashport', 'upbond']);
      expect(walletGuideContentFor(locale).scanWays.map((w) => w.id)).toEqual(['camera', 'scan']);
    }
    expect(existsSync(path.join(process.cwd(), 'public', 'wallets', 'MetaMask.svg'))).toBe(true);
    // マイナウォレットは「JPYC EX の本人確認にもマイナンバーカード」ではじめての方に向く、と書く (user「マイナウォレットを押したい」)。
    expect(walletGuideContentFor('ja').wallets[1].body).toContain('はじめての方に向いています');
    expect(walletGuideContentFor('en').wallets[1].body).toContain('suits first-time users');
  });

  it('お店の QR はスマホのカメラか「スキャンして支払う」で読む・ウォレットのアプリの読み取りでは開かないものがある', () => {
    const jaC = walletGuideContentFor('ja');
    expect(jaC.scanWays.map((w) => w.name)).toEqual(['スマホのカメラ', `「${ja.Scan.pageTitle}」`]);
    // 2026-10-13 user 実機: MetaMask は開ける・HashPort Wallet (「支払い」で読むとエラー)・マイナウォレットは開けない。
    expect(jaC.scanNote).toContain('MetaMask は開けますが、マイナウォレットと HashPort Wallet は開けません');
    expect(jaC.scanNote).toContain('「このQRコードでは支払えません」');
    expect(jaC.summary).toContain('マイナウォレットや HashPort Wallet のアプリの QR 読み取りでは開けません');
    const enC = walletGuideContentFor('en');
    expect(enC.scanWays.map((w) => w.name)).toEqual(['Your phone camera', `“${en.Scan.pageTitle}”`]);
    expect(enC.scanNote).toContain('MetaMask can, but MynaWallet and HashPort Wallet cannot');
    // パソコンの接続用 QR (WalletConnect) はお店の QR とは別、と書く (読み取り方の注意と取り違えない)。
    expect(jaC.wcTip).toContain('お店の QR とは別');
    expect(enC.wcTip).toContain('not the shop’s QR');
  });

  // 本文は画面の文言を「」/“” で引用する。画面の文言を変えたらここが落ちる = ガイドも直す合図。
  it('引用している画面の文言が messages と一致する', () => {
    const text = (locale: string) => copyLeaves(locale).map(([, t]) => t).join('\n');
    for (const label of [ja.Scan.pageTitle, ja.Nav.pay, ja.Scan.startCameraButton, ja.Nav.connect]) {
      expect(text('ja'), label).toContain(`「${label}」`);
    }
    for (const label of [en.Scan.pageTitle, en.Nav.pay, en.Scan.startCameraButton, en.Nav.connect]) {
      expect(text('en'), label).toContain(`“${label}”`);
    }
    // 売上の移動の案内 (flag ON のときだけ描く) は /create の折りたたみの見出しとフォームの題を引用する。
    expect(walletGuideContentFor('ja').storeMoveNote).toContain(`「${ja.Create.offramp.heading}」にある「${ja.Create.salesMove.title}」`);
    expect(walletGuideContentFor('en').storeMoveNote).toContain(`“${en.Create.salesMove.title}” under “${en.Create.offramp.heading}”`);
  });

  // 2026-11-07 (P2b の案): ガス代が無いときの「売上をほかのウォレットへ移す」への案内。UPBOND Wallet から移せることは
  // まだ確かめていない (plans/store-sales-move.md の P3) ので、UPBOND の名前を出さず、移せると言い切る主語を UPBOND にしない。
  // 料率・金額は書かない (上の検査)。リンク先は /create (描画側が /{locale} を付ける・flag OFF では描かない)。
  it('売上の移動の案内: UPBOND の名前を出さず・利用料がかかることだけを書き・リンク先は /create', () => {
    for (const locale of LOCALES) {
      const c = walletGuideContentFor(locale);
      expect(c.storeMoveNote).not.toContain('UPBOND');
      expect(c.storeMoveNote).toContain(locale === 'ja' ? '利用料がかかります' : 'a fee applies');
      expect(c.storeMoveLink.path).toBe('/create');
      expect(existsSync(path.join(PAGE_DIR, 'create', 'page.tsx'))).toBe(true);
    }
  });

  // 前後のガイド (JPYC で支払う・モバイルオーダー) へは「前へ / 次へ」で行く (tests/app/guide-wallet.test.tsx)。
  it('リンク先: 「スキャンして支払う」(/scan) は「JPYC で支払う」と同じ', () => {
    for (const locale of LOCALES) {
      expect(walletGuideContentFor(locale).scanCta).toEqual(payGuideContentFor(locale).scanCta);
    }
  });

  it('おすすめのウォレットの下の note 記事は「JPYC で支払う」と同じ記事・同じ名前', () => {
    for (const locale of LOCALES) {
      expect(walletGuideContentFor(locale).noteLink).toEqual(payGuideContentFor(locale).jpycNoteLink);
    }
  });

  it('metadata: canonical /{locale}/guide/wallet・hreflang ja/en', () => {
    for (const locale of LOCALES) {
      const m = walletGuideMetadata(locale);
      expect(m.title).toBe(`${walletGuideContentFor(locale).metaTitle} · OpenPay`);
      expect(m.alternates?.canonical).toBe(`/${locale}/guide/wallet`);
      expect(Object.keys(m.alternates?.languages ?? {}).sort()).toEqual(expect.arrayContaining(['ja', 'en']));
    }
  });
});
