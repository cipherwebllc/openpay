// 他のチェーンの USDC から Arc 以外のチェーン宛てに払う (Circle CCTP V2) とき、Circle の転送手数料が受け取る側の
// 受取額から差し引かれることの開示フェンス (掟 14・2026-10-12)。
//   ① 開示の上限 (DISCLOSED_CCTP_FEE) = 実装の上限 (cctp.ts の maxFee) = 支払元を選ぶ画面の表示 (computeCctpFastFee)。
//      顧客は請求額をそのまま burn し、OpenPay の利用料は 0 (lib/fee.ts)。
//   ② 開示の各面 (規約 第 5 条 (3)・特商法「対価以外の費用」・LP の FAQ・料金ページ・docs/FEATURES.md) が、この上限から
//      描いた文を持ち、Arc 宛て (支払う側が上乗せ) の文の後ろに置く。messages には数字を直書きしない (ICU で差し込む)。
//   llms.txt は静的ファイルなので tests/lib/llmsTxtDisclosure.test.ts が同じ上限と照合する。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { decodeFunctionData, type Address } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import TermsPage from '@/app/[locale]/terms/page';
import TokuteiPage from '@/app/[locale]/tokutei/page';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { DISCLOSED_CCTP_FEE, LANDING_PAYMENT_FEE_VALUES, cctpFeeDisclosureValues } from '@/lib/legal';
import {
  CCTP_FINALITY_FAST,
  CCTP_V2_TOKEN_MESSENGER_ABI,
  encodeDepositForBurnCalldata,
  estimateCctpMaxFee,
} from '@/lib/crossChain/cctp';
import { computeCctpFastFee } from '@/lib/crossChain/pathEnumerator';
import { computeCrossChainFeeSplit } from '@/lib/crossChain/feeSplit';
import { PRICING } from '@/lib/pricing';

const V = cctpFeeDisclosureValues();
const USDC = 1_000_000n;
const RECIPIENT: Address = '0x00000000000000000000000000000000000000A1';
const BURN_TOKEN: Address = '0x00000000000000000000000000000000000000B2';

// 開示の上限を描いた文 (ja/en)。規約と特商法は同じ文。
const LEGAL_SENTENCE = {
  ja: `他のチェーンから Arc 以外のチェーン宛てにお支払いいただく場合 (Circle CCTP V2 による転送) は、Circle の転送手数料 (Circle が定める額で、決済額の ${V.cctpMaxPercent}% (決済額が ${V.cctpSmallBelowUsdc} USDC 未満の場合は ${V.cctpSmallCapUsdc} USDC) を上限とします) が店主の受取額から差し引かれ、顧客がお支払いになる USDC には上乗せされません。当社は当該手数料を徴収せず、この経路に OpenPay 利用料は発生しません。`,
  en: `When paying from another chain to a chain other than Arc (a transfer by Circle CCTP V2), Circle's transfer fee (an amount set by Circle, capped at ${V.cctpMaxPercent}% of the payment, or ${V.cctpSmallCapUsdc} USDC if the payment is under ${V.cctpSmallBelowUsdc} USDC) is deducted from the amount the Merchant receives and is not added to the USDC the Customer pays. The Company does not collect this fee, and no OpenPay usage fee arises on this path.`,
} as const;
// 直前に置く Arc 宛ての文 (支払う側が上乗せ・既存)。
const ARC_FORWARD_SENTENCE = {
  ja: '他のチェーンから Arc 宛てにお支払いいただく場合は、Circle の転送手数料を顧客がお支払い額に上乗せして負担し、当社は徴収しません。',
  en: "When paying to Arc from another chain, the Customer pays Circle's forwarding fee on top of the amount; the Company collects nothing.",
} as const;
const MESSAGES = { ja, en } as const;

function translate(locale: 'ja' | 'en', namespace: 'Terms' | 'Tokutei' | 'Landing') {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace, onError: (error) => { throw error; } });
}

