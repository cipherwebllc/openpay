// /guide/history「取引履歴と会計 CSV」の content (lib/historyGuide.ts) の検査:
// - 本文は運営者の承認済みの文 (2026-11-18・同日の直し「直す案で」を含む) に、2026-11-19 の通常決済の直し (① に通常決済を足す・
//   「履歴に出ない入金」から通常決済を外す) を入れた文のまま (ja)。ja / en の形がそろう
// - 文が言う事実をコードと照合する:
//   - 上限の件数: 受取の履歴 = HISTORY_MAX_ENTRIES・支払いの控え = PAYER_RECEIPTS_MAX (ガイド・llms.txt とも)
//   - 「QR を閉じてから 60 秒」= 見張りの QR_SALE_KEEP_AFTER_HIDE_MS
//   - ① は金額を入れて画面に表示している QR だけ = 決済QR の useQrBillKey の url / shown の条件
//   - ① の「通常決済も」= 払う側が対象の通常決済の送金に印を付け、お店の端末が同じ印で照合する (hooks/useStdBillMark.ts・lib/qrSaleWatch.ts)
//   - ③ のモバイルオーダーは、通常決済の受注も履歴の行になる (lib/orderFeedHistory.ts)
//   - ② の名前 = 画面の名前 (Create.storeDeviceStatusLabel)
// - 会計 CSV の形式の名前は、履歴ページの選択肢 (History.accountingFormat*) にある名前
// - 料率・利用料・CSV パス (CSV の有料化) に触れない

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';
import { HISTORY_MAX_ENTRIES } from '@/lib/history';
import { historyGuideContentFor, historyGuideMetadata, type HistoryGuideContent } from '@/lib/historyGuide';
import { buildOrderSaleEntry, isRecordableOrder } from '@/lib/orderFeedHistory';
import type { StoredOrder } from '@/lib/orderRelay';
import { PAYER_RECEIPTS_MAX } from '@/lib/payerReceipt';
import { QR_SALE_KEEP_AFTER_HIDE_MS } from '@/lib/qrSaleWatch';
import { deploymentForSlug } from '@/lib/tokens';

const MAX = HISTORY_MAX_ENTRIES.toLocaleString('en-US');
const RECEIPTS = PAYER_RECEIPTS_MAX.toLocaleString('en-US');

