import { describe, it, expect } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';
import { SavingsSimulator } from '@/components/SavingsSimulator';
import { SavingsSimulatorResult } from '@/components/SavingsSimulatorResult';
import { DISCLOSED_RECOVER_FEE } from '@/lib/legal';

type Locale = 'ja' | 'en';
type Kind = 'savings' | 'extra' | 'same';

// 結果のラベル (2026-11-15 user 承認・ja は一字一句この文)。どちらが安いかは、万円に丸める前の差額の符号で決める。
const LABELS: Record<Locale, Record<Kind, string>> = {
  ja: {
    savings: '手数料が安くなる見込み額',
    extra: 'OpenPay の方が手数料が高くなる見込み額',
    same: 'この条件では、手数料は変わりません',
  },
  en: {
    savings: 'Estimated savings in fees',
    extra: 'Estimated extra fees with OpenPay',
    same: 'No change in fees under these conditions',
  },
};
const CODE_CHIP = { ja: 'コード決済 1.98%', en: 'QR pay 1.98%' } as const;
const TICKET_SLIDER = { ja: '平均決済額', en: 'Average payment amount' } as const;

/**
 * 結果の塊 (「年間」・大きい数字と単位・ラベル・ja の円の補足) を確かめる。
 * - ラベルは 3 つのうち 1 つだけ。
 * - 数字・補足のどこにもマイナスが無い (割高はラベルの言葉で示す)。
 * - exact = ja の円の補足 (差額が 0 でないとき・en は出さない)。null なら補足の行が無い。
 */
function expectResult(
  locale: Locale,
  { kind, figure, unit, exact }: { kind: Kind; figure: string; unit: string; exact: string | null },
) {
  const label = screen.getByText(LABELS[locale][kind], { exact: true });
  for (const other of (['savings', 'extra', 'same'] as const).filter((k) => k !== kind)) {
    expect(screen.queryByText(LABELS[locale][other], { exact: true })).not.toBeInTheDocument();
  }
  const block = label.parentElement!;
  expect(within(block).getByText(figure, { exact: true })).toBeInTheDocument();
  expect(within(block).getByText(unit, { exact: true })).toBeInTheDocument();
  if (exact === null) {
    expect(within(block).queryByText(/\/ (?:年|year)/)).not.toBeInTheDocument();
  } else {
    expect(within(block).getByText(exact, { exact: true })).toBeInTheDocument();
  }
  expect(block.textContent).not.toMatch(/[-−]/);
}

