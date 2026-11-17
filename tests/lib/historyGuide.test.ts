// /guide/history「取引履歴と会計 CSV」の content (lib/historyGuide.ts) の検査:
// - 本文は運営者の承認済みの文 (2026-11-18) のまま (ja)。ja / en の形がそろう
// - 履歴の上限の件数は HISTORY_MAX_ENTRIES から描く (ガイド・llms.txt とも)。「QR を閉じてから 60 秒」は見張りの定数と一致
// - 会計 CSV の形式の名前は、履歴ページの選択肢 (History.accountingFormat*) にある名前
// - 料率・利用料・CSV パス (CSV の有料化) に触れない

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';
import { HISTORY_MAX_ENTRIES } from '@/lib/history';
import { historyGuideContentFor, historyGuideMetadata, type HistoryGuideContent } from '@/lib/historyGuide';
import { QR_SALE_KEEP_AFTER_HIDE_MS } from '@/lib/qrSaleWatch';

const MAX = HISTORY_MAX_ENTRIES.toLocaleString('en-US');

function allText(c: HistoryGuideContent): string[] {
  return [
    c.metaTitle,
    c.metaDescription,
    c.subtitle,
    c.lead,
    c.ctaOpen,
    c.inHistoryTitle,
    ...c.inHistory,
    c.notInHistoryTitle,
    ...c.notInHistory,
    c.notInHistoryCheck,
    c.csvTitle,
    c.csvBody,
    c.storageTitle,
    c.storageBody,
    c.ctaTitle,
  ];
}

describe('取引履歴のガイド (content)', () => {
  it('ja の本文は承認済みの文のまま (2026-11-18)', () => {
    const c = historyGuideContentFor('ja');
    expect(c.lead).toBe(
      '取引履歴は、このブラウザに保存される売上と支払いの控えです。OpenPay のサーバーには送りません。会計 CSV に書き出して、会計ソフトに取り込めます。',
    );
    expect(c.inHistoryTitle).toBe('履歴に売上が出る払い方');
    expect(c.inHistory).toEqual([
      'お客様がお店の QR (決済QR・レジ) を JPYC のガス代不要の払い方で払ったとき (QR を出していた端末に・QR を閉じてから 60 秒まで)',
      'お店の端末で送る (その端末に)',
      'モバイルオーダー (店主としてサインインし、受注の画面を開いた端末に)',
    ]);
    expect(c.notInHistoryTitle).toBe('履歴に出ない入金');
    // 承認の文は「・」で並べた 1 文。一覧にするために「・」で分けただけで、並びと語は変えない。
    expect(`${c.notInHistory.join('・')}。${c.notInHistoryCheck}`).toBe(
      '通常決済 (ガス代を自分で払う払い方)・USDC・ウォレットのアプリで読む QR・注文リンク・QR を閉じて 60 秒より後や、受け取るページを離れた後に届いた入金・ほかの端末やブラウザで受けた入金。これらは受取のウォレットか、ブロックチェーンのエクスプローラーで確かめてください。',
    );
    expect(c.csvTitle).toBe('会計 CSV');
    expect(c.csvBody).toBe('成功した売上だけを書き出します (freee・弥生・マネーフォワードの形式)。勘定科目は履歴ページで変えられます。');
    expect(c.storageTitle).toBe('保存の注意');
    expect(c.storageBody).toBe(
      `履歴はブラウザごとに最大 ${MAX} 件で、超えると古いものから消えます。ブラウザのデータを消すと履歴も消えるので、こまめに CSV を書き出してください。`,
    );
  });

  it('ja と en の形がそろい、未知のロケールは ja', () => {
    const a = historyGuideContentFor('ja');
    const b = historyGuideContentFor('en');
    expect(b.inHistory).toHaveLength(a.inHistory.length);
    expect(b.notInHistory).toHaveLength(a.notInHistory.length);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect(historyGuideContentFor('fr')).toBe(a);
    for (const text of [...allText(a), ...allText(b)]) expect(text.trim().length, text).toBeGreaterThan(0);
  });

  it.each(['ja', 'en'] as const)('%s: 履歴の上限は HISTORY_MAX_ENTRIES の値 (承認の文の 1,000 件)', (locale) => {
    expect(HISTORY_MAX_ENTRIES).toBe(1000);
    expect(MAX).toBe('1,000');
    const c = historyGuideContentFor(locale);
    expect(c.storageBody).toContain(locale === 'ja' ? `最大 ${MAX} 件` : `up to ${MAX} entries`);
  });

  it.each(['ja', 'en'] as const)('%s: 「QR を閉じてから 60 秒」は見張りの定数 (QR_SALE_KEEP_AFTER_HIDE_MS) と一致する', (locale) => {
    const seconds = QR_SALE_KEEP_AFTER_HIDE_MS / 1000;
    expect(seconds).toBe(60);
    const c = historyGuideContentFor(locale);
    const unit = locale === 'ja' ? `${seconds} 秒` : `${seconds} seconds`;
    expect(c.inHistory[0]).toContain(unit);
    expect(c.notInHistory.some((item) => item.includes(unit))).toBe(true);
  });

  it.each([
    ['ja', ['freee', '弥生', 'マネーフォワード']],
    ['en', ['freee', 'Yayoi', 'Money Forward']],
  ] as const)('%s: 会計 CSV の形式の名前は、履歴ページの選択肢にある名前', (locale, names) => {
    const h = (locale === 'ja' ? ja : en).History;
    const options = [h.accountingFormatFreee, h.accountingFormatYayoi, h.accountingFormatMf, h.accountingFormatYayoiNative];
    const c = historyGuideContentFor(locale);
    for (const name of names) {
      expect(c.csvBody).toContain(name);
      expect(options.some((option) => option.includes(name)), `${name} が選択肢に無い`).toBe(true);
    }
  });

  // 「ガス代不要」(no-gas-fee) と「ガス代を自分で払う」(gas fee) は払い方の名前なので除く。
  it.each(['ja', 'en'] as const)('%s: 料率・利用料・CSV パスに触れない', (locale) => {
    for (const text of allText(historyGuideContentFor(locale))) {
      expect(text, text).not.toMatch(/[0-9]\s*%|利用料|手数料|(?<!gas[- ])\bfees?\b|パス|\bpass\b/i);
    }
  });

  it('metadata: canonical /{locale}/guide/history・hreflang ja/en・<title> に OpenPay は 1 回', () => {
    for (const locale of ['ja', 'en'] as const) {
      const m = historyGuideMetadata(locale);
      expect(m.title).toBe(historyGuideContentFor(locale).metaTitle);
      expect(m.alternates?.canonical).toBe(`/${locale}/guide/history`);
      expect(m.alternates?.languages).toEqual({ ja: '/ja/guide/history', en: '/en/guide/history' });
      expect(String(m.title).match(/OpenPay/g)).toHaveLength(1);
    }
  });

  it('llms.txt にガイドの 1 行があり、上限の件数は HISTORY_MAX_ENTRIES の値', () => {
    const llms = readFileSync(join(process.cwd(), 'public', 'llms.txt'), 'utf8');
    const line = llms.split('\n').find((l) => l.includes('(https://open-pay.jp/ja/guide/history)'));
    expect(line).toBeDefined();
    expect(line).toContain(`最大 ${MAX} 件`);
    expect(line).toContain(`${QR_SALE_KEEP_AFTER_HIDE_MS / 1000} 秒`);
  });
});
