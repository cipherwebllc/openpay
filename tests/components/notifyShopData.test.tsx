// 「お店に知らせる / 注文を送る」の中身 (NotifyShopData) と、NotifyShopButton がそれから作る文を、支払いの画面
// (CheckoutForm) とチェーンを選ぶ画面 (CheckoutChainPicker) の両方で固定する (第 9 回レビュー D-9・PR-20)。
// 2 つの画面は components/checkout/notifyShopData.ts の同じ関数で中身を作り、渡す金額だけが違う:
//   - CheckoutForm: お客様が払う額 (breakdown.customerPays・ガス代をお客様が持つ USDC のガスレスは見積もりを足す)。
//   - CheckoutChainPicker: URL の額 (calcCheckoutPayable)。この画面は JPYC のリンクにしか出ず
//     (lib/url/checkout.ts の parseOfferedChains・tests/lib/checkoutOrderLinkParams.test.ts)、JPYC はどの経路でも
//     お客様が払う額 = URL の額 (下の「JPYC はどの経路でも」) なので、これもお客様が払った額 (user 裁定 Q14)。
// 代表のケース (トークン × 支払い方法 × ガス代の負担 × 値引きと消費税 × 番号つき / 何度でも使えるリンク) で両画面の
// 中身と文を並べ、違うのは「USDC・ガスレス・ガス代はお客様」の金額だけであることを表で固定する (関数にまとめる前の
// 2 か所の組み立てで書き、まとめた後も同じ結果)。USDC の行はチェーンを選ぶ画面に来ない組み合わせ (比較のために画面へ
// 直接渡す)。
//
// NotifyShopButton だけを差し替えて渡された中身を記録する (isRemoteOrderCheckout・notifyShopMessage は実物)。文は
// 記録した中身を実物の NotifyShopButton に渡し、「文をコピー」でクリップボードに渡る文を読む。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Address, Hex } from 'viem';
import { baseSepolia, polygonAmoy } from 'viem/chains';
import type { NotifyShopData } from '@/components/NotifyShopButton';

const captured = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/components/NotifyShopButton', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/NotifyShopButton')>();
  return {
    ...actual,
    // tone (大きな完了画面か下の欄か) は見た目だけなので、中身から外して記録する。
    NotifyShopButton: ({ tone: _tone, ...data }: Record<string, unknown>) => {
      captured.list.push(data);
      return null;
    },
  };
});

vi.mock('wagmi', () => ({
  useWalletClient: vi.fn(() => ({ data: undefined })),
  usePublicClient: vi.fn(() => undefined),
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useSwitchChain: vi.fn(),
  useConnect: vi.fn(() => ({ connectors: [], connect: vi.fn(), isPending: false, error: null })),
  useDisconnect: vi.fn(() => ({ disconnect: vi.fn() })),
  useSignMessage: vi.fn(() => ({ signMessageAsync: vi.fn(), isPending: false })),
}));
vi.mock('@/hooks/useSmartAccount', () => ({ useSmartAccount: vi.fn() }));
vi.mock('@/hooks/useBatchPayment', () => ({ useBatchPayment: vi.fn() }));
vi.mock('@/hooks/useStandardPayment', () => ({ useStandardPayment: vi.fn() }));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({ useGasQuoteUsdc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({ useGasQuoteJpyc: vi.fn() }));
vi.mock('@/hooks/useGasQuoteCircle', () => ({ useGasQuoteCircle: vi.fn() }));
vi.mock('@/hooks/useJpycEip3009Payment', () => ({ useJpycEip3009Payment: vi.fn() }));
vi.mock('@/hooks/useRelayHealth', () => ({ useRelayHealth: vi.fn(() => ({ degraded: false })) }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/circlePaymaster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/circlePaymaster')>('@/lib/circlePaymaster');
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycGaslessProvider')>('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn() };
});
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  // 手元の NEXT_PUBLIC_RECOVER_FEE_BPS に左右されないよう 0 に固定する (tests/components/CheckoutForm.test.tsx と同じ)。
  return { ...actual, env: { ...actual.env, recoverFeeBps: 0 } };
});

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { renderWithIntl as render } from '../_helpers/i18n';
import { mockHook } from '../_helpers/wagmiMock';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { CheckoutForm } from '@/components/CheckoutForm';
import { CheckoutChainPicker } from '@/components/checkout/CheckoutChainPicker';
import { blockExplorerUrl, chainForSlug, type ChainSlug } from '@/lib/chains';
import { rememberOrderPayment, storeConfirmationSignature } from '@/lib/orderConfirmation';
import { orderPaymentContextKey } from '@/lib/orderPaidLookup';
import { orderLinkContextFingerprint } from '@/lib/checkoutIntentContext';
import { calcBreakdown, type GasMode, type PayMode } from '@/lib/fee';
import { effectiveGasAmount, effectiveGasMode, effectivePayMode, paymentBreakdown } from '@/lib/paymentMoney';
import { isRecoverRoute, type PaymentRoute } from '@/lib/paymentRoute';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { notifyShopData } from '@/components/checkout/notifyShopData';
import { env } from '@/lib/env';
import { deploymentForSlug } from '@/lib/tokens';
import { calcCheckoutPayable, type CheckoutParams } from '@/lib/url/checkout';

