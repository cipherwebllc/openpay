// /guide/wallet「ウォレットを選ぶ」の content SOT (lib/walletGuide.ts) のフェンス:
// (1) ja/en の構造 parity + 全 leaf 非空 (2) 料率・金額・「無料」・チェーン名・USDC を書かない (掟 14)
// (3) 本文が引用する画面の文言が messages と一致する (4) リンク先のページが実在し、名前が目次と同じ
// (5) お店の QR の読み取り方 (ウォレットのアプリでは開かないものがある・2026-10-13 user 実機確認) を書く (6) metadata。

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { guideNavFor } from '@/lib/guideNav';
import { payGuideContentFor } from '@/lib/payGuide';
import { walletGuideContentFor, walletGuideMetadata } from '@/lib/walletGuide';

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
  return sink.filter(([at]) => !/\.path$/.test(at));
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
      for (const [at, text] of copyLeaves(locale)) {
        expect(AMOUNT.test(text), `${at} に金額・料率: ${text}`).toBe(false);
        expect(FORBIDDEN.test(text), `${at} に可変情報: ${text}`).toBe(false);
      }
    }
  });

  it('ウォレットは MetaMask → HashPort Wallet → マイナウォレットの 3 つ・WalletConnect は 1..4 の手順で検索の言葉まで書く', () => {
    expect(walletGuideContentFor('ja').wallets.map((w) => w.name)).toEqual(['MetaMask', 'HashPort Wallet', 'マイナウォレット']);
    expect(walletGuideContentFor('en').wallets.map((w) => w.name)).toEqual(['MetaMask', 'HashPort Wallet', 'MynaWallet']);
    for (const locale of LOCALES) {
      const c = walletGuideContentFor(locale);
      expect(c.wcSteps.map((s) => s.n)).toEqual([1, 2, 3, 4]);
      expect(c.wcSteps[1].body).toContain('HashPort');
      expect(c.wcSteps[1].body).toContain('Myna');
    }
  });

  it('お店の QR はスマホのカメラか「スキャンして支払う」で読む・ウォレットのアプリの読み取りでは開かないものがある', () => {
    const jaC = walletGuideContentFor('ja');
    expect(jaC.scanWays.map((w) => w.name)).toEqual(['スマホのカメラ', `「${ja.Scan.pageTitle}」`]);
    expect(jaC.scanNote).toContain('MetaMask は開けますが、マイナウォレットなどは開けません');
    expect(jaC.summary).toContain('ウォレットのアプリの QR 読み取りでは開かないものがあります');
    const enC = walletGuideContentFor('en');
    expect(enC.scanWays.map((w) => w.name)).toEqual(['Your phone camera', `“${en.Scan.pageTitle}”`]);
    expect(enC.scanNote).toContain('MetaMask can, but MynaWallet and some others cannot');
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
  });

  it('リンク先: 「スキャンして支払う」(/scan)・関連ガイドが実在し、名前は「JPYC で支払う」と目次と同じ', () => {
    for (const locale of LOCALES) {
      const c = walletGuideContentFor(locale);
      const nav = guideNavFor(locale);
      expect(c.scanCta).toEqual(payGuideContentFor(locale).scanCta);
      expect(c.related.map((l) => l.path)).toEqual(['/guide/pay', '/guide/mobile-order']);
      expect(c.related.map((l) => l.label)).toEqual([nav.items.pay.label, nav.items['mobile-order'].label]);
      for (const { path: p } of [c.scanCta, ...c.related]) {
        expect(existsSync(path.join(PAGE_DIR, ...p.split('/').filter(Boolean), 'page.tsx')), `${p} の page.tsx が無い`).toBe(true);
      }
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
