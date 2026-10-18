// /guide/pay 「JPYC で支払う」の content SOT (lib/payGuide.ts) のフェンス:
// (1) ja/en の構造 parity + 全 leaf 非空 (2) 料率・金額・「無料」・チェーン名・USDC を書かない (掟 14)
// (3) 本文が引用する画面の文言が messages と一致する (画面の文言を変えたらガイドも直す・掟 4)
// (4) 署名の期限「5 分以内」が実装値と一致する (5) リンク先のページが実在し、JPYC の入手先が lib/links.ts と同じ
// (6) metadata (canonical・hreflang)。

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { PAY_GUIDE_JPYC_NOTE, payGuideContentFor, payGuideMetadata } from '@/lib/payGuide';
import { startGuideContentFor } from '@/lib/startGuide';
import { guideNavFor } from '@/lib/guideNav';
import { getExchangeLink } from '@/lib/links';
import { AUTHORIZATION_VALIDITY_WINDOW_SEC } from '@/lib/jpycEip3009';
import { STORE_DEVICE_MAX_VALIDITY_SEC } from '@/lib/storeDevicePayment';

const LOCALES = ['ja', 'en'] as const;
const PAGE_DIR = path.join(process.cwd(), 'app', '[locale]');

function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { __array: value.length ? shape(value[0]) : 'empty', len: value.length };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = shape((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return typeof value;
}

function leaves(value: unknown, at: string, sink: [string, string][]): void {
  if (typeof value === 'string') {
    sink.push([at, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${at}[${i}]`, sink));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, `${at}.${k}`, sink);
  }
}

// リンク先 (path / href) は文言ではないので除く。
function copyLeaves(locale: string): [string, string][] {
  const sink: [string, string][] = [];
  leaves(payGuideContentFor(locale), locale, sink);
  return sink.filter(([at]) => !/\.(path|href)$/.test(at));
}

function allCopy(locale: string): string {
  return copyLeaves(locale)
    .map(([, text]) => text)
    .join('\n');
}

describe('payGuide content', () => {
  it('未知ロケールは ja へ・en は別内容', () => {
    expect(payGuideContentFor('xx')).toBe(payGuideContentFor('ja'));
    expect(payGuideContentFor('en')).not.toBe(payGuideContentFor('ja'));
  });

  it('ja / en が同一構造 (配列の長さまで一致) で全 leaf 非空', () => {
    expect(shape(payGuideContentFor('en'))).toEqual(shape(payGuideContentFor('ja')));
    for (const locale of LOCALES) {
      const sink: [string, string][] = [];
      leaves(payGuideContentFor(locale), locale, sink);
      for (const [at, text] of sink) {
        expect(text.trim().length, `${at} が空`).toBeGreaterThan(0);
      }
    }
  });

  it('支払いの流れは 1..6 の連番・署名で求められることは 5 点', () => {
    for (const locale of LOCALES) {
      const c = payGuideContentFor(locale);
      expect(c.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(c.sign).toHaveLength(5);
    }
  });

  it('料率・金額・「無料」・チェーン名・USDC を書かない (掟 14 の同期面を増やさない)', () => {
    // POL は「ガス代用のトークン (POL など)」の例としてだけ出す (画面にもトークン名が出る)。チェーン名は書かない。
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

  it('OpenPay が JPYC を発行・販売・交換すると読める書き方をせず、しないことを書く', () => {
    expect(payGuideContentFor('ja').jpycBody.join('')).toContain('OpenPay は JPYC の発行・販売・交換をしていません');
    expect(payGuideContentFor('en').jpycBody.join('')).toContain('OpenPay does not issue, sell or exchange JPYC');
  });

  // 本文は画面の文言を「」/“” で引用する。画面の文言を変えたらここが落ちる = ガイドも直す合図。
  it('引用している画面の文言が messages と一致する', () => {
    const quotedJa = [
      ja.Scan.pageTitle,
      ja.Nav.pay,
      ja.Nav.connect,
      ja.Scan.startCameraButton,
      ja.Scan.manualUrlSummary,
      ja.Scan.balancesTitle,
      ja.PaymentForm.btnPay.replace('{amount}', '◯◯ JPYC'),
      ja.PaymentForm.standardModeTitle,
      ja.PaymentForm.responseUnknownTitle,
      ja.PaymentForm.pendingTitle,
      ja.RelayFallback.title,
      ja.RelayFallback.switchButton,
      ja.SuccessOverlay.title,
      ja.PayerReceipt.sectionTitle,
      ja.ConnectButton.openInMetaMask,
      '残高が不足しています',
    ];
    const textJa = allCopy('ja');
    for (const label of quotedJa) expect(textJa, label).toContain(`「${label}」`);
    expect(ja.PaymentForm.insufficientBalance.startsWith('残高が不足しています')).toBe(true);

    const quotedEn = [
      en.Scan.pageTitle,
      en.Nav.pay,
      en.Nav.connect,
      en.Scan.startCameraButton,
      en.Scan.manualUrlSummary,
      en.Scan.balancesTitle,
      en.PaymentForm.btnPay.replace('{amount}', '◯◯ JPYC'),
      en.PaymentForm.standardModeTitle,
      en.PaymentForm.responseUnknownTitle,
      en.PaymentForm.pendingTitle,
      en.RelayFallback.title,
      en.RelayFallback.switchButton,
      en.SuccessOverlay.title,
      en.PayerReceipt.sectionTitle,
      en.ConnectButton.openInMetaMask,
      'Insufficient balance',
    ];
    const textEn = allCopy('en');
    for (const label of quotedEn) expect(textEn, label).toContain(`“${label}”`);
    expect(en.PaymentForm.insufficientBalance.startsWith('Insufficient balance')).toBe(true);
  });

  it('署名で求められることは画面 (SignReassurance) と同じ事実を書く', () => {
    expect(ja.SignReassurance.badgeApprove.startsWith('Approve (利用許可) は求めません')).toBe(true);
    expect(payGuideContentFor('ja').sign.join('\n')).toContain('Approve (利用許可) は求めません');
    expect(en.SignReassurance.badgeApprove.startsWith('No Approve (spending allowance) is requested')).toBe(true);
    expect(payGuideContentFor('en').sign.join('\n')).toContain('No Approve (spending allowance) is requested');
  });

  // 「5 分以内」は中継 (5 分) と、より短い「お店の端末で送る」の両方に当てはまる書き方。
  it('署名の期限「5 分以内」が実装値と一致する (ドリフト検出)', () => {
    const minutes = AUTHORIZATION_VALIDITY_WINDOW_SEC / 60;
    expect(Number.isInteger(minutes)).toBe(true);
    expect(STORE_DEVICE_MAX_VALIDITY_SEC).toBeLessThanOrEqual(AUTHORIZATION_VALIDITY_WINDOW_SEC);
    expect(payGuideContentFor('ja').sign.join('\n')).toContain(`署名は ${minutes} 分以内に自動で失効し、1 回しか使えません`);
    expect(payGuideContentFor('en').sign.join('\n')).toContain(`expires automatically within ${minutes} minutes and can be used only once`);
  });

  // 関連ガイドの行き先と名前は描画側 (GuideRelated) が目次 (guideNav) から取る (tests/app/guide-pay.test.tsx)。
  it('リンク先: 「スキャンして支払う」(/scan) のページが実在する', () => {
    for (const locale of LOCALES) {
      const c = payGuideContentFor(locale);
      expect(c.scanCta.path).toBe('/scan');
      expect(existsSync(path.join(PAGE_DIR, 'scan', 'page.tsx'))).toBe(true);
      expect(c.scanCta.label).toBe((locale === 'en' ? en : ja).Scan.pageTitle);
    }
  });

  it('ウォレット選びの note 記事は導入前チェックリスト (lib/startGuide.ts) と同じ記事', () => {
    const startNote = startGuideContentFor('ja').sections.flatMap((sec) => sec.externalLinks ?? []).find((l) => l.href.includes('note.com'));
    expect(startNote?.href).toBe(PAY_GUIDE_JPYC_NOTE);
    for (const locale of LOCALES) {
      expect(payGuideContentFor(locale).jpycNoteLink.href).toBe(PAY_GUIDE_JPYC_NOTE);
    }
  });

  it('JPYC の入手先は lib/links.ts の JPYC EX と同じ公式サイト (https)', () => {
    for (const locale of LOCALES) {
      const { href } = payGuideContentFor(locale).jpycLink;
      expect(href).toMatch(/^https:\/\//);
      expect(href).toBe(getExchangeLink('jpyc', locale).url);
    }
  });

  it('metadata: canonical /{locale}/guide/pay・hreflang ja/en・未知ロケールは ja・OpenPay は 1 回', () => {
    for (const locale of LOCALES) {
      const m = payGuideMetadata(locale);
      const c = payGuideContentFor(locale);
      expect(m.title).toBe(`${c.metaTitle} · OpenPay`);
      expect(String(m.title).match(/OpenPay/g)).toHaveLength(1);
      expect(m.description).toBe(c.metaDescription);
      expect(m.alternates?.canonical).toBe(`/${locale}/guide/pay`);
      expect(m.alternates?.languages).toEqual({ ja: '/ja/guide/pay', en: '/en/guide/pay' });
      expect(m.openGraph?.images).toBeDefined();
    }
    expect(payGuideMetadata('fr').alternates?.canonical).toBe('/ja/guide/pay');
  });
});