const { NotifyShopButton: RealNotifyShopButton } =
  await vi.importActual<typeof import('@/components/NotifyShopButton')>('@/components/NotifyShopButton');

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
const CUSTOMER = '0x9999999999999999999999999999999999999999' as Address;
const PAYER = '0x7777777777777777777777777777777777777777' as Address;
const FORWARDER = '0x1111111111111111111111111111111111111111' as Address;
const SIG = `0x${'12'.repeat(65)}` as Hex;
// ガスレスの USDC で、ガス代をお客様が持つときの見積もり (0.12 USDC)。
const USDC_GAS = 120_000n;

type Row = {
  token: 'jpyc' | 'usdc';
  mode: 'gasless' | 'standard';
  gas: 'customer' | 'merchant';
  extras: 'none' | 'discountTax';
  kind: 'orderNo' | 'shipAsk';
};

const ROWS: Row[] = [];
for (const token of ['jpyc', 'usdc'] as const)
  for (const mode of ['gasless', 'standard'] as const)
    for (const gas of ['customer', 'merchant'] as const)
      for (const extras of ['none', 'discountTax'] as const)
        for (const kind of ['orderNo', 'shipAsk'] as const) ROWS.push({ token, mode, gas, extras, kind });

const label = (row: Row) => `${row.token}・${row.mode}・gas=${row.gas}・${row.extras}・${row.kind}`;

/** 支払いの画面に渡す URL の中身 (選んだチェーンで開いた後)。 */
function formParams(row: Row): CheckoutParams {
  const jpyc = row.token === 'jpyc';
  const tax = row.extras === 'discountTax' ? { taxRate: 10 } : {};
  return {
    to: MERCHANT,
    token: row.token,
    chain: jpyc ? 'polygon' : 'base',
    gas: row.gas,
    mode: row.mode,
    items: jpyc
      ? [
          { name: 'Tシャツ', qty: 2, price: '3000', ...tax },
          { name: '送料', qty: 1, price: '500', ...tax },
        ]
      : [
          { name: 'Tシャツ', qty: 2, price: '30', ...tax },
          { name: '送料', qty: 1, price: '5', ...tax },
        ],
    storeName: 'OpenPay 工房',
    ...(row.extras === 'discountTax' ? { discount: jpyc ? '500' : '5', taxRate: 10, invoiceNo: 'T1234567890123' } : {}),
    ...(row.kind === 'orderNo'
      ? { orderId: 'A-001' }
      : { ship: 'ask' as const, contact: { kind: 'line' as const, id: '@openpay' } }),
    // JPYC のリンクは 2 つのチェーンを受け付ける (チェーンを選ぶ画面が出るリンク)。
    ...(jpyc ? { chains: ['polygon', 'kaia'] as ChainSlug[] } : {}),
  };
}