function allText(c: HistoryGuideContent): string[] {
  return [
    c.metaTitle,
    c.metaDescription,
    c.subtitle,
    c.lead,
    c.ctaOpen,
    c.inHistoryTitle,
    ...c.inHistory.flatMap((item) => [item.mark, item.text]),
    c.inHistoryNote,
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
  it('ja の本文は承認済みの文 (2026-11-18) に、通常決済の直し (2026-11-19) を入れた文のまま', () => {
    const c = historyGuideContentFor('ja');
    expect(c.lead).toBe(
      '取引履歴は、このブラウザに保存される売上と支払いの控えです。OpenPay のサーバーには送りません。会計 CSV に書き出して、会計ソフトに取り込めます。',
    );
    expect(c.inHistoryTitle).toBe('履歴に売上が出る払い方');
    expect(c.inHistory).toEqual([
      {
        mark: '①',
        text: 'お客様がお店の QR (決済QR・レジ) を JPYC で払ったとき (ガス代不要の払い方も、ガス代を自分で払う通常決済も・QR を出していた端末に・QR を閉じてから 60 秒まで)',
      },
      { mark: '②', text: 'お店がガス代を肩代わりして送る支払い (その端末に)' },
      { mark: '③', text: 'モバイルオーダー (店主としてサインインし、受注の画面を開いた端末に)' },
    ]);
    expect(c.inHistoryNote).toBe(
      '① は、金額を入れて画面に表示している QR が対象です。印刷・画像の保存・リンクのコピーをした QR と、金額なしの QR は対象外です。',
    );
    expect(c.notInHistoryTitle).toBe('履歴に出ない入金');
    // 承認の文は「・」で並べた 1 文。一覧にするために「・」で分けただけで、並びと語は変えない。
    expect(`${c.notInHistory.join('・')}。${c.notInHistoryCheck}`).toBe(
      'USDC・ウォレットのアプリで読む QR・印刷・保存・コピーした QR や、金額なしの QR での入金・注文リンク・QR を閉じて 60 秒より後や、受け取るページを離れた後に届いた入金・ほかの端末やブラウザで受けた入金。これらは受取のウォレットか、ブロックチェーンのエクスプローラーで確かめてください。',
    );
    expect(c.csvTitle).toBe('会計 CSV');
    expect(c.csvBody).toBe('成功した売上だけを書き出します (freee・弥生・マネーフォワードの形式)。勘定科目は履歴ページで変えられます。');
    expect(c.storageTitle).toBe('保存の注意');
    expect(c.storageBody).toBe(
      `受取の履歴はブラウザごとに最大 ${MAX} 件 (支払いの控えは ${RECEIPTS} 件) で、超えると古いものから消えます。ブラウザのデータを消すと履歴も消えるので、こまめに CSV を書き出してください。`,
    );
  });

  it('ja と en の形がそろい (印も同じ)、未知のロケールは ja', () => {
    const a = historyGuideContentFor('ja');
    const b = historyGuideContentFor('en');
    expect(b.inHistory.map((item) => item.mark)).toEqual(a.inHistory.map((item) => item.mark));
    expect(b.notInHistory).toHaveLength(a.notInHistory.length);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect(historyGuideContentFor('fr')).toBe(a);
    for (const text of [...allText(a), ...allText(b)]) expect(text.trim().length, text).toBeGreaterThan(0);
  });

  it.each(['ja', 'en'] as const)('%s: 一覧の下の 1 行は ① を指す (印の付け替えで指す先がずれない)', (locale) => {
    const c = historyGuideContentFor(locale);
    expect(c.inHistory[0].mark).toBe('①');
    expect(c.inHistoryNote.startsWith(c.inHistory[0].mark)).toBe(true);
  });

  it.each(['ja', 'en'] as const)('%s: 上限は受取の履歴 HISTORY_MAX_ENTRIES・支払いの控え PAYER_RECEIPTS_MAX の値 (承認の文の 1,000 件・200 件)', (locale) => {
    expect(HISTORY_MAX_ENTRIES).toBe(1000);
    expect(PAYER_RECEIPTS_MAX).toBe(200);
    expect(MAX).toBe('1,000');
    expect(RECEIPTS).toBe('200');
    const c = historyGuideContentFor(locale);
    if (locale === 'ja') {
      expect(c.storageBody).toContain(`受取の履歴はブラウザごとに最大 ${MAX} 件 (支払いの控えは ${RECEIPTS} 件)`);
    } else {
      expect(c.storageBody).toContain(`up to ${MAX} entries of payments received (and ${RECEIPTS} receipts of payments made)`);
    }
  });

  it.each(['ja', 'en'] as const)('%s: 「QR を閉じてから 60 秒」は見張りの定数 (QR_SALE_KEEP_AFTER_HIDE_MS) と一致する', (locale) => {
    const seconds = QR_SALE_KEEP_AFTER_HIDE_MS / 1000;
    expect(seconds).toBe(60);
    const c = historyGuideContentFor(locale);
    const unit = locale === 'ja' ? `${seconds} 秒` : `${seconds} seconds`;
    expect(c.inHistory[0].text).toContain(unit);
    expect(c.notInHistory.some((item) => item.includes(unit))).toBe(true);
  });

  // ① の対象 (金額を入れて画面に表示している QR) の出どころ。決済QR は、会計の印 (bill key) を「JPYC の回収・金額あり」と
  // 「JPYC の通常決済・金額あり」の URL にだけ渡し、QR の画面を出している間 (お店負担の QR でない) だけ載せる。印のない QR の
  // 入金は見張りが行にしない。印刷・保存・コピーが印のない元の URL を使うことは tests/components/QrGenerator.billKey.test.tsx が
  // 描画で確かめる。
  it('① は金額を入れて画面に表示している QR だけ: 決済QR の useQrBillKey の url / shown の条件 (コード照合)', () => {
    const src = readFileSync(join(process.cwd(), 'components', 'QrGenerator.tsx'), 'utf8');
    const start = src.indexOf('useQrBillKey({');
    expect(start).toBeGreaterThan(-1);
    const call = src.slice(start, src.indexOf('});', start));
    expect(call).toContain("url: (isJpycRecover || isJpycStandard) && mode === 'amount' ? payUrl : ''");
    expect(call).toMatch(/shown: qrModalOpen && /);
  });

  // ① の「ガス代を自分で払う通常決済も」の出どころ (2026-11-19 に全員へ): 通常決済の QR にも印 (bk) が載り、払う側の通常決済は、
  // 対象の会計 (/pay は JPYC・金額あり・分配なし / /checkout は JPYC のレジの会計) の transfer の calldata に、URL の bk から作った印を
  // 足す (端末ごとのスイッチは無い)。お店の端末の見張り (lib/qrSaleWatch.ts) は、その印の付いた Transfer を照合して行にする。
  // 振る舞いは tests/hooks/useStdBillMark.test.tsx・tests/components/stdBillMarkForms.integration.test.tsx・
  // tests/components/qrSaleHistory.standardParity.test.tsx (払う側の calldata = お店の照合の calldata・印の無い入金は行にしない)。
  it('通常決済の払う側は、対象の会計の送金に印を付け (端末ごとのスイッチは無い)、お店の端末は同じ印で照合する = ガイドの ① に通常決済が入る', () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
    // 印を作るのは印の hook だけ (フォームと通常決済の hook は作り方を知らない)。hook が見るのは対象か (eligible) と URL の bk だけ。
    for (const file of ['hooks/useStandardPayment.ts', 'components/PaymentForm.tsx', 'components/CheckoutForm.tsx']) {
      expect(read(file)).not.toMatch(/billKeyStdMark/);
    }
    const hook = read('hooks/useStdBillMark.ts');
    expect(hook).toContain('if (!eligible) return;');
    expect(hook).toContain('if (!eligible || !prepared) return undefined;');
    expect(hook).toContain('const mark = billKeyStdMark(billKey);');
    expect(hook).not.toMatch(/(local|session)Storage|Trial/);
    // 2 つのフォームは、通常決済の分岐で印を取り、あれば mutate の第 2 引数に渡す。対象の条件はフォームが決める。
    const pay = read('components/PaymentForm.tsx');
    expect(pay).toContain('const takeStdBillMark = useStdBillMark(isJpyc && isFixed && !hasSplit, params);');
    const checkout = read('components/CheckoutForm.tsx');
    expect(checkout).toMatch(/useStdBillMark\(\s*isJpyc &&\s*!params\.webhook &&\s*!params\.storeHandle &&\s*!params\.feeKind &&\s*!params\.orderId &&\s*params\.ship !== 'ask' &&\s*!params\.submit,\s*params,\s*\)/);
    for (const form of [pay, checkout]) expect(form).toContain('if (stdMark) standard.mutate(standardParams, stdMark);');
    // お店の端末: 見張りが、通常決済の会計 (readQrStdBill・印 = 同じ billKeyStdMark) の印の付いた Transfer を数えて行にする。
    const watch = read('lib/qrSaleWatch.ts');
    expect(watch).toMatch(/\breadQrStdBill\(input\)/);
    expect(watch).toMatch(/\bstdMarkCount\(tx, transfer, /);
    expect(read('lib/qrSaleHistory.ts')).toContain('const mark = billKeyStdMark(input.billKey);');
    // ガイド: ① に通常決済が入り、「履歴に出ない入金」に通常決済は無い (ja・en)。
    const jaGuide = historyGuideContentFor('ja');
    const enGuide = historyGuideContentFor('en');
    expect(jaGuide.inHistory[0].text).toContain('ガス代を自分で払う通常決済も');
    expect(enGuide.inHistory[0].text).toContain('a standard payment where they pay the gas fee themselves');
    for (const item of jaGuide.notInHistory) expect(item).not.toContain('通常決済');
    for (const item of enGuide.notInHistory) expect(item).not.toMatch(/standard payment/i);
  });

  // ③ のモバイルオーダーは、払い方によらない: 通常決済で払われたモバイルオーダーの受注 (unboundPayment) も、
  // 受注の画面を開いた端末で履歴の行 (通常決済の行) になる。
  it('モバイルオーダーの通常決済の受注は、履歴の行になる (通常決済の行)', () => {
    const jpyc = deploymentForSlug('jpyc', 'polygon');
    const merchant: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
    const order: StoredOrder = {
      orderId: '7K3Q',
      items: [{ name: '水', qty: 2, price: '500' }],
      table: 'テーブル 3',
      amount: (990n * 10n ** 18n).toString(),
      txHash: `0x${'a'.repeat(64)}` as Hex,
      chainId: jpyc.chainId,
      from: '',
      ts: 1_763_000_000_000,
      fulfilled: false,
      unboundPayment: true,
    };
    expect(isRecordableOrder(order)).toBe(true);
    const entry = buildOrderSaleEntry(order, merchant, { kind: 'direct', customer: null, blockNumber: 5n });
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({ status: 'success', payMode: 'standard', merchant });
  });

  it.each(['ja', 'en'] as const)('%s: ② の名前は画面の名前 (Create.storeDeviceStatusLabel) と同じ', (locale) => {
    const label = (locale === 'ja' ? ja : en).Create.storeDeviceStatusLabel;
    expect(historyGuideContentFor(locale).inHistory[1].text.startsWith(label)).toBe(true);
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

  it('llms.txt にガイドの 1 行があり、上限の件数・60 秒・② の名前・① の通常決済はガイドと同じ (出ない入金に通常決済は無い)', () => {
    const llms = readFileSync(join(process.cwd(), 'public', 'llms.txt'), 'utf8');
    const line = llms.split('\n').find((l) => l.includes('(https://open-pay.jp/ja/guide/history)'));
    expect(line).toBeDefined();
    expect(line).toContain(`受取の履歴はブラウザごとに最大 ${MAX} 件・支払いの控えは ${RECEIPTS} 件`);
    expect(line).toContain(`${QR_SALE_KEEP_AFTER_HIDE_MS / 1000} 秒`);
    expect(line).toContain(ja.Create.storeDeviceStatusLabel);
    expect(line).toContain('JPYC で払ったとき (ガス代不要の払い方も通常決済も・');
    // 通常決済が出るのは ① の中の 1 回だけ (「出ない入金」の並びに無い)。
    expect(line!.match(/通常決済/g)).toHaveLength(1);
    expect(line!.slice(line!.indexOf('と出ない入金 ('))).not.toContain('通常決済');
    expect(line).toContain('金額を入れて画面に表示している QR だけ');
  });
});