// 既定 = 月商 100 万円 × カード 3.24%・平均決済額 1,000 円 (最低額より料率側を適用)。
// この既定額では年間差額 = 1,000,000 × 12 × (0.0324 − 0.01)
// = 268,800 円 = 27 万円 (round)。整数円で計算し float の見た目誤差を出さない。
describe('SavingsSimulator', () => {
  // 月商 100 万円・平均 100 円・コード決済: 1,000,000 × 12 × 0.0198 − 10,000 件 × 2 JPYC × 12 = 237,600 − 240,000 = −2,400 円。
  // 万円に丸めると 0 になる額。前は ja で「0 万円」と出ていた。
  it.each(['ja', 'en'] as const)('%s: 1 万円未満の割高 (年 2,400 円) は「0 万円」ではなく円で出し、マイナスを付けず、高くなる方のラベル', (locale) => {
    renderWithIntl(<SavingsSimulator />, { locale });
    fireEvent.click(screen.getByRole('button', { name: CODE_CHIP[locale] }));
    fireEvent.change(screen.getByRole('slider', { name: TICKET_SLIDER[locale] }), { target: { value: '100' } });
    // ja の円の補足は今までどおり出す (マイナスを付けない)。en は出さない。
    expectResult(
      locale,
      locale === 'ja'
        ? { kind: 'extra', figure: '2,400', unit: '円', exact: '約 ¥2,400 / 年' }
        : { kind: 'extra', figure: '2,400', unit: 'yen', exact: null },
    );
    expect(screen.queryByText('0', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('-0', { exact: true })).not.toBeInTheDocument();
    // 前のラベル (括弧でマイナスの意味を説明する文) は出さない。
    expect(document.body).not.toHaveTextContent(locale === 'ja' ? 'マイナス' : 'negative');
  });

  // 平均 50 円・カード: 1,000,000 × 12 × 0.0324 − 20,000 件 × 2 JPYC × 12 = 388,800 − 480,000 = −91,200 円 (ja は 9 万円)。
  it.each(['ja', 'en'] as const)('%s: 1 万円以上の割高 (年 91,200 円) も、大きい数字と円の補足にマイナスを付けない', (locale) => {
    renderWithIntl(<SavingsSimulator />, { locale });
    fireEvent.change(screen.getByRole('slider', { name: TICKET_SLIDER[locale] }), { target: { value: '50' } });
    expectResult(
      locale,
      locale === 'ja'
        ? { kind: 'extra', figure: '9', unit: '万円', exact: '約 ¥91,200 / 年' }
        : { kind: 'extra', figure: '91,200', unit: 'yen', exact: null },
    );
  });

  it.each(['ja', 'en'] as const)('%s: 150 円の決済では最低利用料を反映し、年間差額は 77,600 円', (locale) => {
    renderWithIntl(<SavingsSimulator />, { locale });
    fireEvent.click(screen.getByRole('button', { name: CODE_CHIP[locale] }));
    fireEvent.change(screen.getByRole('slider', { name: TICKET_SLIDER[locale] }), { target: { value: '150' } });
    expect(screen.getByText(locale === 'ja' ? /¥77,600 \/ 年/ : '77,600')).toBeInTheDocument();
  });

  it.each([200, 250, 1000])('%i 円の決済では料率側を適用する', (ticket) => {
    renderWithIntl(<SavingsSimulator />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'QR pay 1.98%' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Average payment amount' }), { target: { value: String(ticket) } });
    expect(screen.getByText('117,600')).toBeInTheDocument();
  });

  it.each(['ja', 'en'] as const)('%s: 開示 SoT から料率・1 回あたりの最低額・計算の前提を表示する', (locale) => {
    renderWithIntl(<SavingsSimulator />, { locale });
    const note = screen.getByText(locale === 'ja' ? /全決済が平均決済額と同額/ : /every payment equals the average/);
    expect(note).toHaveTextContent(`${DISCLOSED_RECOVER_FEE.percentFromJulyBps / 100}%`);
    expect(note).toHaveTextContent(`${DISCLOSED_RECOVER_FEE.floorJpyc} JPYC`);
    expect(note).toHaveTextContent(locale === 'ja' ? '1 回あたり' : 'per payment');
    expect(note).toHaveTextContent(locale === 'ja' ? 'JPYC ガスレス' : 'gasless JPYC');
    expect(note).not.toHaveTextContent('0%');
  });

  it('既定値 (100 万円 / カード 3.24%) で年間 27 万円・安くなる方のラベル・正確な円の補足 (「の差額」は付けない)', () => {
    renderWithIntl(<SavingsSimulator />);
    // 月商スライダー現在値 (万円表示)
    expect(screen.getByText('100万円')).toBeInTheDocument();
    // ヒーロー = 27 (万円)・正確な円の補足
    expectResult('ja', { kind: 'savings', figure: '27', unit: '万円', exact: '約 ¥268,800 / 年' });
  });

  it('比較チップをコード決済 1.98% に切替えると年間 12 万円に更新', async () => {
    const user = userEvent.setup();
    renderWithIntl(<SavingsSimulator />);
    await user.click(
      screen.getByRole('button', { name: 'コード決済 1.98%' }),
    );
    // 平均決済額は既定の 1,000 円のままなので料率側を適用:
    // 1,000,000 × 12 × (0.0198 − 0.01) = 117,600 円 = 12 万円
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/¥117,600 \/ 年/)).toBeInTheDocument();
    // aria-pressed が切替わる
    expect(
      screen.getByRole('button', { name: 'コード決済 1.98%' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('スライダーを 500 万円に変更するとヒーローが更新される', () => {
    renderWithIntl(<SavingsSimulator />);
    const slider = screen.getByLabelText('月商');
    fireEvent.change(slider, { target: { value: '5000000' } });
    expect(screen.getByText('500万円')).toBeInTheDocument();
    // 平均決済額は既定の 1,000 円のままなので料率側を適用:
    // 5,000,000 × 12 × 0.0224 = 1,344,000 円 = 134 万円
    expect(screen.getByText('134')).toBeInTheDocument();
  });

  it('en ロケールでは full 円をヒーローに表示 (万円ヒーローは使わない・円の補足も出さない)', () => {
    renderWithIntl(<SavingsSimulator />, { locale: 'en' });
    // ヒーロー = 268,800 (full 円)、unit = yen
    expectResult('en', { kind: 'savings', figure: '268,800', unit: 'yen', exact: null });
  });
});

// 結果の出し分けそのもの。今の料率と刻み (平均決済額は 50 円刻み・最低 2 JPYC) では差額がちょうど 0 にならないので、
// 0・-0・万円の境目は差額を直接渡して確かめる (計算は上の SavingsSimulator のテストで確かめている)。
describe('SavingsSimulatorResult', () => {
  it.each(['ja', 'en'] as const)('%s: 差額 0 は「0」と円の単位と「変わりません」・円の補足 (「約 ¥0」) は出さない', (locale) => {
    renderWithIntl(<SavingsSimulatorResult annualDiffYen={0} />, { locale });
    expectResult(locale, { kind: 'same', figure: '0', unit: locale === 'ja' ? '円' : 'yen', exact: null });
  });

  it.each(['ja', 'en'] as const)('%s: 丸めで生じる -0 も 0 として扱い、「-0」と出さない', (locale) => {
    renderWithIntl(<SavingsSimulatorResult annualDiffYen={-0} />, { locale });
    expectResult(locale, { kind: 'same', figure: '0', unit: locale === 'ja' ? '円' : 'yen', exact: null });
    expect(screen.queryByText('-0', { exact: true })).not.toBeInTheDocument();
  });

  it.each([
    // ja: 1 万円未満は円・1 万円以上は万円。どちらも正確な円の補足を出す。符号は丸める前の差額で決める。
    { yen: 1, kind: 'savings', figure: '1', unit: '円', exact: '約 ¥1 / 年' },
    { yen: -1, kind: 'extra', figure: '1', unit: '円', exact: '約 ¥1 / 年' },
    { yen: 9_999, kind: 'savings', figure: '9,999', unit: '円', exact: '約 ¥9,999 / 年' },
    { yen: -9_999, kind: 'extra', figure: '9,999', unit: '円', exact: '約 ¥9,999 / 年' },
    { yen: 10_000, kind: 'savings', figure: '1', unit: '万円', exact: '約 ¥10,000 / 年' },
    { yen: -10_000, kind: 'extra', figure: '1', unit: '万円', exact: '約 ¥10,000 / 年' },
    // 万円への丸めは絶対値で行う (正負で同じ数字になる)。
    { yen: 15_000, kind: 'savings', figure: '2', unit: '万円', exact: '約 ¥15,000 / 年' },
    { yen: -15_000, kind: 'extra', figure: '2', unit: '万円', exact: '約 ¥15,000 / 年' },
  ] as const)('ja: 差額 $yen 円 → $figure $unit', ({ yen, kind, figure, unit, exact }) => {
    renderWithIntl(<SavingsSimulatorResult annualDiffYen={yen} />);
    expectResult('ja', { kind, figure, unit, exact });
  });

  it.each([
    { yen: 9_999, kind: 'savings', figure: '9,999' },
    { yen: -10_000, kind: 'extra', figure: '10,000' },
    { yen: -268_800, kind: 'extra', figure: '268,800' },
  ] as const)('en: 差額 $yen 円 → $figure yen (万円にしない・補足なし)', ({ yen, kind, figure }) => {
    renderWithIntl(<SavingsSimulatorResult annualDiffYen={yen} />, { locale: 'en' });
    expectResult('en', { kind, figure, unit: 'yen', exact: null });
  });
});
