// チップの開示文の「JPYC の文」と「USDC の文」を切り分けて、2 点を確かめる (2026-10-11 の D1)。
//
// 1. JPYC の文に、ガス相当額の行き先 (OpenPay / 当社指定ウォレット) が書いてある。
//    JPYC のチップのガス相当額は、チップと同じ取引で OpenPay の受取用ウォレットへ分割される
//    (recoverFeeValue の customer = 最低額だけ → fee-receiver)。
// 2. 「徴収はありません」は USDC の文の中だけにある。JPYC の直後に「いずれも徴収なし」と並べると、
//    JPYC のチップからも OpenPay が何も受け取らないと読めてしまう (トップのチップカード en で実際にそう読めた)。
import { expect } from 'vitest';

type Locale = 'ja' | 'en';

const USDC_LEAD: Record<Locale, string> = { ja: 'USDC のチップは', en: 'For USDC tips,' };
const NOTHING: Record<Locale, string> = {
  ja: 'いずれも OpenPay の徴収はありません',
  en: 'OpenPay collects nothing for any of these tips',
};
// JPYC のチップの文の書き出し (面ごとに「JPYC は送る…」「JPYC のチップ送付…」/ "For JPYC tips")。
const JPYC_LEAD: Record<Locale, RegExp> = { ja: /JPYC (?:は送る|のチップ)/g, en: /For JPYC tips/g };
const DESTINATION: Record<Locale, RegExp> = {
  ja: /OpenPay へ送られます|当社指定ウォレットへ分割|OpenPay 指定ウォレットへ分割/,
  en: /which goes to OpenPay|split to a wallet designated by the Company|split to OpenPay's designated wallet/,
};

export function expectTipFeeScopedByToken(text: string, locale: Locale, label: string): void {
  const usdcAt = text.indexOf(USDC_LEAD[locale]);
  expect(usdcAt, `${label}: USDC のチップの文 (${USDC_LEAD[locale]}) が無い`).toBeGreaterThan(-1);
  const before = text.slice(0, usdcAt);
  const jpycLead = [...before.matchAll(JPYC_LEAD[locale])].at(-1);
  expect(jpycLead, `${label}: USDC の文の前に JPYC のチップの文が無い`).toBeDefined();
  const jpyc = before.slice(jpycLead!.index);
  expect(jpyc, `${label}: JPYC の文にガス相当額の行き先が無い`).toMatch(DESTINATION[locale]);
  expect(jpyc, `${label}: JPYC の文に「徴収なし」がある`).not.toContain(NOTHING[locale]);
  // 「徴収なし」は 1 回だけ・USDC の文の後ろにあり、その間に JPYC の話が挟まらない。
  expect(text.split(NOTHING[locale]), `${label}: 「徴収なし」の出現は 1 回`).toHaveLength(2);
  const usdc = text.slice(usdcAt);
  const nothingAt = usdc.indexOf(NOTHING[locale]);
  expect(nothingAt, `${label}: 「徴収なし」が USDC の文の後ろに無い`).toBeGreaterThan(-1);
  expect(usdc.slice(0, nothingAt), `${label}: USDC の文と「徴収なし」の間に JPYC の話がある`).not.toContain('JPYC');
}