/** チェーンを選ぶ画面に渡す URL の中身 (parse が chain を先頭のチェーンにし、pickChain を付ける)。 */
function pickerParams(row: Row): CheckoutParams {
  const jpyc = row.token === 'jpyc';
  return {
    ...formParams(row),
    chains: jpyc ? ['polygon', 'kaia'] : ['base', 'polygon'],
    chain: jpyc ? 'polygon' : 'base',
    pickChain: true,
  };
}

/** 払ったチェーン。JPYC の何度でも使えるリンクは、支払いの画面が開いているのと別のチェーン (Kaia) で払った記録にする。 */
const paidChain = (row: Row): ChainSlug => (row.token === 'usdc' ? 'base' : row.kind === 'shipAsk' ? 'kaia' : 'polygon');

// 期待する金額 (手で書いた値)。JPYC = 3000 × 2 + 500 (値引き 500)・USDC = 30 × 2 + 5 (値引き 5)。消費税は内税。
const URL_AMOUNT: Record<Row['token'], Record<Row['extras'], string>> = {
  jpyc: { none: '6500 JPYC', discountTax: '6000 JPYC' },
  usdc: { none: '65 USDC', discountTax: '60 USDC' },
};
// USDC のガスレスでガス代をお客様が持つときに、お客様が払う額 (URL の額 + 見積もり 0.12)。
const USDC_GAS_CUSTOMER_AMOUNT: Record<Row['extras'], string> = { none: '65.12 USDC', discountTax: '60.12 USDC' };

/** 2 つの画面で金額が違う行 (それ以外の行は中身も文も同じ)。 */
const AMOUNT_DIFFERS = (row: Row) => row.token === 'usdc' && row.mode === 'gasless' && row.gas === 'customer';

let txSeq = 0;
// 署名はタブ (とページの記憶) に Tx Hash ごとに残るので、ケースごとに別の Tx Hash にする (小文字・記録の形)。
const nextTx = (): Hex => `0x${(0xa000 + ++txSeq).toString(16).padStart(64, '0')}`;

function setIdleHooks() {
  mockHook(useAccount, { address: undefined, isConnected: false, chainId: undefined });
  mockHook(useReadContract, { data: undefined, isLoading: false, error: null });
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false });
  mockHook(useSmartAccount, { data: undefined, isLoading: false, error: null });
  mockHook(useBatchPayment, {
    mutate: vi.fn(),
    retryReceipt: vi.fn(),
    isPending: false,
    isUnknown: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
  });
  mockHook(useStandardPayment, {
    mutate: vi.fn(),
    retryFee: vi.fn(),
    retryReceipt: vi.fn(),
    phase: 'idle',
    isPending: false,
    isSuccess: false,
    isError: false,
    isFeeError: false,
    isMerchantError: false,
    isUnknown: false,
    isMerchantUnknown: false,
    isFeeUnknown: false,
    data: undefined,
    error: null,
    merchantTxHash: undefined,
    feeTxHash: undefined,
    merchantBlockNumber: undefined,
    isRestoring: false,
    hasActiveIntent: false,
    hasAttempt: false,
    restoredFromStorage: false,
  });
  mockHook(useJpycEip3009Payment, {
    mutate: vi.fn(),
    isPending: false,
    data: undefined,
    error: null,
    retryRelay: vi.fn(),
    retrySamePayload: vi.fn(),
    recoveryState: null,
    variables: undefined,
    lastSignedFrom: undefined,
    restoredIntent: null,
    orderDelivery: null,
  });
  const quote = { data: { gasAmount: USDC_GAS }, isLoading: false as const, isError: false as const, error: null };
  mockHook(useGasQuoteUsdc, quote);
  mockHook(useGasQuoteJpyc, quote);
  mockHook(useGasQuoteCircle, { data: undefined, error: null, fetchStatus: 'idle' });
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.list = [];
  setIdleHooks();
  // JPYC のガスレスは本番と同じ relay の回収 (forwarder あり)。USDC は Pimlico (実物と同じく JPYC 以外は relay しない)。
  vi.mocked(resolveJpycGaslessProvider).mockImplementation((deployment) =>
    deployment.symbol === 'jpyc' ? 'eip3009-relay' : 'pimlico-7702',
  );
  vi.mocked(jpycForwarderFor).mockReturnValue(FORWARDER);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function lastCaptured(): NotifyShopData {
  expect(captured.list.length).toBeGreaterThan(0);
  return captured.list[captured.list.length - 1] as NotifyShopData;
}

