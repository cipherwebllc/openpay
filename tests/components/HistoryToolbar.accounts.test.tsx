// 履歴の toolbar の「勘定科目」の欄 (会計仕訳 CSV の科目を店が変える)。
// - 既定は閉じていて、見出しに今の科目 (= 書き出される科目) が出る。
// - 入力は確定 (blur・Enter) で検証して保存する。書き出しは blur に頼らず、途中の入力をその場で確かめる。
// - 保存値の読み込み (hydrate) と別のタブの変更に追従し、読み込み前の既定値で保存値を消さない。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useLayoutEffect, type ReactNode } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { HistoryToolbar } from '@/components/HistoryToolbar';
import * as accountingModule from '@/lib/accountingCsv';
import * as downloadModule from '@/lib/download';
import { EMPTY_HISTORY_FILTERS } from '@/lib/historyFilters';
import type { HistoryEntry } from '@/lib/history';

const KEY = 'openpay:accounting-accounts:v1';
const DEBIT_LABEL = '受け取りの勘定科目 (借方)';
const CREDIT_LABEL = '売上の勘定科目 (貸方)';
const EXPORT = '会計CSVを書き出し';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: 'id-' + Math.random(),
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xToken',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000000000000000000000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '0',
    txHash: '0xTx',
    userOpHash: '0xUO',
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: '1000000000000000000000',
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: null,
    lineItems: null,
    ...overrides,
  };
}

type ToolbarProps = Partial<{
  entries: HistoryEntry[];
  csvLocked: boolean;
  csvLockReason: 'fee' | 'pass';
  onCsvPassRequired: () => void;
  locale: 'ja' | 'en';
  /** toolbar の後ろに置く要素 (hydrate の前を見るテスト用)。 */
  after: ReactNode;
}>;

function renderToolbar(props: ToolbarProps = {}) {
  const entries = props.entries ?? [entry()];
  const toolbar = (
    <HistoryToolbar
      entries={entries}
      filters={EMPTY_HISTORY_FILTERS}
      onFiltersChange={vi.fn()}
      counts={{ all: entries.length, jpyc: entries.length, usdc: 0 }}
      directionCounts={{ all: entries.length, in: entries.length, out: 0 }}
      usdcJpy={150}
      csvLocked={props.csvLocked ?? false}
      csvLockReason={props.csvLockReason}
      onCsvPassRequired={props.onCsvPassRequired ?? vi.fn()}
      csvPassExpiresAt={null}
    />
  );
  return render(
    props.after === undefined ? (
      toolbar
    ) : (
      <>
        {toolbar}
        {props.after}
      </>
    ),
    { locale: props.locale ?? 'ja' },
  );
}

const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
const save = (value: unknown) => window.localStorage.setItem(KEY, JSON.stringify(value));
const debitInput = () => screen.getByLabelText(DEBIT_LABEL) as HTMLInputElement;
const creditInput = () => screen.getByLabelText(CREDIT_LABEL) as HTMLInputElement;
const exportButton = () => screen.getByRole('button', { name: EXPORT });
const details = () => creditInput().closest('details') as HTMLDetailsElement;
const summaryText = () => details().querySelector('summary')?.textContent;
/** CSV の 1 行目 (データ) の科目。freee 形式は貸方だけ [2]・MF 形式は借方 [2] と貸方 [8]。 */
const freeeCredit = (csv: string) => csv.split('\r\n')[1].split(',')[2];
const mfNames = (csv: string) => {
  const row = csv.split('\r\n')[1].split(',');
  return { debit: row[2], credit: row[8] };
};

async function selectFormat(user: ReturnType<typeof userEvent.setup>, format: string) {
  await user.selectOptions(screen.getByLabelText('会計ソフト形式'), format);
}

/** 打って blur で確定する。 */
async function typeAndBlur(
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLInputElement,
  text: string,
) {
  await user.clear(input);
  if (text !== '') await user.type(input, text);
  await user.tab();
}

/** 書き出した CSV (toAccountingCsv の結果) と、渡した科目。 */
function spyExport() {
  const downloadSpy = vi.spyOn(downloadModule, 'downloadBlob').mockImplementation(() => undefined);
  const csvSpy = vi.spyOn(accountingModule, 'toAccountingCsv');
  const lastCsv = () => {
    const result = csvSpy.mock.results.at(-1)?.value as accountingModule.AccountingCsvResult;
    return result.ok ? result.csv : '';
  };
  const lastAccounts = () => csvSpy.mock.calls.at(-1)?.[1].accounts;
  return { downloadSpy, csvSpy, lastCsv, lastAccounts };
}

