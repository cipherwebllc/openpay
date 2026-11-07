// components/SalesMoveForm (plans/store-sales-move.md §2.3・P2a): flag OFF の完全 inert・未接続・別チェーン・「全部移す」・
// 画面での拒否・確認の段の 3 つの額・contract のチェック・成功 / 送信済み / 不成立・開き直したときの照会・文字のコントラスト。
// hook (hooks/useSalesMove) は実物で通し、境界 (wagmi・fetch・status の照会) だけを差し替える。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { renderWithIntl } from '../_helpers/i18n';
import { useSwitchChainStub, type SwitchChainStub } from '../_helpers/switchChainStub';
import { auditAllStates } from '../_helpers/tailwindContrast';

const FROM: Address = '0x9999999999999999999999999999999999999999';
const DEST: Address = '0x1111111111111111111111111111111111111111';
const TX: Hex = `0x${'a'.repeat(64)}`;
const JPYC = 10n ** 18n;

const w = vi.hoisted(() => {
  const signTypedData = vi.fn();
  const readContract = vi.fn();
  const getCode = vi.fn();
  const switchStub = { switchChain: vi.fn(), error: null, hold: false, release: () => undefined } as {
    switchChain: (v: { chainId: number }) => void;
    error: Error | null;
    hold: boolean;
    release: () => void;
  };
  return {
    signTypedData,
    readContract,
    getCode,
    switchStub,
    walletClient: { data: { signTypedData } },
    publicClient: { readContract, getCode, waitForTransactionReceipt: vi.fn() },
    account: {
      address: '0x9999999999999999999999999999999999999999' as string | undefined,
      chainId: 80002 as number | undefined,
      isConnected: true,
      connector: undefined,
    },
    balance: { data: undefined as bigint | undefined, isError: false },
    resolveRelayIntent: vi.fn(),
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => w.account,
  useWalletClient: () => w.walletClient,
  usePublicClient: () => w.publicClient,
  useReadContract: () => w.balance,
  useSwitchChain: () => useSwitchChainStub(w.switchStub as SwitchChainStub),
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableSalesMove: true, enableJpycEip3009: true } };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return { ...actual, jpycForwarderFor: () => '0x5555555555555555555555555555555555555555' };
});
vi.mock('@/lib/relay/relayIntentRecovery', () => ({
  resolveRelayIntent: w.resolveRelayIntent,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SalesMoveForm } from '@/components/SalesMoveForm';
import { env } from '@/lib/env';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { txExplorerUrl } from '@/lib/chains';
import { SALES_MOVE_INTENT_STORAGE_KEY } from '@/lib/paymentIntentStorage';

const m = ja.Create.salesMove;
const DEPLOYMENT = defaultDeploymentForSymbol('jpyc');
const CHAIN = DEPLOYMENT.chainId;
const FEE = relayGasFeeValue(CHAIN);
const FORWARDER: Address = '0x5555555555555555555555555555555555555555';

function fmt(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_all, key: string) => String(values[key]));
}

type Reply = { network: true } | { status: number; body: unknown; headers?: Record<string, string> };
let replies: Reply[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  if (String(input) !== '/api/relay/jpyc/move') throw new Error(`想定外の fetch: ${String(input)}`);
  const reply = replies.shift() ?? { status: 200, body: { ok: true, txHash: TX } };
  if ('network' in reply) throw new TypeError('Failed to fetch');
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
});

function renderForm(locale: 'ja' | 'en' = 'ja') {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <SalesMoveForm />
    </QueryClientProvider>,
    { locale },
  );
}

function fill(destination: string, amount: string) {
  fireEvent.change(screen.getByLabelText(m.destinationLabel), { target: { value: destination } });
  fireEvent.change(screen.getByLabelText(m.amountLabel), { target: { value: amount } });
}

async function toReview(destination: string = DEST, amount = '5') {
  fill(destination, amount);
  fireEvent.click(screen.getByRole('button', { name: m.reviewButton }));
  await screen.findByText(m.confirmTotal);
}