describe('① 開示の上限 = 実装の上限 (料金・挙動は変えない)', () => {
  it('cctp.ts の maxFee は 金額 × maxFeeBps、ただし minMaxFeeAtomic を下回らない', () => {
    const bps = BigInt(DISCLOSED_CCTP_FEE.maxFeeBps);
    const min = BigInt(DISCLOSED_CCTP_FEE.minMaxFeeAtomic);
    for (const value of [10_000n * USDC, 123_456_789n, 2n * USDC]) {
      expect(estimateCctpMaxFee(value), String(value)).toBe((value * bps) / 10_000n);
    }
    // 少額の境目 (開示の「1 USDC 未満」) から下は最低額が上限になる。
    const below = (min * 10_000n) / bps;
    expect(estimateCctpMaxFee(below)).toBe(min);
    for (const value of [below - 1n, USDC / 2n, 1n]) expect(estimateCctpMaxFee(value), String(value)).toBe(min);
    expect(estimateCctpMaxFee(below + 10_000n / bps)).toBeGreaterThan(min);
  });

  it('calldata: 請求額をそのまま burn し、maxFee は上の上限・Fast 転送', () => {
    for (const value of [10_000n * USDC, USDC / 2n]) {
      const data = encodeDepositForBurnCalldata({ value, destinationDomain: 6, recipient: RECIPIENT, burnToken: BURN_TOKEN });
      const { args } = decodeFunctionData({ abi: CCTP_V2_TOKEN_MESSENGER_ABI, data });
      expect(args[0]).toBe(value);
      expect(args[5]).toBe(estimateCctpMaxFee(value));
      expect(args[6]).toBe(CCTP_FINALITY_FAST);
    }
  });

  it('支払元を選ぶ画面の転送手数料 (serviceFeeAtomic) は maxFee と同じ値 (「最大」と書く根拠)', () => {
    for (const value of [1n, USDC / 2n, USDC, 10n * USDC, 10_000n * USDC, 123_456_789n]) {
      expect(computeCctpFastFee(value), String(value)).toBe(estimateCctpMaxFee(value));
    }
  });

  it('OpenPay の利用料は 0 で、顧客の支出は請求額のまま (受取額から引かれるのは Circle の手数料だけ)', () => {
    for (const value of [USDC, 10_000n * USDC]) {
      expect(computeCrossChainFeeSplit(value, 'usdc', 'standard')).toEqual({ feeAmount: 0n, bridgedAmount: value });
    }
  });

  it('差し込む値は開示の上限から導く (今の値と、差し替えた値)', () => {
    expect(V).toEqual({ cctpMaxPercent: '0.1', cctpSmallCapUsdc: '0.001', cctpSmallBelowUsdc: '1' });
    expect(cctpFeeDisclosureValues({ maxFeeBps: 25, minMaxFeeAtomic: 5_000, usdcDecimals: 6 })).toEqual({
      cctpMaxPercent: '0.25',
      cctpSmallCapUsdc: '0.005',
      cctpSmallBelowUsdc: '2',
    });
    expect(LANDING_PAYMENT_FEE_VALUES).toMatchObject(V);
  });
});