describe('HistoryToolbar: 勘定科目の欄', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  describe('見出しと欄の形', () => {
    it('既定は閉じている。見出しは今の科目 (既定の freee 形式は売上の科目だけ)', () => {
      renderToolbar();
      expect(details().open).toBe(false);
      expect(details().querySelector('summary')).toHaveTextContent('勘定科目: 売上高');
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 売上高');
    });

    it.each(['yayoi', 'mf', 'yayoi-native'])('%s 形式の見出しは 借方 / 貸方', async (format) => {
      const user = userEvent.setup();
      renderToolbar();
      await selectFormat(user, format);
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 売掛金 / 売上高');
    });

    it('入力の a11y の名前は見える label から (aria-label を付けない)', () => {
      renderToolbar();
      for (const [input, label] of [
        [debitInput(), DEBIT_LABEL],
        [creditInput(), CREDIT_LABEL],
      ] as const) {
        expect(input.tagName).toBe('INPUT');
        expect(input).not.toHaveAttribute('aria-label');
        const labelEl = document.querySelector(`label[for="${input.id}"]`);
        expect(labelEl).toHaveTextContent(label);
        expect(input).toHaveAccessibleName(label);
        // iOS が入力で拡大しない字の大きさ。
        expect(input.className).toContain('text-base');
        expect(input.className).toContain('sm:text-sm');
        // エラーの無い入力は、focus で枠が青になる。
        expect(input.className).toContain('focus:border-brand');
      }
      expect(debitInput().id).not.toBe(creditInput().id);
    });

    it('見出しは長い半角の名前でもはみ出さない指定を持ち、新しい欄に role=status・output・ring-2 を使わない', () => {
      renderToolbar();
      const summaryText = details().querySelector('summary span');
      expect(summaryText?.className).toContain('[overflow-wrap:anywhere]');
      expect(details().className).not.toContain('ring-2');
      expect(details().querySelector('[role="status"], output')).toBeNull();
    });

    it('補足と案内の文', () => {
      renderToolbar();
      expect(
        screen.getByText(
          '会計ソフトに登録している科目名と同じ名前にしてください。空欄にすると既定の科目に戻ります。',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          '会計CSVは成功した売上 (収入) のみを書き出します。勘定科目は「勘定科目」の欄で変えられます。税区分の名前が会計ソフトと違うときは、取り込むときに確かめてください。',
        ),
      ).toBeInTheDocument();
    });

    it('en: 見出し・label・エラーの文', async () => {
      const user = userEvent.setup();
      renderToolbar({ locale: 'en' });
      const credit = screen.getByLabelText('Credit account title (for sales)') as HTMLInputElement;
      const summary = credit.closest('details')?.querySelector('summary');
      expect(summary?.textContent).toBe('Account title: 売上高');
      await user.selectOptions(screen.getByLabelText('Accounting format'), 'mf');
      expect(summary?.textContent).toBe('Account titles: 売掛金 / 売上高');
      expect(screen.getByLabelText('Debit account title (for payments received)')).toBeEnabled();
      await typeAndBlur(user, credit, 'a'.repeat(13));
      expect(screen.getByRole('alert')).toHaveTextContent('Use 12 characters or fewer.');
      await typeAndBlur(user, credit, 'a"b');
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Commas, double quotes (") and invisible characters can\'t be used.',
      );
      expect(
        screen.getByText(
          'The accounting CSV exports successful sales (income) only. You can change the account titles in the account title section. If tax category names differ from your software\'s, check them when importing.',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('確定 (blur・Enter) で検証して保存する', () => {
    it('blur で保存し、見出しが変わる', async () => {
      const user = userEvent.setup();
      renderToolbar();
      await selectFormat(user, 'mf');
      await typeAndBlur(user, creditInput(), '売上');
      await typeAndBlur(user, debitInput(), '現金');
      expect(stored()).toEqual({ debit: '現金', credit: '売上' });
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 現金 / 売上');
      expect(creditInput().value).toBe('売上');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('打っている間は保存しない (確定するまで保存値は前のまま)', async () => {
      const user = userEvent.setup();
      renderToolbar();
      await user.clear(creditInput());
      await user.type(creditInput(), '売上');
      expect(creditInput().value).toBe('売上');
      // 開いただけ・打っている途中では保存の key を作らない。
      expect(stored()).toBeNull();
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 売上高');
    });

    it('Enter で保存する。前後の空白は除いた名前になる', async () => {
      const user = userEvent.setup();
      renderToolbar();
      await user.clear(creditInput());
      await user.type(creditInput(), '  売上  {Enter}');
      expect(stored()).toEqual({ debit: '', credit: '売上' });
      expect(creditInput().value).toBe('売上');
      // Enter の後も入力に居る。
      expect(creditInput()).toHaveFocus();
    });

    it('IME の変換を確定する Enter (isComposing・keyCode 229) では確定しない', () => {
      renderToolbar();
      fireEvent.change(creditInput(), { target: { value: 'うりあげ' } });
      fireEvent.keyDown(creditInput(), { key: 'Enter', isComposing: true });
      expect(stored()).toBeNull();
      fireEvent.keyDown(creditInput(), { key: 'Enter', keyCode: 229 });
      expect(stored()).toBeNull();
      expect(creditInput().value).toBe('うりあげ');
      // 変換が終わった後の Enter で確定する。
      fireEvent.keyDown(creditInput(), { key: 'Enter', keyCode: 13 });
      expect(stored()).toEqual({ debit: '', credit: 'うりあげ' });
    });

    it('Enter 以外のキーでは確定しない', () => {
      renderToolbar();
      fireEvent.change(creditInput(), { target: { value: '売上' } });
      fireEvent.keyDown(creditInput(), { key: 'a' });
      expect(stored()).toBeNull();
    });

    it('空欄で確定すると既定の科目に戻る', async () => {
      const user = userEvent.setup();
      save({ debit: '現金', credit: '売上' });
      renderToolbar();
      await waitFor(() => expect(creditInput().value).toBe('売上'));
      await typeAndBlur(user, creditInput(), '');
      expect(stored()).toEqual({ debit: '現金', credit: '' });
      expect(creditInput().value).toBe('売上高');
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 売上高');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('NFD の「ガ」は NFC にそろえて保存する', async () => {
      const user = userEvent.setup();
      renderToolbar();
      const nfd = `${String.fromCodePoint(0x30ab, 0x3099)}ス売上`;
      fireEvent.change(creditInput(), { target: { value: nfd } });
      await user.click(creditInput());
      await user.tab();
      expect(stored().credit).toBe('ガス売上');
      expect(stored().credit).toHaveLength(4);
    });

    it.each([
      ['長すぎる (13 字)', 'あ'.repeat(13), '12 字以内で入力してください。'],
      ['カンマ', '売上,高', 'カンマ・二重引用符 (")・見えない文字は使えません。'],
      ['二重引用符', '売上"高', 'カンマ・二重引用符 (")・見えない文字は使えません。'],
      [
        'ゼロ幅の字',
        `売上${String.fromCodePoint(0x200b)}高`,
        'カンマ・二重引用符 (")・見えない文字は使えません。',
      ],
      ['先頭の =', '=売上', '先頭に = + - @ は使えません。'],
      ['先頭の +', '+売上', '先頭に = + - @ は使えません。'],
      ['先頭の -', '-売上', '先頭に = + - @ は使えません。'],
      ['先頭の @', '@売上', '先頭に = + - @ は使えません。'],
    ])('通らない入力 (%s) は理由を出し、保存値は前のまま', async (_label, text, message) => {
      const user = userEvent.setup();
      save({ debit: '', credit: '売上' });
      renderToolbar();
      await waitFor(() => expect(creditInput().value).toBe('売上'));
      fireEvent.change(creditInput(), { target: { value: text } });
      await user.click(creditInput());
      await user.tab();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(message);
      expect(creditInput()).toHaveAttribute('aria-invalid', 'true');
      expect(creditInput().getAttribute('aria-describedby')).toBe(alert.id);
      expect(alert.id).not.toBe('');
      // 枠は赤で、focus しても青 (focus:border-brand) に変えない。
      expect(creditInput().className).toContain('border-red-500');
      expect(creditInput().className).not.toContain('focus:border-brand');
      // 入力は打ったまま残り (直せる)、保存値と見出しは前のまま。
      expect(creditInput().value).toBe(text);
      expect(stored()).toEqual({ debit: '', credit: '売上' });
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 売上');
      // もう片方の入力には理由を付けない。
      expect(debitInput()).not.toHaveAttribute('aria-invalid');
    });

    it('12 字は通り (surrogate pair の 1 字も 1 字)、エラーは出ない', async () => {
      const user = userEvent.setup();
      renderToolbar();
      const name = String.fromCodePoint(0x20bb7) + 'あ'.repeat(11);
      fireEvent.change(creditInput(), { target: { value: name } });
      await user.click(creditInput());
      await user.tab();
      expect(stored().credit).toBe(name);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('打ち直すと理由が消え、通る名前で確定できる', async () => {
      const user = userEvent.setup();
      renderToolbar();
      await typeAndBlur(user, creditInput(), '=売上');
      expect(screen.getByRole('alert')).toBeInTheDocument();
      await user.clear(creditInput());
      expect(screen.queryByRole('alert')).toBeNull();
      expect(creditInput()).not.toHaveAttribute('aria-invalid');
      expect(creditInput()).not.toHaveAttribute('aria-describedby');
      // 理由が消えたら、枠は普段の色 (focus で青) に戻る。
      expect(creditInput().className).not.toContain('border-red-500');
      expect(creditInput().className).toContain('focus:border-brand');
      await user.type(creditInput(), '売上');
      await user.tab();
      expect(stored().credit).toBe('売上');
    });
  });

  describe('保存値の読み込みと別のタブ', () => {
    it('保存値がある → 入力に入って何も変えずに出ても、保存値が残る (読み込み前の既定値で消さない)', async () => {
      const user = userEvent.setup();
      save({ debit: '現金', credit: '売上' });
      renderToolbar();
      await selectFormat(user, 'mf');
      await waitFor(() => expect(creditInput().value).toBe('売上'));
      expect(debitInput().value).toBe('現金');
      await user.click(debitInput());
      await user.tab();
      await user.click(creditInput());
      await user.tab();
      expect(stored()).toEqual({ debit: '現金', credit: '売上' });
      expect(debitInput().value).toBe('現金');
      expect(creditInput().value).toBe('売上');
    });

    it('作り直しても (再 mount) 保存値から始まる', async () => {
      const user = userEvent.setup();
      const first = renderToolbar();
      await typeAndBlur(user, creditInput(), '売上');
      first.unmount();
      renderToolbar();
      await waitFor(() => expect(creditInput().value).toBe('売上'));
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 売上');
    });

    it('別のタブの変更は、前面に戻ったときに入力と見出しへ出る', async () => {
      renderToolbar();
      expect(stored()).toBeNull();
      save({ debit: '', credit: '別タブ売上' });
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(creditInput().value).toBe('別タブ売上');
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 別タブ売上');
    });

    it('壊れた保存値は既定の科目で出す', async () => {
      window.localStorage.setItem(KEY, JSON.stringify({ debit: '=x', credit: ['売上'] }));
      const user = userEvent.setup();
      renderToolbar();
      await selectFormat(user, 'mf');
      expect(debitInput().value).toBe('売掛金');
      expect(creditInput().value).toBe('売上高');
    });
  });

  describe('freee 形式と lock', () => {
    it('freee 形式: 借方は disabled で「使いません」を出す。値は消さない', async () => {
      const user = userEvent.setup();
      save({ debit: '現金', credit: '売上' });
      renderToolbar();
      await waitFor(() => expect(creditInput().value).toBe('売上'));
      expect(debitInput()).toBeDisabled();
      expect(debitInput().value).toBe('現金');
      const note = screen.getByText('freee 形式では使いません。');
      expect(debitInput().getAttribute('aria-describedby')).toBe(note.id);
      expect(creditInput()).toBeEnabled();
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 売上');

      await selectFormat(user, 'yayoi');
      expect(debitInput()).toBeEnabled();
      expect(screen.queryByText('freee 形式では使いません。')).toBeNull();
      expect(debitInput()).not.toHaveAttribute('aria-describedby');
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 現金 / 売上');
      expect(stored()).toEqual({ debit: '現金', credit: '売上' });
    });

    it('freee 形式へ切り替えると、借方のエラー中の入力は捨てる (保存値は前のまま)', async () => {
      const user = userEvent.setup();
      save({ debit: '現金', credit: '' });
      renderToolbar();
      await selectFormat(user, 'mf');
      await waitFor(() => expect(debitInput().value).toBe('現金'));
      await typeAndBlur(user, debitInput(), '=現金');
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await selectFormat(user, 'freee');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(debitInput()).toBeDisabled();
      expect(debitInput().value).toBe('現金');
      expect(debitInput()).not.toHaveAttribute('aria-invalid');
      // 戻しても、捨てた入力は出ない。
      await selectFormat(user, 'mf');
      expect(debitInput().value).toBe('現金');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(stored()).toEqual({ debit: '現金', credit: '' });
    });

    it('freee 形式へ切り替えるとき、借方の通る途中の入力は確定する', async () => {
      const user = userEvent.setup();
      renderToolbar();
      await selectFormat(user, 'mf');
      // blur が起きない端末を模して、focus を入れずに値だけを変える。
      fireEvent.change(debitInput(), { target: { value: '現金' } });
      fireEvent.change(screen.getByLabelText('会計ソフト形式'), { target: { value: 'freee' } });
      expect(stored()).toEqual({ debit: '現金', credit: '' });
      expect(debitInput()).toBeDisabled();
      expect(debitInput().value).toBe('現金');
    });

    it('fee の lock: 入力は 2 つとも disabled', () => {
      renderToolbar({ csvLocked: true, csvLockReason: 'fee' });
      expect(debitInput()).toBeDisabled();
      expect(creditInput()).toBeDisabled();
    });

    it('fee の lock (弥生形式を選んだ後に lock された場合も) 借方と貸方が disabled', async () => {
      const user = userEvent.setup();
      const view = renderToolbar();
      await selectFormat(user, 'yayoi');
      expect(debitInput()).toBeEnabled();
      view.rerender(
        <HistoryToolbar
          entries={[entry()]}
          filters={EMPTY_HISTORY_FILTERS}
          onFiltersChange={vi.fn()}
          counts={{ all: 1, jpyc: 1, usdc: 0 }}
          directionCounts={{ all: 1, in: 1, out: 0 }}
          usdcJpy={150}
          csvLocked
          csvLockReason="fee"
        />,
      );
      expect(debitInput()).toBeDisabled();
      expect(creditInput()).toBeDisabled();
    });

    it('pass の lock・売上が 0 件のときは変えられる (設定だけ)', async () => {
      const user = userEvent.setup();
      const onCsvPassRequired = vi.fn();
      const { downloadSpy } = spyExport();
      renderToolbar({ csvLocked: true, csvLockReason: 'pass', onCsvPassRequired });
      expect(creditInput()).toBeEnabled();
      await typeAndBlur(user, creditInput(), '売上');
      expect(stored().credit).toBe('売上');
      // 書き出しは購入の案内へ (書き出さない)。
      await user.click(screen.getByRole('button', { name: /会計CSVを書き出し 🔒/ }));
      expect(onCsvPassRequired).toHaveBeenCalledTimes(1);
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('売上が 0 件でも入力は有効', () => {
      renderToolbar({ entries: [] });
      expect(creditInput()).toBeEnabled();
      expect(exportButton()).toBeDisabled();
    });
  });

  describe('書き出し', () => {
    it('変えていないときは既定の科目で書き出す (弥生形式)', async () => {
      const user = userEvent.setup();
      const { downloadSpy, lastCsv } = spyExport();
      renderToolbar();
      await selectFormat(user, 'yayoi');
      await user.click(exportButton());
      expect(downloadSpy).toHaveBeenCalledOnce();
      const row = lastCsv().split(',');
      expect(row[4]).toBe('売掛金');
      expect(row[10]).toBe('売上高');
    });

    it('保存した科目で書き出す (MF は借方と貸方・freee は貸方だけ)', async () => {
      const user = userEvent.setup();
      const { downloadSpy, lastCsv, lastAccounts } = spyExport();
      save({ debit: '現金', credit: '売上' });
      renderToolbar();
      await waitFor(() => expect(creditInput().value).toBe('売上'));

      await user.click(exportButton());
      expect(downloadSpy).toHaveBeenCalledTimes(1);
      expect(lastAccounts()).toEqual({ debit: '現金', credit: '売上' });
      const freeeRow = lastCsv().split('\r\n')[1].split(',');
      expect(freeeRow[2]).toBe('売上');
      expect(lastCsv()).not.toContain('現金');

      await selectFormat(user, 'mf');
      await user.click(exportButton());
      expect(downloadSpy).toHaveBeenCalledTimes(2);
      const mfRow = lastCsv().split('\r\n')[1].split(',');
      expect(mfRow[2]).toBe('現金');
      expect(mfRow[8]).toBe('売上');
    });

    it('確定していない入力 (通る値) のまま書き出しを押す → その値で書き出し、保存する', async () => {
      const { downloadSpy, lastCsv } = spyExport();
      renderToolbar();
      // ボタンを押しても入力から focus が外れない端末を模して、blur を起こさない。
      fireEvent.change(creditInput(), { target: { value: ' 売上 ' } });
      expect(stored()).toBeNull();
      fireEvent.click(exportButton());
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(lastCsv().split('\r\n')[1].split(',')[2]).toBe('売上');
      expect(stored()).toEqual({ debit: '', credit: '売上' });
      expect(creditInput().value).toBe('売上');
      expect(details().querySelector('summary')?.textContent).toBe('勘定科目: 売上');
    });

    it('確定していない入力が空欄のまま書き出しを押す → 既定の科目で書き出す', () => {
      const { downloadSpy, lastCsv } = spyExport();
      save({ debit: '', credit: '売上' });
      renderToolbar();
      fireEvent.change(creditInput(), { target: { value: '' } });
      fireEvent.click(exportButton());
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(lastCsv().split('\r\n')[1].split(',')[2]).toBe('売上高');
      expect(stored()).toEqual({ debit: '', credit: '' });
    });

    it('確定していない入力 (通らない値) のまま書き出しを押す → 書き出さず、欄を開いて理由を出し、その入力へ focus', () => {
      const { downloadSpy, csvSpy } = spyExport();
      save({ debit: '', credit: '売上' });
      renderToolbar();
      expect(details().open).toBe(false);
      fireEvent.change(creditInput(), { target: { value: '=売上' } });
      fireEvent.click(exportButton());

      expect(downloadSpy).not.toHaveBeenCalled();
      expect(csvSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('先頭に = + - @ は使えません。');
      expect(details().open).toBe(true);
      expect(creditInput()).toHaveFocus();
      expect(creditInput()).toHaveAttribute('aria-invalid', 'true');
      expect(stored()).toEqual({ debit: '', credit: '売上' });

      // 直してからもう 1 度押すと書き出せる。
      fireEvent.change(creditInput(), { target: { value: '売上2' } });
      fireEvent.click(exportButton());
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(stored()).toEqual({ debit: '', credit: '売上2' });
    });

    it('blur で理由が出たままの入力があるときも、書き出さない', async () => {
      const user = userEvent.setup();
      const { downloadSpy } = spyExport();
      renderToolbar();
      await typeAndBlur(user, creditInput(), 'あ'.repeat(13));
      expect(screen.getByRole('alert')).toBeInTheDocument();
      await user.click(exportButton());
      expect(downloadSpy).not.toHaveBeenCalled();
      expect(creditInput()).toHaveFocus();
      expect(details().open).toBe(true);
    });

    it('借方と貸方の両方が通らないときは両方に理由を出し、先の借方へ focus', async () => {
      const user = userEvent.setup();
      const { downloadSpy } = spyExport();
      renderToolbar();
      await selectFormat(user, 'mf');
      fireEvent.change(debitInput(), { target: { value: '現金,' } });
      fireEvent.change(creditInput(), { target: { value: '+売上' } });
      fireEvent.click(exportButton());
      expect(downloadSpy).not.toHaveBeenCalled();
      expect(screen.getAllByRole('alert')).toHaveLength(2);
      expect(debitInput()).toHaveFocus();
    });

    it('片方だけが通らないときも書き出さない。通った方は保存する', async () => {
      const user = userEvent.setup();
      const { downloadSpy } = spyExport();
      renderToolbar();
      await selectFormat(user, 'mf');
      fireEvent.change(debitInput(), { target: { value: '現金' } });
      fireEvent.change(creditInput(), { target: { value: '+売上' } });
      fireEvent.click(exportButton());
      expect(downloadSpy).not.toHaveBeenCalled();
      expect(creditInput()).toHaveFocus();
      expect(stored()).toEqual({ debit: '現金', credit: '' });
    });

    it('freee 形式の書き出しは、止まっている借方の欄を見ない (入力が残っていても書き出しを止めない)', () => {
      const { downloadSpy, lastCsv } = spyExport();
      renderToolbar();
      expect(debitInput()).toBeDisabled();
      // 欄が止まる前の入力が確定されずに残った状態を作る (止まった欄は利用者が直せない)。
      fireEvent.change(debitInput(), { target: { value: '=現金' } });
      expect(debitInput().value).toBe('=現金');
      fireEvent.click(exportButton());
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(lastCsv().split('\r\n')[1].split(',')[2]).toBe('売上高');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(stored()).toBeNull();
    });

    it('freee 形式では disabled の借方を見ない: 借方にエラーが残っていても、切り替えれば書き出せる', async () => {
      const user = userEvent.setup();
      const { downloadSpy, lastCsv } = spyExport();
      renderToolbar();
      await selectFormat(user, 'mf');
      await typeAndBlur(user, debitInput(), '=現金');
      await user.click(exportButton());
      expect(downloadSpy).not.toHaveBeenCalled();

      await selectFormat(user, 'freee');
      await user.click(exportButton());
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(lastCsv().split('\r\n')[1].split(',')[2]).toBe('売上高');
    });

    it('pass の lock のときは、途中の入力に触れずに購入の案内だけを出す', () => {
      const onCsvPassRequired = vi.fn();
      const { downloadSpy } = spyExport();
      renderToolbar({ csvLocked: true, csvLockReason: 'pass', onCsvPassRequired });
      fireEvent.change(creditInput(), { target: { value: '=売上' } });
      fireEvent.click(screen.getByRole('button', { name: /会計CSVを書き出し 🔒/ }));
      expect(onCsvPassRequired).toHaveBeenCalledTimes(1);
      expect(downloadSpy).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(creditInput().value).toBe('=売上');
    });

    it('弥生ネイティブ: 科目の Shift_JIS にできない字 (絵文字・𠮷) は今の警告に出て、書き出しは止まらない', async () => {
      const user = userEvent.setup();
      const { downloadSpy } = spyExport();
      const kichi = String.fromCodePoint(0x20bb7);
      save({ debit: `${kichi}野家`, credit: '売上🍣' });
      renderToolbar();
      await waitFor(() => expect(creditInput().value).toBe('売上🍣'));
      await selectFormat(user, 'yayoi-native');
      await user.click(exportButton());

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('🍣'));
      expect(screen.getByRole('status')).toHaveTextContent(kichi);
      expect(screen.getByRole('status')).toHaveTextContent(/表現できない文字が 2 種類あります/);
      await waitFor(() => expect(downloadSpy).toHaveBeenCalledOnce());
      expect(downloadSpy.mock.calls[0]![1]).toMatch(/^openpay-yayoi-native-/);
    });
  });

  describe('見出しの名前と書き出しの名前が一致する (順番ごと)', () => {
    afterEach(() => {
      delete (navigator as { locks?: unknown }).locks;
    });

    it('hydrate の前 (保存値を読む前) は、見出しも書き出しも既定の科目。読んだ後は、見出しも書き出しも保存値', async () => {
      const { csvSpy, lastCsv } = spyExport();
      save({ debit: '現金', credit: '売上' });
      const beforeHydrate: { summary?: string | null; csvCredit?: string } = {};
      // 後ろの兄弟の useLayoutEffect は、toolbar が保存値を読む useEffect より前に走る (= hydrate の前の画面)。
      // そこで見出しを読み、書き出しを押す。
      function BeforeHydrate() {
        useLayoutEffect(() => {
          beforeHydrate.summary = summaryText();
          exportButton().click();
          beforeHydrate.csvCredit = freeeCredit(lastCsv());
        }, []);
        return null;
      }
      renderToolbar({ after: <BeforeHydrate /> });
      expect(beforeHydrate).toEqual({ summary: '勘定科目: 売上高', csvCredit: '売上高' });

      // 読んだ後。
      expect(summaryText()).toBe('勘定科目: 売上');
      fireEvent.click(exportButton());
      expect(csvSpy).toHaveBeenCalledTimes(2);
      expect(freeeCredit(lastCsv())).toBe('売上');
      // 読んだだけでは書かない (hydrate の前の既定の科目で保存値を消さない)。
      expect(stored()).toEqual({ debit: '現金', credit: '売上' });
    });

    it('タブに戻った直後: 別のタブが変えた科目が見出しと書き出しに同じ名前で出る。途中の入力は取り込みで消えない', async () => {
      const user = userEvent.setup();
      const { lastCsv } = spyExport();
      renderToolbar();
      await selectFormat(user, 'mf');
      // このタブの借方は打ちかけ (確定していない)。
      fireEvent.change(debitInput(), { target: { value: '現金' } });
      // 別のタブが貸方を変えてから、このタブに戻る。
      save({ debit: '', credit: '別タブ売上' });
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(summaryText()).toBe('勘定科目: 売掛金 / 別タブ売上');
      expect(creditInput().value).toBe('別タブ売上');
      expect(debitInput().value).toBe('現金');

      fireEvent.click(exportButton());
      expect(mfNames(lastCsv())).toEqual({ debit: '現金', credit: '別タブ売上' });
      expect(summaryText()).toBe('勘定科目: 現金 / 別タブ売上');
      // 書くのは借方だけ (別のタブが変えた貸方を消さない)。
      expect(stored()).toEqual({ debit: '現金', credit: '別タブ売上' });
    });

    it('保存の直後 (Enter で確定した直後): Web Locks を待たずに保存値があり、見出しと書き出しも同じ名前', async () => {
      // Web Locks が返らない環境 (ロックの中で書く作りなら、いつまでも保存されない)。
      const request = vi.fn(() => new Promise<never>(() => undefined));
      Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
      const user = userEvent.setup();
      const { lastCsv } = spyExport();
      renderToolbar();
      await user.clear(creditInput());
      await user.type(creditInput(), '売上{Enter}');
      expect(stored()).toEqual({ debit: '', credit: '売上' });
      expect(request).not.toHaveBeenCalled();
      expect(summaryText()).toBe('勘定科目: 売上');
      fireEvent.click(exportButton());
      expect(freeeCredit(lastCsv())).toBe('売上');
    });

    it('本物の blur → click の順 (打って、そのまま書き出しを押す): 見出し・書き出し・保存値が同じ名前', async () => {
      const user = userEvent.setup();
      const { downloadSpy, lastCsv } = spyExport();
      renderToolbar();
      await selectFormat(user, 'mf');
      await user.click(debitInput());
      await user.clear(debitInput());
      await user.type(debitInput(), '現金');
      // 借方から貸方へ (借方の blur)。
      await user.click(creditInput());
      await user.clear(creditInput());
      await user.type(creditInput(), '売上');
      const order: string[] = [];
      creditInput().addEventListener('blur', () => order.push('blur'));
      exportButton().addEventListener('click', () => order.push('click'));
      await user.click(exportButton());

      expect(order).toEqual(['blur', 'click']);
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(mfNames(lastCsv())).toEqual({ debit: '現金', credit: '売上' });
      expect(summaryText()).toBe('勘定科目: 現金 / 売上');
      expect(stored()).toEqual({ debit: '現金', credit: '売上' });
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('キーボードだけで 開く → 入れる → 書き出す', () => {
    it('入力は Tab で届き、Enter で確定して、Shift+Tab で戻って書き出せる', async () => {
      const user = userEvent.setup();
      const { downloadSpy, lastCsv } = spyExport();
      renderToolbar();
      // 開閉は summary の Enter / Space (ブラウザの動き・jsdom は再現しないので実機で確かめる)。ここでは開いた状態から。
      details().open = true;
      // 欄の直前のボタンから Tab。freee 形式では借方が disabled なので、貸方に届く。
      screen.getByRole('button', { name: '全て削除' }).focus();
      await user.tab();
      expect(creditInput()).toHaveFocus();
      await user.keyboard('{Control>}a{/Control}{Backspace}売上{Enter}');
      expect(stored().credit).toBe('売上');
      // 全て削除 → 会計明細CSV → 会計CSVを書き出し。
      await user.tab({ shift: true });
      await user.tab({ shift: true });
      await user.tab({ shift: true });
      expect(exportButton()).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(downloadSpy).toHaveBeenCalledOnce();
      expect(lastCsv().split('\r\n')[1].split(',')[2]).toBe('売上');
    });
  });
});