beforeEach(() => {
  replies = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  (env as { enableSalesMove: boolean }).enableSalesMove = true;
  w.account.address = FROM;
  w.account.chainId = CHAIN;
  w.account.isConnected = true;
  w.balance = { data: 100n * JPYC, isError: false };
  w.signTypedData.mockResolvedValue(`0x${'ab'.repeat(65)}`);
  w.readContract.mockImplementation(async () => w.balance.data);
  w.getCode.mockResolvedValue(undefined);
  w.switchStub.error = null;
  w.resolveRelayIntent.mockResolvedValue({ kind: 'unknown' });
  vi.stubGlobal('fetch', fetchMock);
});

describe('SalesMoveForm: 出し分け', () => {
  it('flag OFF では何も描かない (wagmi も読まない)', () => {
    (env as { enableSalesMove: boolean }).enableSalesMove = false;
    const { container } = renderForm();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(m.title)).toBeNull();
  });

  it('flag ON では題と説明 (チェーン名と利用料を差し込む) を出す', () => {
    renderForm();
    expect(screen.getByRole('heading', { name: m.title })).toBeInTheDocument();
    expect(screen.getByText(fmt(m.intro, { chain: 'Polygon Amoy', fee: '2' }))).toBeInTheDocument();
  });

  it('en でも同じ情報を出す', () => {
    renderForm('en');
    expect(screen.getByRole('heading', { name: en.Create.salesMove.title })).toBeInTheDocument();
    expect(screen.getByText(fmt(en.Create.salesMove.intro, { chain: 'Polygon Amoy', fee: '2' }))).toBeInTheDocument();
  });

  it('未接続なら案内だけ (入力欄を出さない)', () => {
    w.account.isConnected = false;
    w.account.address = undefined;
    renderForm();
    expect(screen.getByText(m.notConnected)).toBeInTheDocument();
    expect(screen.queryByLabelText(m.destinationLabel)).toBeNull();
  });

  it('別のチェーンなら切り替えのボタン。失敗は知らせる', () => {
    w.account.chainId = 1;
    w.switchStub.error = new Error('switch failed');
    renderForm();
    expect(screen.getByText(fmt(m.wrongChain, { chain: 'Polygon Amoy' }))).toBeInTheDocument();
    expect(screen.queryByLabelText(m.destinationLabel)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: fmt(m.switchButton, { chain: 'Polygon Amoy' }) }));
    expect(w.switchStub.switchChain).toHaveBeenCalledWith({ chainId: CHAIN });
    expect(screen.getByRole('alert')).toHaveTextContent(fmt(m.switchFailed, { chain: 'Polygon Amoy' }));
  });
});

