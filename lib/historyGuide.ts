// /guide/history「取引履歴と会計 CSV」お店向けガイドの content SOT (ja/en 同梱)。
// 取引履歴 (/history・このブラウザの localStorage) に売上が出る払い方と出ない入金、会計 CSV、保存の注意をまとめる。
// 本文 (lead・各節) は運営者の承認済みの文 (2026-11-18)。表の外で作った短い文 (メタ・副題・ボタン・帯の見出し) も、
// その中身から作り、新しい事実を足さない。
// ⚠️ 履歴の上限の件数は lib/history/model.ts の HISTORY_MAX_ENTRIES から描く (直書きしない)。
// 「QR を閉じてから 60 秒」は lib/qrSaleWatch.ts の QR_SALE_KEEP_AFTER_HIDE_MS と tests/lib/historyGuide.test.ts で照合する
// (qrSaleWatch は viem を読むので、この server の content からは import しない)。
// 会計 CSV の形式の名前は、履歴ページの選択肢 (messages の History.accountingFormat*) とテストで照合する。
// CSV パス (CSV の有料化・既定 OFF) には触れない。料率・利用料は書かない (掟 14 の同期面を増やさない)。
// 長文を messages/*.json に置かない方針は lib/orderLinkGuide.ts と同じ。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
import { HISTORY_MAX_ENTRIES } from '@/lib/history/model';

/** 履歴の上限の件数 (3 桁区切り・ja / en 同じ表記 = 「1,000」)。 */
const MAX_ENTRIES = HISTORY_MAX_ENTRIES.toLocaleString('en-US');

export type HistoryGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;

  readonly subtitle: string;
  /** はじめに (ページの頭のリード)。 */
  readonly lead: string;
  /** ページの頭と末尾の帯のボタン (/history へ)。 */
  readonly ctaOpen: string;

  readonly inHistoryTitle: string;
  readonly inHistory: readonly string[];

  readonly notInHistoryTitle: string;
  readonly notInHistory: readonly string[];
  /** 出ない入金の確かめ方 (一覧の下の 1 文)。 */
  readonly notInHistoryCheck: string;

  readonly csvTitle: string;
  readonly csvBody: string;

  readonly storageTitle: string;
  readonly storageBody: string;

  readonly ctaTitle: string;
};

const JA: HistoryGuideContent = {
  metaTitle: '取引履歴と会計 CSV — 履歴に出る払い方・出ない入金 | OpenPay',
  metaDescription:
    '取引履歴は、このブラウザに保存される売上と支払いの控えです。履歴に売上が出る払い方と出ない入金、会計 CSV の書き出し (freee・弥生・マネーフォワードの形式)、保存の注意をまとめています。',

  subtitle: '履歴に出る払い方・出ない入金と、会計 CSV',
  lead: '取引履歴は、このブラウザに保存される売上と支払いの控えです。OpenPay のサーバーには送りません。会計 CSV に書き出して、会計ソフトに取り込めます。',
  ctaOpen: '取引履歴を開く',

  inHistoryTitle: '履歴に売上が出る払い方',
  inHistory: [
    'お客様がお店の QR (決済QR・レジ) を JPYC のガス代不要の払い方で払ったとき (QR を出していた端末に・QR を閉じてから 60 秒まで)',
    'お店の端末で送る (その端末に)',
    'モバイルオーダー (店主としてサインインし、受注の画面を開いた端末に)',
  ],

  notInHistoryTitle: '履歴に出ない入金',
  notInHistory: [
    '通常決済 (ガス代を自分で払う払い方)',
    'USDC',
    'ウォレットのアプリで読む QR',
    '注文リンク',
    'QR を閉じて 60 秒より後や、受け取るページを離れた後に届いた入金',
    'ほかの端末やブラウザで受けた入金',
  ],
  notInHistoryCheck: 'これらは受取のウォレットか、ブロックチェーンのエクスプローラーで確かめてください。',

  csvTitle: '会計 CSV',
  csvBody: '成功した売上だけを書き出します (freee・弥生・マネーフォワードの形式)。勘定科目は履歴ページで変えられます。',

  storageTitle: '保存の注意',
  storageBody: `履歴はブラウザごとに最大 ${MAX_ENTRIES} 件で、超えると古いものから消えます。ブラウザのデータを消すと履歴も消えるので、こまめに CSV を書き出してください。`,

  ctaTitle: 'こまめに CSV を書き出す',
};

const EN: HistoryGuideContent = {
  metaTitle: 'History & accounting CSV — what shows up in your transaction history | OpenPay',
  metaDescription:
    'Your transaction history is a record of sales and payments saved in this browser. Which payments show up as sales and which incoming payments do not, exporting the accounting CSV (freee, Yayoi or Money Forward format), and storage notes.',

  subtitle: 'What shows up in your history, what does not, and the accounting CSV',
  lead: 'Your transaction history is a record of sales and payments saved in this browser. It is not sent to OpenPay’s servers. You can export it as an accounting CSV and import it into your accounting software.',
  ctaOpen: 'Open transaction history',

  inHistoryTitle: 'Payments that show up as sales in your history',
  inHistory: [
    'When a customer pays your shop’s QR (Payment QR or Register) in JPYC with the no-gas-fee method (on the device that showed the QR, up to 60 seconds after the QR is closed)',
    'Sending from the shop’s device (on that device)',
    'Mobile ordering (on the device where you signed in as the shop owner and opened the Orders screen)',
  ],

  notInHistoryTitle: 'Incoming payments that do not show up in your history',
  notInHistory: [
    'Standard payments (where the payer pays the gas fee themselves)',
    'USDC',
    'QR codes scanned with a wallet app',
    'Order links',
    'Payments that arrive more than 60 seconds after the QR is closed, or after you leave the Receive page',
    'Payments received on another device or browser',
  ],
  notInHistoryCheck: 'Check these in your receiving wallet or on a blockchain explorer.',

  csvTitle: 'Accounting CSV',
  csvBody: 'Exports successful sales only (in freee, Yayoi or Money Forward format). You can change the account titles on the History page.',

  storageTitle: 'Storage notes',
  storageBody: `Each browser keeps up to ${MAX_ENTRIES} entries, and the oldest are deleted beyond that. Clearing your browser data also deletes the history, so export a CSV regularly.`,

  ctaTitle: 'Export a CSV regularly',
};

export function historyGuideContentFor(locale: string): HistoryGuideContent {
  return locale === 'en' ? EN : JA;
}

/** /guide/history の metadata (OG 画像は guide 共通の既定)。 */
export function historyGuideMetadata(locale: string): Metadata {
  const c = historyGuideContentFor(locale);
  return guidePageMetadata({
    locale,
    path: '/guide/history',
    title: c.metaTitle,
    description: c.metaDescription,
  });
}