describe('② 開示の各面', () => {
  it.each(['ja', 'en'] as const)('%s: 規約 第 5 条 (3) は Arc 宛ての文のすぐ後に、上限から描いた文を置く', (locale) => {
    const body = translate(locale, 'Terms')('article5.body', V);
    const clause3 = body.split('(3)')[1].split('(4)')[0];
    // 規約の ja は文を空白なしで続ける (en は空白 1 つ)。
    expect(clause3).toContain(ARC_FORWARD_SENTENCE[locale] + (locale === 'ja' ? '' : ' ') + LEGAL_SENTENCE[locale]);
  });

  it.each(['ja', 'en'] as const)('%s: 特商法「対価以外の費用」は Arc 宛ての文のすぐ後に、規約と同じ文を置く', (locale) => {
    const value = translate(locale, 'Tokutei')('rows.additionalFees.value', V);
    expect(value).toContain(ARC_FORWARD_SENTENCE[locale] + ' ' + LEGAL_SENTENCE[locale]);
  });

  it.each(['ja', 'en'] as const)('%s: 規約・特商法のページが上限を差し込んで描く', (locale) => {
    for (const Page of [TermsPage, TokuteiPage]) {
      const { container, unmount } = renderWithIntl(<Page />, { locale });
      expect(container.textContent).toContain(LEGAL_SENTENCE[locale]);
      unmount();
    }
  });

  it.each(['ja', 'en'] as const)('%s: LP の FAQ (faqA2) は Arc 以外の宛先で受取額から差し引かれることを、Arc 宛ての文の前に書く', (locale) => {
    const text = translate(locale, 'Landing')('faqA2', LANDING_PAYMENT_FEE_VALUES);
    const expected = locale === 'ja'
      ? `Arc 以外のチェーン宛てでは、Circle の転送手数料〔決済額の最大 ${V.cctpMaxPercent}%・${V.cctpSmallBelowUsdc} USDC 未満は最大 ${V.cctpSmallCapUsdc} USDC〕が支払う側への上乗せではなくお店の受取額から差し引かれ、OpenPay の利用料はかかりません。`
      : `for destinations other than Arc, Circle's transfer fee [up to ${V.cctpMaxPercent}% of the payment; up to ${V.cctpSmallCapUsdc} USDC for payments under ${V.cctpSmallBelowUsdc} USDC] is deducted from what the shop receives rather than added for the sender, and no OpenPay fee applies;`;
    expect(text).toContain(expected);
    const arc = locale === 'ja' ? 'Arc 宛ては Circle の転送で対応し、転送手数料は支払う側が上乗せ負担' : "payments into Arc are forwarded by Circle; the sender pays Circle's forwarding fee on top";
    expect(text.indexOf(arc)).toBeGreaterThan(text.indexOf(expected));
  });

  it('messages に上限の数字を直書きしない (ICU で差し込む)', () => {
    for (const messages of [ja, en]) {
      for (const raw of [messages.Terms.article5.body, messages.Tokutei.rows.additionalFees.value, messages.Landing.faqA2]) {
        expect(raw).toContain('{cctpMaxPercent}%');
        expect(raw).toContain('{cctpSmallCapUsdc} USDC');
        expect(raw).toContain('{cctpSmallBelowUsdc} USDC');
        expect(raw).not.toMatch(/0\.1%|0\.001 USDC/);
      }
    }
  });

  it('差し替えた上限で描くと、各面の数字が追従する', () => {
    const alt = cctpFeeDisclosureValues({ maxFeeBps: 25, minMaxFeeAtomic: 5_000, usdcDecimals: 6 });
    for (const locale of ['ja', 'en'] as const) {
      const texts = [
        translate(locale, 'Terms')('article5.body', alt),
        translate(locale, 'Tokutei')('rows.additionalFees.value', alt),
        translate(locale, 'Landing')('faqA2', { ...LANDING_PAYMENT_FEE_VALUES, ...alt }),
      ];
      for (const text of texts) {
        expect(text).toContain('0.25%');
        expect(text).toContain('0.005 USDC');
        expect(text).toContain('2 USDC');
      }
    }
  });

  it('料金ページ「このほかの場合」は Arc 宛ての項目の後に、上限から描いた項目を置く', () => {
    const ja = PRICING.ja.otherItems;
    const en = PRICING.en.otherItems;
    expect(ja.at(-2)).toContain('Arc 宛てに払うときは、Circle の転送手数料を払う側が上乗せして負担します');
    expect(ja.at(-1)).toBe(
      `ほかのチェーンの USDC から Arc 以外のチェーン宛てに払うときは、Circle の転送手数料（Circle が決める額で、上限は金額の ${V.cctpMaxPercent}%。${V.cctpSmallBelowUsdc} USDC 未満の支払いでは ${V.cctpSmallCapUsdc} USDC）がお店の受け取りから差し引かれます。払う側の支払いは増えません。OpenPay はこの分を受け取らず、OpenPay の料金もかかりません。`,
    );
    expect(en.at(-2)).toContain('When paying to Arc with USDC from another chain, the payer adds Circle’s transfer fee');
    expect(en.at(-1)).toBe(
      `When paying with USDC from another chain to a chain other than Arc, Circle’s transfer fee (set by Circle, capped at ${V.cctpMaxPercent}% of the amount, or ${V.cctpSmallCapUsdc} USDC for payments under ${V.cctpSmallBelowUsdc} USDC) is deducted from what the shop receives. The payer pays no more. OpenPay receives none of it and charges nothing.`,
    );
  });

  // 2026-10-12 (user 承認): お店がクロスチェーン受取を選ぶトグルの説明から「自動変換」をなくす (交換業と誤読されうる)。
  // Arc 宛ては forwarding で支払う側が転送手数料を上乗せするので、Arc を選んだときだけ別の文 (…Arc) を出す。
  it('クロスチェーン受取のトグルの説明 (決済QR・チップ) は承認済みの文で、変換の語を使わない', () => {
    const expected = {
      ja: {
        base: '他のチェーンの USDC も、Circle の CCTP V2 でこのチェーンの USDC として受け取れます（Circle の転送手数料が受取額から差し引かれます）。',
        arc: '他のチェーンの USDC も、Circle の CCTP V2 でこのチェーンの USDC として受け取れます（Arc 宛ては、Circle の転送手数料を支払う側が上乗せして負担します）。',
      },
      en: {
        base: "You can also receive USDC sent from other chains as USDC on this chain via Circle CCTP V2 (Circle's transfer fee is deducted from the amount you receive).",
        arc: "You can also receive USDC sent from other chains as USDC on this chain via Circle CCTP V2 (for Arc, the sender pays Circle's transfer fee on top).",
      },
    } as const;
    for (const locale of ['ja', 'en'] as const) {
      for (const ns of ['QrGenerator', 'TipEmbedGenerator'] as const) {
        const m = MESSAGES[locale][ns];
        expect(m.crossChainToggleDescription, `${locale}.${ns}`).toBe(expected[locale].base);
        expect(m.crossChainToggleDescriptionArc, `${locale}.${ns}`).toBe(expected[locale].arc);
        for (const text of [m.crossChainToggleDescription, m.crossChainToggleDescriptionArc]) {
          expect(text).not.toMatch(/変換|convert|auto-rout/i);
        }
      }
    }
  });

  it('docs/FEATURES.md の cross-chain の説明も同じ上限', () => {
    const features = readFileSync(join(process.cwd(), 'docs', 'FEATURES.md'), 'utf8');
    expect(features).toContain(
      `Circle's transfer fee (set by Circle, capped at ${V.cctpMaxPercent}% of the payment, or ${V.cctpSmallCapUsdc} USDC for payments under ${V.cctpSmallBelowUsdc} USDC — \`DISCLOSED_CCTP_FEE\`) is deducted from what the merchant receives`,
    );
  });
});