describe('SalesMoveForm: 入力と画面での拒否', () => {
  it('ウォレットにある JPYC と 1 回の上限を出す', () => {
    w.balance = { data: 1234n * JPYC + JPYC / 2n, isError: false };
    renderForm();
    expect(screen.getByText(fmt(m.walletJpyc, { amount: '1,234.5' }))).toBeInTheDocument();
    expect(screen.getByText(fmt(m.maxNote, { maxMove: '49,998', maxTotal: '50,000' }))).toBeInTheDocument();
    for (const note of [m.note1, m.note2, m.note3, fmt(m.note4, { fee: '2' })]) {
      expect(screen.getByText(note)).toBeInTheDocument();
    }
  });

  it('ウォレットの JPYC が利用料 + 1 JPYC 未満なら、「全部移す」も確認も押せない', () => {
    w.balance = { data: FEE + JPYC - 1n, isError: false };
    renderForm();
    expect(screen.getByText(fmt(m.tooLittle, { min: '3', fee: '2' }))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: m.moveAll })).toBeDisabled();
    fill(DEST, '0.5');
    expect(screen.getByRole('button', { name: m.reviewButton })).toBeDisabled();
  });

  it('ちょうど利用料 + 1 JPYC なら「全部移す」で 1 JPYC が入る', () => {
    w.balance = { data: FEE + JPYC, isError: false };
    renderForm();
    expect(screen.queryByText(fmt(m.tooLittle, { min: '3', fee: '2' }))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: m.moveAll }));
    expect(screen.getByLabelText(m.amountLabel)).toHaveValue('1');
  });

  it('「全部移す」はウォレットの JPYC − 利用料 (端数もそのまま)', () => {
    w.balance = { data: 10n * JPYC + 123n, isError: false };
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: m.moveAll }));
    expect(screen.getByLabelText(m.amountLabel)).toHaveValue('8.000000000000000123');
  });

  it('「全部移す」は 1 回の上限で止める', () => {
    w.balance = { data: 80_000n * JPYC, isError: false };
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: m.moveAll }));
    expect(screen.getByLabelText(m.amountLabel)).toHaveValue('49998');
  });

  it.each([
    ['形の崩れたアドレス', '0x1234', m.errors.invalidAddress],
    ['checksum の崩れたアドレス', '0x4284e651C3D8c9A439FedE00d2600032d5DB0Be7', m.errors.invalidAddress],
    ['送り元と同じ', FROM, m.errors.sameAsSender],
    ['forwarder', FORWARDER, m.errors.forbiddenDestination],
    ['feeReceiver', String(env.feeReceiver), m.errors.forbiddenDestination],
    ['JPYC の token', DEPLOYMENT.address, m.errors.forbiddenDestination],
    ['0 アドレス', '0x0000000000000000000000000000000000000000', m.errors.forbiddenDestination],
  ])('送り先の拒否: %s', (_name, destination, message) => {
    renderForm();
    fill(destination, '5');
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText(m.destinationLabel)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: m.reviewButton })).toBeDisabled();
  });

  it('送り先は小文字だけでも通す', () => {
    renderForm();
    fill(DEST.toLowerCase(), '5');
    expect(screen.getByRole('button', { name: m.reviewButton })).toBeEnabled();
  });

  it.each([
    ['数字でない', 'abc', m.errors.invalidAmount],
    ['小数が 19 桁', '1.0000000000000000001', m.errors.invalidAmount],
    ['1 JPYC 未満', '0.5', m.errors.belowMin],
    ['1 回の上限を超える', '49999', fmt(m.errors.aboveMax, { maxMove: '49,998' })],
    ['利用料と合わせて足りない', '99', fmt(m.errors.insufficient, { fee: '2' })],
  ])('移す額の拒否: %s', (_name, amount, message) => {
    renderForm();
    fill(DEST, amount);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: m.reviewButton })).toBeDisabled();
  });

  it('利用料と合わせてちょうど足りる額なら確認へ進める', () => {
    renderForm();
    fill(DEST, '98');
    expect(screen.getByRole('button', { name: m.reviewButton })).toBeEnabled();
  });
});