/** このタブで払った記録を残す (支払いの画面が払ったときに残すのと同じ形)。 */
function remember(row: Row, txHash: Hex) {
  rememberOrderPayment(orderPaymentContextKey(formParams(row), paidChain(row)), {
    txHash,
    // 払ったウォレットの記録がある / 無い の両方を通す
    ...(row.kind === 'orderNo' ? { payer: PAYER } : {}),
    paidAt: Date.now(),
  });
}

/** 支払いの画面を読み直した (このタブで払った記録から「注文を送る」を出す) ときの中身。 */
async function formRestored(row: Row): Promise<NotifyShopData> {
  captured.list = [];
  render(<CheckoutForm params={formParams(row)} />);
  await waitFor(() => expect(captured.list.length).toBeGreaterThan(0));
  const data = lastCaptured();
  cleanup();
  return data;
}

/** チェーンを選ぶ画面 (このタブで払った記録から「注文を送る」を出す) の中身。 */
async function pickerRestored(row: Row): Promise<NotifyShopData> {
  captured.list = [];
  render(<CheckoutChainPicker params={pickerParams(row)} />);
  await waitFor(() => expect(captured.list.length).toBeGreaterThan(0));
  const data = lastCaptured();
  cleanup();
  return data;
}

/** 支払いの画面で払い終えた直後 (大きな完了画面と下の欄) の中身。 */
function formLive(row: Row): NotifyShopData[] {
  captured.list = [];
  const deploymentChain = row.token === 'jpyc' ? polygonAmoy.id : baseSepolia.id;
  mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: deploymentChain });
  mockHook(useReadContract, { data: 10n ** 30n, isLoading: false, error: null });
  if (row.mode === 'standard') {
    mockHook(useStandardPayment, {
      mutate: vi.fn(),
      retryFee: vi.fn(),
      retryReceipt: vi.fn(),
      phase: 'success',
      isPending: false,
      isSuccess: true,
      isError: false,
      isFeeError: false,
      isMerchantError: false,
      isUnknown: false,
      isMerchantUnknown: false,
      isFeeUnknown: false,
      data: { merchantTxHash: `0x${'c'.repeat(64)}`, feeTxHash: undefined, blockNumber: 123n },
      error: null,
      merchantTxHash: `0x${'c'.repeat(64)}`,
      feeTxHash: undefined,
      merchantBlockNumber: 123n,
      isRestoring: false,
      hasActiveIntent: false,
      hasAttempt: true,
      restoredFromStorage: false,
    });
  } else if (row.token === 'jpyc') {
    mockHook(useJpycEip3009Payment, {
      mutate: vi.fn(),
      isPending: false,
      data: { txHash: `0x${'e'.repeat(64)}`, success: true },
      error: null,
      retryRelay: vi.fn(),
      retrySamePayload: vi.fn(),
      recoveryState: null,
      variables: undefined,
      lastSignedFrom: undefined,
      restoredIntent: null,
      orderDelivery: null,
    });
  } else {
    mockHook(useSmartAccount, { data: { smartAccountClient: {}, pimlicoClient: {} }, isLoading: false, error: null });
    mockHook(useBatchPayment, {
      mutate: vi.fn(),
      retryReceipt: vi.fn(),
      isPending: false,
      isUnknown: false,
      isSuccess: true,
      isError: false,
      data: { userOpHash: `0x${'a'.repeat(64)}`, txHash: `0x${'b'.repeat(64)}`, blockNumber: 99n, success: true },
      error: null,
    });
  }
  render(<CheckoutForm params={formParams(row)} />);
  const list = captured.list as NotifyShopData[];
  cleanup();
  return list;
}

