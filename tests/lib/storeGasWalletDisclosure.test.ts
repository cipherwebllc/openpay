// 「お店がガス代を肩代わりして送る」(内部名「お店の端末で送る」) の開示ドリフト・フェンス (掟 14)。
// lib/disclosedStoreGasWallet.ts (DISCLOSED_STORE_GAS_WALLET) から期待文字列を **導出** し、
// ① LP (messages Landing) ② 法務文書 (Terms・特商法・免責・プライバシー) ③ public/llms.txt と各ガイド、
// および実装 (lib/storeDevicePayment.ts の 1 wei・受け渡しの保管 10 分・点灯チェーン) が一致していることを固定する。
// 数値は直書きしない (直書きするとフェンス自体がドリフト源になる)。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

// mainnet・設定 (forwarder・手数料受取口・Avalanche の JPYC) がすべてそろった本番相当。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    isMainnet: true,
    env: {
      ...actual.env,
      networkEnv: 'mainnet',
      enableJpycAvalanche: true,
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

import { DISCLOSED_STORE_GAS_WALLET as D, LEGAL_ENTITY, disclosedStoreGasChains } from '@/lib/legal';
import { STORE_DEVICE_FEE_WEI, STORE_HANDOFF_TTL_SEC, storeDeviceChainIds } from '@/lib/storeDevicePayment';
import { avalanche, kaia, polygon } from 'viem/chains';
import { qrGuideContentFor } from '@/lib/qrGuide';
import { shopGuideContentFor } from '@/lib/shopGuide';
import { startGuideContentFor } from '@/lib/startGuide';
import { transparencyContentFor } from '@/lib/transparency';
import { NEWS_ITEMS } from '@/lib/news';

const WEI = `${D.feeWei} wei`;
// 本文に書く対象チェーンの並び (SOT から導出)
const CH_JA = disclosedStoreGasChains('ja');
const CH_EN = disclosedStoreGasChains('en');
const MIN = D.handoffRetentionSec / 60;
const [y, m, d] = D.effectiveDate.split('-').map(Number);
const JA_DATE = `${y} 年 ${m} 月 ${d} 日`;
const EN_DATE = `${new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${d}, ${y}`;

describe('「お店がガス代を肩代わりして送る」の開示 (DISCLOSED_STORE_GAS_WALLET)', () => {
  it('実装と一致する (1 wei・受け渡しの保管・mainnet の点灯チェーン = 開示したチェーン ∩ 設定済み)', () => {
    expect(STORE_DEVICE_FEE_WEI).toBe(BigInt(D.feeWei));
    expect(STORE_HANDOFF_TTL_SEC).toBe(D.handoffRetentionSec);
    expect(D.gasPayer).toBe('merchant');
    // 開示の名前は chainIds の名前と同じ並び (本文の名前と点灯チェーンをずらさない)
    const nameOf = (id: number) => [polygon, kaia, avalanche].find((c) => c.id === id)?.name;
    expect(D.chainNames).toEqual(D.chainIds.map(nameOf));
    // 設定がすべてそろった mainnet では、点灯するチェーン = 開示したチェーン (開示していないチェーンは点灯しない)
    expect(storeDeviceChainIds()).toEqual([...D.chainIds]);
  });

  it('施行日 (Terms・特商法・免責・プライバシー) は新設日と同じ', () => {
    expect(LEGAL_ENTITY.termsEffectiveDate).toBe(D.effectiveDate);
    expect(LEGAL_ENTITY.tokuteiEffectiveDate).toBe(D.effectiveDate);
    expect(LEGAL_ENTITY.disclaimerEffectiveDate).toBe(D.effectiveDate);
    expect(LEGAL_ENTITY.privacyEffectiveDate).toBe(D.effectiveDate);
  });

  it('規約: 定義 (6)(c)・第 3 条・第 5 条 (1) の除外・(11) (対象・対象外・0 円・1 wei の行き先・10 分・新設日)', () => {
    expect(ja.Terms.article2.body).toContain('(c) 店主が自ら管理する端末上のウォレット');
    expect(en.Terms.article2.body).toContain('(c) paths where the Merchant pays the Network Fee from a wallet on a device');
    for (const [body, words] of [
      [ja.Terms.article3.body, ['0 円', WEI, '当社指定ウォレットへ', `最長 ${MIN} 分`]],
      [en.Terms.article3.body, ['is 0', WEI, 'designated by the Company', `up to ${MIN} minutes`]],
    ] as const) {
      for (const w of words) expect(body).toContain(w);
    }
    expect(ja.Terms.article5.body).toContain('本条 (11) のお店がガス代を肩代わりして送る経路は対象外です');
    expect(en.Terms.article5.body).toContain('path in paragraph (11) are not in scope');
    const ja11 = ja.Terms.article5.body.split('(11)').at(-1)!;
    const en11 = en.Terms.article5.body.split('(11)').at(-1)!;
    for (const w of ['店頭レジ (POS)', '画面に表示した金額指定の決済QR', CH_JA, 'モバイル注文', 'チップ', '印刷・保存・URL のコピー', '金額を指定しない', '0 円', WEI, '当社指定ウォレットへ', `最長 ${MIN} 分`, JA_DATE]) {
      expect(ja11).toContain(w);
    }
    for (const w of ['in-store register (POS)', 'fixed-amount payment QR shown', CH_EN, 'mobile orders', 'tips', 'printed, saved or copied', 'no amount', 'is 0', WEI, 'designated by the Company', `up to ${MIN} minutes`, EN_DATE]) {
      expect(en11).toContain(w);
    }
  });

  it('特商法・免責・プライバシー', () => {
    const tj = ja.Tokutei.rows;
    const te = en.Tokutei.rows;
    expect(tj.serviceContent.value).toContain('お店がガス代を肩代わりして送る');
    expect(te.serviceContent.value).toContain('The shop pays the gas');
    for (const w of ['0 円', WEI, '当社指定ウォレットへ', '印刷・保存した決済QRは対象外', CH_JA]) expect(tj.price.value).toContain(w);
    for (const w of ['is 0', WEI, 'designated by the Company', 'printed or saved payment QR codes are not eligible', CH_EN]) {
      expect(te.price.value).toContain(w);
    }
    expect(tj.additionalFees.value).toContain('ガス用ウォレットで POL');
    expect(te.additionalFees.value).toContain('POL from the gas wallet');
    expect(tj.returnPolicy.value).toContain(`お店がガス代を肩代わりして送る経路の ${WEI}`);
    expect(te.returnPolicy.value).toContain(`The ${WEI} on`);
    for (const w of ['0 円', WEI, '当社指定ウォレットへ']) expect(ja.Disclaimer.intro).toContain(w);
    for (const w of ['is 0', WEI, 'designated by the Company']) expect(en.Disclaimer.intro).toContain(w);
    expect(ja.Disclaimer.section7.body).toContain('秘密鍵は店主の端末のブラウザにのみ保存され');
    expect(en.Disclaimer.section7.body).toContain('stored only in the browser on that device');
    expect(ja.Privacy.section1.body).toContain('(10) 「お店がガス代を肩代わりして送る」');
    expect(ja.Privacy.section2.body).toContain('(12) 「お店がガス代を肩代わりして送る」');
    expect(en.Privacy.section1.body).toContain('(10) When “The shop pays the gas” is used');
    expect(en.Privacy.section2.body).toContain('(12) Hand-off information for “The shop pays the gas”');
    expect(ja.Privacy.section4.body).toContain(`最長 ${MIN} 分で自動的に削除`);
    expect(en.Privacy.section4.body).toContain(`within ${MIN} minutes`);
  });

  it('LP (レジ・決済QR の料金カード・FAQ) は 0 円と 1 wei の行き先を書く (大きな 0% は出さない)', () => {
    for (const body of [ja.Landing.supportFeeRegisterBody, ja.Landing.supportFeePayBody, ja.Landing.faqA1]) {
      for (const w of ['0 円', WEI, 'OpenPay へ', `JPYC・${CH_JA} のみ`]) expect(body).toContain(w);
    }
    for (const body of [en.Landing.supportFeeRegisterBody, en.Landing.supportFeePayBody, en.Landing.faqA1]) {
      for (const w of [' 0 ', WEI, 'sent to OpenPay', `JPYC on ${CH_EN} only`]) expect(body).toContain(w);
    }
    // 決済QR のカードには「レジ」を含めない (決済QR の話に限る)・印刷/保存は対象外
    expect(ja.Landing.supportFeePayBody).not.toContain('レジ');
    expect(ja.Landing.supportFeePayBody).toContain('印刷・保存した QR は対象外');
  });

  it('画面 (決済モードの注記・お客様の支払い画面) も 1 wei の行き先を書く', () => {
    expect(ja.QrGenerator.storeDevice.note).toContain(`${WEI} = 0.000000000000000001 JPYC`);
    expect(ja.QrGenerator.storeDevice.note).toContain('OpenPay へ送られます');
    expect(ja.CheckoutForm.storeDevice.feeNote).toContain('OpenPay へ送られます');
    expect(en.CheckoutForm.storeDevice.feeNote).toContain('sent to OpenPay');
  });

  it('/transparency の「手数料の決め方」にも出す', () => {
    const jaFee = transparencyContentFor('ja').fees.find((f) => f.startsWith('お店がガス代を肩代わりして送る')) ?? '';
    const enFee = transparencyContentFor('en').fees.find((f) => f.startsWith('The shop pays the gas')) ?? '';
    for (const w of ['0 円', WEI, CH_JA, `最長 ${MIN} 分`, '印刷・保存した QR は対象外']) expect(jaFee).toContain(w);
    for (const w of ['is 0', WEI, CH_EN, `up to ${MIN} minutes`, 'not eligible']) expect(enFee).toContain(w);
  });

  it('public/llms.txt・ガイド (/guide/shop・/guide/qr・/guide/start)', () => {
    const llms = readFileSync(join(process.cwd(), 'public/llms.txt'), 'utf8');
    const line = llms.split('\n').find((l) => l.includes('お店がガス代を肩代わりして送る')) ?? '';
    for (const w of ['0 円', WEI, CH_JA, '印刷や保存した QR は対象外', 'OpenPay へ']) expect(line).toContain(w);
    // ガイドの本文も 0 円・1 wei・対象チェーン (と決済QRでは印刷/保存/コピー/金額なしは対象外) を書く
    for (const [locale, title, words, qrOnly] of [
      ['ja', 'お店がガス代を肩代わりして送る', ['0 円', WEI, `JPYC・${CH_JA} のみ`], ['印刷・保存・URL のコピー', '金額なし']],
      ['en', 'The shop pays the gas', ['is 0', WEI, `JPYC on ${CH_EN} only`], ['printed, saved or copied', 'without an amount']],
    ] as const) {
      const shop = shopGuideContentFor(locale).features.find((f) => f.title === title)?.body ?? '';
      const qr = qrGuideContentFor(locale).features.find((f) => f.title === title)?.body ?? '';
      for (const w of words) {
        expect(shop).toContain(w);
        expect(qr).toContain(w);
      }
      for (const w of qrOnly) expect(qr).toContain(w);
    }
    // お知らせ (提供開始日・0 円・1 wei・対象チェーン・印刷/保存は対象外)
    const news = NEWS_ITEMS.find((n) => n.id === `store-pays-gas-${D.effectiveDate}`);
    expect(news?.date).toBe(D.effectiveDate);
    for (const w of ['0 円', `${D.feeWei} wei`, `JPYC・${CH_JA}`, '印刷・保存した QR は対象外']) expect(news?.body.ja).toContain(w);
    for (const w of ['is 0', `${D.feeWei} wei`, `JPYC on ${CH_EN}`, 'not printed or saved']) expect(news?.body.en).toContain(w);
    const startJa = startGuideContentFor('ja').sections.find((s) => s.n === 8)?.defs ?? [];
    const startEn = startGuideContentFor('en').sections.find((s) => s.n === 8)?.defs ?? [];
    expect(startJa.find((x) => x.term.includes('お店がガス代を肩代わり'))?.desc).toContain(`最長 ${MIN} 分`);
    expect(startEn.find((x) => x.term.includes('The shop pays the gas'))?.desc).toContain(`within ${MIN} minutes`);
  });
});