describe('SalesMoveForm: 確認と結果', () => {
  it('確認の段で「届く額」「利用料」「ウォレットから出る合計」を出す', async () => {
    renderForm();
    await toReview(DEST, '5.5');
    const row = (label: string) => screen.getByText(label).parentElement!;
    expect(row(m.confirmDelivered)).toHaveTextContent('5.5 JPYC');
    expect(row(m.confirmFee)).toHaveTextContent('2 JPYC');
    expect(row(m.confirmTotal)).toHaveTextContent('7.5 JPYC');
    expect(screen.getByText(DEST)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    expect(screen.queryByText(m.contractWarning)).toBeNull();
  });

  it('戻ると入力に戻る (入力はそのまま)', async () => {
    renderForm();
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: m.backButton }));
    expect(screen.getByLabelText(m.amountLabel)).toHaveValue('5');
  });

  it('送り先が contract なら注意とチェックを挟み、チェックするまで署名できない', async () => {
    w.getCode.mockResolvedValue('0x6080604052');
    renderForm();
    await toReview();
    expect(await screen.findByText(m.contractWarning)).toBeInTheDocument();
    const sign = screen.getByRole('button', { name: m.signButton });
    expect(sign).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: m.contractConfirm }));
    expect(sign).toBeEnabled();
    expect(w.getCode).toHaveBeenCalledWith({ address: DEST });
  });

  it('送り先のコードを読めないときは署名させない', async () => {
    w.getCode.mockRejectedValue(new Error('rpc down'));
    renderForm();
    await toReview();
    expect(await screen.findByRole('alert')).toHaveTextContent(m.errors.unavailable);
    expect(screen.getByRole('button', { name: m.signButton })).toBeDisabled();
  });

  it('成功: 移したことと取引へのリンクを出す (入力には戻さない)', async () => {
    renderForm();
    await toReview();
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    expect(await screen.findByText(m.success)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `${m.viewTx} ↗` })).toHaveAttribute('href', txExplorerUrl(CHAIN, TX));
    expect(screen.queryByRole('button', { name: m.signButton })).toBeNull();
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('送信済み・未確定 (202): もう一度署名させない', async () => {
    replies = [{ status: 202, body: { ok: false, pending: true, txHash: TX } }];
    renderForm();
    await toReview();
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    expect(await screen.findByText(m.pending)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: m.signButton })).toBeNull();
    expect(screen.getByRole('link', { name: `${m.viewTx} ↗` })).toHaveAttribute('href', txExplorerUrl(CHAIN, TX));
  });

  it('応答不明: 送信済みかもしれない表示にし、もう一度署名させない', async () => {
    replies = [{ network: true }];
    renderForm();
    await toReview();
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    expect(await screen.findByText(m.pending)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: m.signButton })).toBeNull();
    expect(w.resolveRelayIntent).toHaveBeenCalledTimes(1);
  });

  it('不成立 (revert): 成立しなかったと知らせ、もう一度署名できる', async () => {
    replies = [{ status: 200, body: { ok: false, reverted: true, txHash: TX } }];
    renderForm();
    await toReview();
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    expect(await screen.findByText(m.reverted)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled();
  });

  it.each([
    ['署名の取り消し', () => w.signTypedData.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 })), m.errors.rejected],
    ['送り先の拒否 (server)', () => { replies = [{ status: 400, body: { ok: false, error: 'merchant_is_relayer' } }]; }, m.errors.forbiddenDestination],
    ['日次予算', () => { replies = [{ status: 503, body: { ok: false, error: 'daily_budget_exceeded' } }]; }, m.errors.unavailable],
    ['払い元の rate limit', () => { replies = [{ status: 429, body: { ok: false, error: 'rate_limited' } }]; }, fmt(m.errors.rateLimited, { seconds: 60 })],
    ['IP の rate limit (Retry-After)', () => { replies = [{ status: 429, body: { error: 'ip_rate_limited' }, headers: { 'Retry-After': '20' } }]; }, fmt(m.errors.rateLimited, { seconds: 20 })],
    ['未知のコード', () => { replies = [{ status: 400, body: { ok: false, error: 'future_code' } }]; }, m.errors.generic],
  ])('失敗の文言: %s', async (_name, arrange, message) => {
    arrange();
    renderForm();
    await toReview();
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('IP 制限の後は戻れず、署名のボタンは同じ内容の再送になる (再署名しない)', async () => {
    replies = [{ status: 429, body: { error: 'ip_rate_limited' }, headers: { 'Retry-After': '20' } }];
    renderForm();
    await toReview();
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    await screen.findByText(fmt(m.errors.rateLimited, { seconds: 20 }));
    expect(screen.getByRole('button', { name: m.backButton })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    expect(await screen.findByText(m.success)).toBeInTheDocument();
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
  });

  it('署名の前に読み直したウォレットの JPYC が足りなければ、署名させずに知らせる', async () => {
    renderForm();
    await toReview(DEST, '90');
    w.readContract.mockResolvedValue(50n * JPYC);
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    expect(await screen.findByText(fmt(m.errors.insufficient, { fee: '2' }))).toBeInTheDocument();
    expect(w.signTypedData).not.toHaveBeenCalled();
  });
});

describe('SalesMoveForm: 開き直したときの照会', () => {
  function storeIntent() {
    window.sessionStorage.setItem(
      SALES_MOVE_INTENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        chainId: CHAIN,
        from: FROM,
        merchant: DEST,
        merchantValue: (5n * JPYC).toString(),
        feeValue: FEE.toString(),
        nonce: `0x${'c'.repeat(64)}`,
        validBefore: '9999999999',
        issuedAt: 1_700_000_000_000,
      }),
    );
  }

  it('枠があれば照会し、成立なら移したことを出す (署名・POST はしない)', async () => {
    storeIntent();
    w.resolveRelayIntent.mockResolvedValueOnce({ kind: 'settled', txHash: TX, success: true });
    renderForm();
    expect(await screen.findByText(m.success)).toBeInTheDocument();
    expect(w.resolveRelayIntent).toHaveBeenCalledTimes(1);
    expect(w.resolveRelayIntent.mock.calls[0][0].intent).toMatchObject({ nonce: `0x${'c'.repeat(64)}`, routeKind: 'recover' });
    expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY)).toBeNull();
    expect(w.signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('照会の間と、照会で分からなかったときは、送信済みかもしれない表示のまま (入力を出さない)', async () => {
    storeIntent();
    let finish: (v: { kind: 'unknown' }) => void = () => undefined;
    w.resolveRelayIntent.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderForm();
    expect(await screen.findByText(m.pending)).toBeInTheDocument();
    expect(screen.queryByLabelText(m.destinationLabel)).toBeNull();
    await act(async () => finish({ kind: 'unknown' }));
    expect(screen.getByText(m.pending)).toBeInTheDocument();
    expect(screen.queryByLabelText(m.destinationLabel)).toBeNull();
  });

  it('期限切れで使われなかった枠なら、何も出さずに入力を出す', async () => {
    storeIntent();
    w.resolveRelayIntent.mockResolvedValueOnce({ kind: 'expired' });
    renderForm();
    expect(await screen.findByLabelText(m.destinationLabel)).toBeInTheDocument();
    expect(screen.queryByText(m.pending)).toBeNull();
    expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY)).toBeNull();
  });
});