/** NotifyShopButton がその中身から作る文 (確認の署名は済ませた状態・「文をコピー」で渡る文)。 */
async function messageOf(data: NotifyShopData): Promise<string> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  if (data.confirm) storeConfirmationSignature({ chain: data.chain, shop: data.shop, txHash: data.txHash }, SIG);
  render(<RealNotifyShopButton {...data} tone="panel" />);
  fireEvent.click(screen.getByRole('button', { name: '文をコピー' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  cleanup();
  return String(writeText.mock.calls[0][0]);
}

const explorerTx = (chain: ChainSlug, tx: string) => `${blockExplorerUrl(chainForSlug(chain).id)}/tx/${tx}`;

describe('お店に知らせる文: 支払いの画面とチェーンを選ぶ画面 (第 9 回レビュー D-9・characterization)', () => {
  it.each(ROWS.map((row) => [label(row), row] as const))(
    '%s: このタブで払った記録から作る中身と文が、金額のほかは 2 つの画面で同じ',
    async (_label, row) => {
      const tx = nextTx();
      remember(row, tx);
      const form = await formRestored(row);
      const picker = await pickerRestored(row);

      // 金額: 支払いの画面 = お客様が払う額・チェーンを選ぶ画面 = URL の額
      const urlAmount = URL_AMOUNT[row.token][row.extras];
      expect(picker.amountDisplay).toBe(urlAmount);
      expect(form.amountDisplay).toBe(AMOUNT_DIFFERS(row) ? USDC_GAS_CUSTOMER_AMOUNT[row.extras] : urlAmount);

      // 金額のほか (受付番号・お届け先・店名・品目・Tx Hash・Explorer・チェーン・お店・払った人・署名・送り先) は同じ
      const { amountDisplay: _formAmount, ...formRest } = form;
      const { amountDisplay: _pickerAmount, ...pickerRest } = picker;
      expect(formRest).toEqual(pickerRest);
      expect(pickerRest).toEqual({
        orderNo: row.kind === 'orderNo' ? 'A-001' : undefined,
        askShipping: row.kind === 'shipAsk',
        storeName: 'OpenPay 工房',
        items: [
          { name: 'Tシャツ', qty: 2 },
          { name: '送料', qty: 1 },
        ],
        txHash: tx,
        explorerTxUrl: explorerTx(paidChain(row), tx),
        chain: paidChain(row),
        shop: MERCHANT,
        ...(row.kind === 'orderNo' ? { payer: PAYER } : {}),
        confirm: row.token === 'jpyc',
        contact: row.kind === 'shipAsk' ? { kind: 'line', id: '@openpay' } : undefined,
      });

      // 文: 違うのは「支払金額」の行だけ
      const formText = await messageOf(form);
      const pickerText = await messageOf(picker);
      expect(pickerText).toContain(`支払金額: ${urlAmount}`);
      expect(formText).toBe(pickerText.replace(`支払金額: ${urlAmount}`, `支払金額: ${form.amountDisplay}`));
      expect(formText === pickerText).toBe(!AMOUNT_DIFFERS(row));
    },
  );

  it('2 つの画面で中身が違うのは、USDC・ガスレス・ガス代はお客様の金額だけ (表)', async () => {
    const differs: string[] = [];
    for (const row of ROWS) {
      const tx = nextTx();
      remember(row, tx);
      const form = await formRestored(row);
      const picker = await pickerRestored(row);
      for (const key of new Set([...Object.keys(form), ...Object.keys(picker)]) as Set<keyof NotifyShopData>) {
        if (JSON.stringify(form[key]) !== JSON.stringify(picker[key])) {
          differs.push(`${label(row)}: ${key} ${String(form[key])} / ${String(picker[key])}`);
        }
      }
    }
    expect(differs).toEqual([
      'usdc・gasless・gas=customer・none・orderNo: amountDisplay 65.12 USDC / 65 USDC',
      'usdc・gasless・gas=customer・none・shipAsk: amountDisplay 65.12 USDC / 65 USDC',
      'usdc・gasless・gas=customer・discountTax・orderNo: amountDisplay 60.12 USDC / 60 USDC',
      'usdc・gasless・gas=customer・discountTax・shipAsk: amountDisplay 60.12 USDC / 60 USDC',
    ]);
  });

  it.each(ROWS.filter((row) => row.kind === 'orderNo').map((row) => [label(row), row] as const))(
    '%s: 払い終えた直後の中身 (大きな完了画面と下の欄) は、読み直したときと同じ金額',
    (_label, row) => {
      const list = formLive(row);
      // 大きな完了画面と下の欄の 2 つに同じ中身を渡す
      expect(list).toHaveLength(2);
      expect(list[0]).toEqual(list[1]);
      expect(list[0].amountDisplay).toBe(AMOUNT_DIFFERS(row) ? USDC_GAS_CUSTOMER_AMOUNT[row.extras] : URL_AMOUNT[row.token][row.extras]);
      const tx = row.mode === 'standard' ? `0x${'c'.repeat(64)}` : row.token === 'jpyc' ? `0x${'e'.repeat(64)}` : `0x${'b'.repeat(64)}`;
      const chain: ChainSlug = row.token === 'jpyc' ? 'polygon' : 'base';
      expect(list[0]).toEqual({
        orderNo: 'A-001',
        askShipping: false,
        storeName: 'OpenPay 工房',
        items: [
          { name: 'Tシャツ', qty: 2 },
          { name: '送料', qty: 1 },
        ],
        amountDisplay: list[0].amountDisplay,
        txHash: tx,
        explorerTxUrl: explorerTx(chain, tx),
        chain,
        shop: MERCHANT,
        confirm: row.token === 'jpyc',
        contact: undefined,
      });
    },
  );

  // 支払いの画面の 3 つ目の出どころ: 読み直した画面で、送った支払いの完了 (relay の intent・通常決済の receipt) を
  // 復元したとき (第 9 回レビュー G-1)。チェーンを選ぶ画面が同じ支払いの記録から作る中身と同じになる。
  it.each<[string, Row]>([
    ['relay の回収 (何度でも使えるリンク)', { token: 'jpyc', mode: 'gasless', gas: 'customer', extras: 'discountTax', kind: 'shipAsk' }],
    ['通常決済 (番号つきの注文)', { token: 'jpyc', mode: 'standard', gas: 'customer', extras: 'none', kind: 'orderNo' }],
  ])('JPYC の%s: 送った支払いの完了を復元した中身は、チェーンを選ぶ画面と同じ', async (_label, row) => {
    const params = formParams(row);
    const deployment = deploymentForSlug('jpyc', 'polygon');
    const total = calcCheckoutPayable(params, deployment.decimals);
    const contextKey = orderPaymentContextKey(params, 'polygon') as Hex;
    const orderLinkKey = orderLinkContextFingerprint(contextKey, params);
    const tx = nextTx();
    if (row.mode === 'standard') {
      const split = calcBreakdown(total, 'jpyc', 'standard');
      mockHook(useStandardPayment, {
        mutate: vi.fn(),
        retryFee: vi.fn(),
        retryReceipt: vi.fn(),
        phase: 'success',
        isPending: false,
        isSuccess: true,
        isError: false,
        isFeeError: false,
        isMerchantError: false,
        isUnknown: false,
        isMerchantUnknown: false,
        isFeeUnknown: false,
        data: { merchantTxHash: tx, feeTxHash: undefined, blockNumber: 123n },
        error: null,
        merchantTxHash: tx,
        feeTxHash: undefined,
        merchantBlockNumber: 123n,
        lastSubmittedParams: {
          tokenAddress: deployment.address,
          merchant: MERCHANT,
          merchantAmount: split.merchantReceives,
          feeReceiver: env.feeReceiver,
          feeAmount: split.feeAmount,
          chainId: deployment.chainId,
          saleAmount: total,
          contextKey,
          orderLinkKey,
        },
        lastSubmittedFrom: PAYER,
        isRestoring: false,
        hasActiveIntent: false,
        hasAttempt: true,
        restoredFromStorage: true,
      });
    } else {
      const fee = 2n * 10n ** 18n;
      mockHook(useJpycEip3009Payment, {
        mutate: vi.fn(),
        isPending: false,
        data: { txHash: tx, success: true },
        error: null,
        retryRelay: vi.fn(),
        retrySamePayload: vi.fn(),
        recoveryState: null,
        variables: { merchant: MERCHANT, value: total - fee },
        lastSignedFrom: undefined,
        restoredIntent: {
          chainId: deployment.chainId,
          from: PAYER,
          merchant: MERCHANT,
          merchantValue: (total - fee).toString(),
          feeValue: fee.toString(),
          nonce: `0x${'6b'.repeat(32)}`,
          validBefore: '9999999999',
          routeKind: 'recover',
          issuedAt: 1_700_000_000_000,
          orderLinkKey,
        },
        orderDelivery: null,
      });
    }
    captured.list = [];
    render(<CheckoutForm params={params} />);
    await waitFor(() => expect(captured.list.length).toBeGreaterThan(0));
    const form = lastCaptured();
    cleanup();
    expect(form.amountDisplay).toBe(URL_AMOUNT.jpyc[row.extras]);
    expect(form.payer).toBe(PAYER);

    // 同じ支払いを、チェーンを選ぶ画面は「このタブで払った記録」から出す (払ったチェーン = Polygon)
    setIdleHooks();
    rememberOrderPayment(contextKey, { txHash: tx, payer: PAYER, paidAt: Date.now() });
    const picker = await pickerRestored(row);
    expect(picker).toEqual(form);
    expect(await messageOf(picker)).toBe(await messageOf(form));
  });

  it('文の全体 (何度でも使えるリンク・JPYC・別のチェーンで払った記録): 空欄・品目・金額・Tx Hash・Explorer・署名の順', async () => {
    const row: Row = { token: 'jpyc', mode: 'gasless', gas: 'customer', extras: 'discountTax', kind: 'shipAsk' };
    const tx = nextTx();
    remember(row, tx);
    const text = await messageOf(await pickerRestored(row));
    expect(text).toBe(
      [
        'OpenPay 工房 に注文します。',
        'お名前：',
        'お届け先（デジタルアドレスか住所）：',
        '',
        '商品: Tシャツ × 2 / 送料 × 1',
        '支払金額: 6000 JPYC',
        `Tx Hash: ${tx}`,
        `https://kairos.kaiascan.io/tx/${tx}`,
        `確認の署名: ${SIG}`,
      ].join('\n'),
    );
    expect(await messageOf(await formRestored(row))).toBe(text);
  });

  it('文の全体 (番号つきの注文・USDC・ガス代はお客様): 支払いの画面はお客様が払う額、チェーンを選ぶ画面は URL の額', async () => {
    const row: Row = { token: 'usdc', mode: 'gasless', gas: 'customer', extras: 'none', kind: 'orderNo' };
    const tx = nextTx();
    remember(row, tx);
    const body = (amount: string) =>
      ['ご注文 A-001 のお支払いが済みました。', `支払金額: ${amount}`, `Tx Hash: ${tx}`, `https://sepolia.basescan.org/tx/${tx}`].join('\n');
    expect(await messageOf(await formRestored(row))).toBe(body('65.12 USDC'));
    expect(await messageOf(await pickerRestored(row))).toBe(body('65 USDC'));
  });
});

describe('notifyShopData (2 つの画面が呼ぶ関数)', () => {
  const params: CheckoutParams = {
    to: MERCHANT,
    token: 'jpyc',
    chain: 'polygon',
    gas: 'customer',
    items: [{ name: 'マグカップ', qty: 2, price: '1750', taxRate: 10, memo: 'メモは送らない' }],
    orderId: 'A-002',
    storeName: 'OpenPay 工房',
    description: '説明は送らない',
  };
  const jpyc = deploymentForSlug('jpyc', 'polygon');

  it('URL の中身・払った額・払った支払いから中身を作る (品目は名前と数だけ・払ったチェーンの Explorer)', () => {
    const tx = `0x${'ab'.repeat(32)}`;
    expect(
      notifyShopData({ params, customerPays: 3500n * 10n ** 18n, deployment: jpyc, txHash: tx, payer: PAYER, chain: 'kaia' }),
    ).toEqual({
      orderNo: 'A-002',
      askShipping: false,
      storeName: 'OpenPay 工房',
      items: [{ name: 'マグカップ', qty: 2 }],
      amountDisplay: '3500 JPYC',
      txHash: tx,
      explorerTxUrl: `https://kairos.kaiascan.io/tx/${tx}`,
      chain: 'kaia',
      shop: MERCHANT,
      payer: PAYER,
      confirm: true,
      contact: undefined,
    });
  });

  it('払ったウォレットが分からなければ payer を入れない・JPYC 以外は確認の署名を求めない・何度でも使えるリンクは空欄を聞く', () => {
    const usdcParams: CheckoutParams = {
      ...params,
      token: 'usdc',
      chain: 'base',
      orderId: undefined,
      ship: 'ask',
      contact: { kind: 'mail', address: 'shop@example.com' },
    };
    const data = notifyShopData({
      params: usdcParams,
      customerPays: 3_620_000n,
      deployment: deploymentForSlug('usdc', 'base'),
      txHash: `0x${'cd'.repeat(32)}`,
      payer: undefined,
      chain: 'base',
    });
    expect('payer' in data).toBe(false);
    expect(data).toMatchObject({
      orderNo: undefined,
      askShipping: true,
      amountDisplay: '3.62 USDC',
      confirm: false,
      contact: { kind: 'mail', address: 'shop@example.com' },
    });
  });
});

// チェーンを選ぶ画面が URL の額を「お客様が払った額」として渡してよい根拠 (Q14)。この画面のリンクは JPYC で利用料の種類
// (feeKind) が無い。その JPYC は、支払いの画面が通りうるどの経路・ガス代の負担・支払い方法でも、支払いの画面と同じ
// 導き方 (CheckoutForm の effectiveGas → relayGasEquiv → effectiveGasAmount → breakdown) で customerPays = URL の額に
// なる。経路は払った記録に残らない (lib/orderConfirmation.ts の rememberOrderPayment) ので、経路で額が変わるなら
// この画面では額が決まらない。USDC はガス代の見積もりを足すので記録から決まらない (この画面に来ない)。
describe('JPYC はどの経路でもお客様が払う額 = URL の額 (チェーンを選ぶ画面の金額の根拠)', () => {
  const TOTAL = 6500n * 10n ** 18n;
  const QUOTE = 3n * 10n ** 17n; // Pimlico の見積もりがあっても JPYC には足さない
  const deployment = deploymentForSlug('jpyc', 'polygon');
  const ROUTES: [string, PaymentRoute][] = [
    ['relay の回収', { kind: 'relay', recover: true }],
    ['relay (ガス代は OpenPay)', { kind: 'relay', recover: false }],
    ['Pimlico', { kind: 'gasless', provider: 'pimlico' }],
    ['通常決済', { kind: 'standard' }],
  ];
  const customerPays = (token: 'jpyc' | 'usdc', route: PaymentRoute, gas: GasMode, mode: PayMode) => {
    const gasMode = effectiveGasMode(route, gas);
    const relayGasEquiv = isRecoverRoute(route) ? recoverFeeValue(TOTAL, gasMode, deployment.chainId) : 0n;
    return paymentBreakdown({
      totalWei: TOTAL,
      token,
      payMode: effectivePayMode(route, mode),
      gasMode,
      effectiveGasAmount: effectiveGasAmount(route, { isJpyc: token === 'jpyc', relayGasEquiv, gasAmount: QUOTE }),
    }).customerPays;
  };

  it.each(
    ROUTES.flatMap(([name, route]) =>
      (['customer', 'merchant'] as const).flatMap((gas) =>
        (['gasless', 'standard'] as const).map((mode) => [name, gas, mode, route] as const),
      ),
    ),
  )('%s・gas=%s・mode=%s', (_name, gas, mode, route) => {
    expect(customerPays('jpyc', route, gas, mode)).toBe(TOTAL);
  });

  it('対比: USDC の Pimlico でガス代がお客様なら見積もりを足す (払った記録からは決まらない)', () => {
    expect(customerPays('usdc', { kind: 'gasless', provider: 'pimlico' }, 'customer', 'gasless')).toBe(TOTAL + QUOTE);
  });

  it('relay の回収は利用料をお店の受取から引く (0 でない利用料でもお客様が払う額は変わらない)', () => {
    expect(recoverFeeValue(TOTAL, 'merchant', deployment.chainId)).toBeGreaterThan(0n);
  });
});