// Lighthouse の CI は flag OFF でこの画面を描かない。描いた DOM の class から前景と背景を組み立てて計算する
// (tests/_helpers/tailwindContrast.ts)。
describe('SalesMoveForm: 文字のコントラスト (WCAG 2.2 AA)', () => {
  it('入力の段 (ウォレットの JPYC が足りない注意・入力のエラーつき)', () => {
    w.balance = { data: FEE, isError: false };
    renderForm();
    fill('0x1234', '0.5');
    const { failures, checked } = auditAllStates(screen.getByTestId('sales-move'));
    expect(failures).toEqual([]);
    const base = checked.filter((c) => c.state === 'base').map((c) => c.text);
    // 押せないボタン (「全部移す」・確認へ) の中の文字は 1.4.3 の対象外なので、押せる状態は次の test で測る。
    for (const text of [
      m.title,
      fmt(m.walletJpyc, { amount: '2' }),
      fmt(m.tooLittle, { min: '3', fee: '2' }),
      m.destinationLabel,
      m.amountLabel,
      m.notesTitle,
      m.note1,
      m.errors.invalidAddress,
      m.errors.belowMin,
    ]) {
      expect(base, text).toContain(text);
    }
  });

  it('入力の段 (押せる状態の「全部移す」・確認へ)', () => {
    renderForm();
    fill(DEST, '5');
    const { failures, boundaries } = auditAllStates(screen.getByTestId('sales-move'));
    expect(failures).toEqual([]);
    expect(boundaries.map((b) => b.text)).toEqual(expect.arrayContaining([m.moveAll, m.reviewButton]));
  });

  it('確認の段 (contract の注意とチェック)', async () => {
    w.getCode.mockResolvedValue('0x6080604052');
    renderForm();
    await toReview();
    await screen.findByText(m.contractWarning);
    fireEvent.click(screen.getByRole('checkbox', { name: m.contractConfirm }));
    const { failures, checked } = auditAllStates(screen.getByTestId('sales-move'));
    expect(failures).toEqual([]);
    const base = checked.filter((c) => c.state === 'base').map((c) => c.text);
    for (const text of [m.confirmDelivered, m.confirmFee, m.confirmTotal, m.contractWarning, m.contractConfirm, m.backButton, m.signButton]) {
      expect(base, text).toContain(text);
    }
  });

  it('成功・送信済みの表示', async () => {
    renderForm();
    await toReview();
    await waitFor(() => expect(screen.getByRole('button', { name: m.signButton })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: m.signButton }));
    await screen.findByText(m.success);
    const { failures } = auditAllStates(screen.getByTestId('sales-move'));
    expect(failures).toEqual([]);
  });

  it('別のチェーン (切り替えのボタン)', () => {
    w.account.chainId = 1;
    renderForm();
    const { failures, boundaries } = auditAllStates(screen.getByTestId('sales-move'));
    expect(failures).toEqual([]);
    expect(boundaries.map((b) => b.text)).toContain(fmt(m.switchButton, { chain: 'Polygon Amoy' }));
  });
});
