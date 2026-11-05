// /checkout (CheckoutForm) の relay の状態の案内 (混雑の先回り・送信結果の確認中・IP の混雑) の描画を、出しうる状態ごとに
// 固定する characterization test (第 9 回レビュー F-04・PR-23 の 1 本目・Q11)。
//
// CheckoutForm から表示だけの部品 (components/checkout/RelayStatusBanners.tsx) を切り出す前に、このテストを変更前のコードで
// green にし、切り出した後も無変更で green であることを確かめた。だから部品は直接 render しない: CheckoutForm を render して、
// 描かれた DOM (可視テキスト・role・ボタンの名前と disabled・リンクの href・並び) だけを見る。部品の props の形には依存しない。
//
// 見る範囲: 「注文を中止して戻る」のリンク (params.cancelUrl) と、前のお支払いの確認中の案内 (relay.previousPaymentPending)
// に挟まれた兄弟の要素すべて。そこには relay の API 失敗の banner (Layer A) / 汎用のエラー枠と、切り出す 3 つ
// (Layer B の先回り banner・結果不明・IP の混雑) が、この順で入る。前後を目印で挟むので、並びと位置も固定される。
//
// mock の作法は tests/components/CheckoutForm.test.tsx に合わせる (hook は mockHook で ReturnType に型づけ)。

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { polygonAmoy } from 'viem/chains';
import type { Address } from 'viem';
import messages from '@/messages/ja.json';
import { renderWithIntl as render } from '../_helpers/i18n';
import { mockHook } from '../_helpers/wagmiMock';

vi.mock('wagmi', () => ({
  useWalletClient: vi.fn(() => ({ data: undefined })),
  usePublicClient: vi.fn(),
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
vi.mock('@/hooks/useRelayHealth', () => ({ useRelayHealth: vi.fn(() => ({ degraded: false })) }));
vi.mock('@/hooks/useJpycEip3009Payment', () => ({ useJpycEip3009Payment: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/circlePaymaster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/circlePaymaster')>('@/lib/circlePaymaster');
  return { ...actual, resolveUsdcGaslessProvider: vi.fn(() => 'pimlico') };
});
vi.mock('@/lib/jpycGaslessProvider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jpycGaslessProvider')>('@/lib/jpycGaslessProvider');
  return { ...actual, resolveJpycGaslessProvider: vi.fn(() => 'pimlico-7702') };
});
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null), relayGasFeeValue: vi.fn(() => 2n * 10n ** 18n) };
});
vi.mock('@/lib/pimlico', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pimlico')>('@/lib/pimlico');
  return { ...actual, resolvePaymasterMode: vi.fn(() => 'sponsorship') };
});
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));
// 実物の ConnectButton は jsdom で wagmi の module graph を評価して重い (tests/_helpers/connectButtonStub.tsx)。
vi.mock('@/components/ConnectButton', async () => ({
  ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
}));
// hermetic: 手元の shell の NEXT_PUBLIC_RECOVER_FEE_BPS に左右されないよう 0 に固定する (CheckoutForm.test と同じ)。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, recoverFeeBps: 0 } };
});

import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useGasQuoteUsdc } from '@/hooks/useGasQuoteUsdc';
import { useGasQuoteJpyc } from '@/hooks/useGasQuoteJpyc';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { useJpycEip3009Payment, type JpycRelayRecoveryState } from '@/hooks/useJpycEip3009Payment';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { RelayIpRateLimitedError, RelayResponseUnknownError } from '@/lib/relay/relayResponseError';
import { CheckoutForm } from '@/components/CheckoutForm';
import type { CheckoutParams } from '@/lib/url';

const CF = messages.CheckoutForm;
const RF = messages.RelayFallback;
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const TX_HASH = `0x${'e'.repeat(64)}` as const;
// test env の 'polygon' は Amoy に解決される。切り替え後に払うガスのネイティブトークンは POL。
const NATIVE_TOKEN = 'POL';

const PARAMS: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  items: [{ name: 'チケット', qty: 1, price: '3000' }],
  // 見る範囲の前の目印 (「注文を中止して戻る」のリンク)。
  cancelUrl: 'https://shop.example/cancel',
};

let relayRetryRelay: ReturnType<typeof vi.fn>;
let relayRetrySamePayload: ReturnType<typeof vi.fn>;

type RelayState = {
  isPending?: boolean;
  error?: Error | null;
  recoveryState?: JpycRelayRecoveryState;
  data?: ReturnType<typeof useJpycEip3009Payment>['data'];
};

function setRelay(state: RelayState = {}) {
  relayRetryRelay = vi.fn();
  relayRetrySamePayload = vi.fn();
  mockHook(useJpycEip3009Payment, {
    mutate: vi.fn(),
    isPending: state.isPending ?? false,
    data: state.data,
    error: state.error ?? null,
    retryRelay: relayRetryRelay,
    retrySamePayload: relayRetrySamePayload,
    // 明示した undefined はそのまま渡す (?? で null に変えると、undefined の分岐を確かめられない)。
    recoveryState: 'recoveryState' in state ? state.recoveryState : null,
    restoredIntent: null,
    orderDelivery: null,
    // 見る範囲の後ろの目印 (前のお支払いの確認中の案内・別のお店の文言)。CheckoutForm では表示にしか使わない。
    previousPaymentPending: true,
    previousPaymentSameMerchant: false,
  } as Partial<ReturnType<typeof useJpycEip3009Payment>>);
}

function setIdleHooks() {
  mockHook(useSwitchChain, { switchChain: vi.fn(), isPending: false });
  mockHook(useAccount, { address: CUSTOMER, isConnected: true, chainId: polygonAmoy.id });
  mockHook(useReadContract, { data: 10_000n * 10n ** 18n, isLoading: false, error: null });
  mockHook(useSmartAccount, { data: undefined, isLoading: false, error: null } as Partial<ReturnType<typeof useSmartAccount>>);
  mockHook(useBatchPayment, {
    mutate: vi.fn(),
    retryReceipt: vi.fn(),
    isPending: false,
    isUnknown: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
  } as Partial<ReturnType<typeof useBatchPayment>>);
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
  } as Partial<ReturnType<typeof useStandardPayment>>);
  const quote = { data: undefined, isLoading: false, isError: false, error: null };
  mockHook(useGasQuoteUsdc, quote as Partial<ReturnType<typeof useGasQuoteUsdc>>);
  mockHook(useGasQuoteJpyc, quote as Partial<ReturnType<typeof useGasQuoteJpyc>>);
  mockHook(useGasQuoteCircle, { data: undefined, error: null, fetchStatus: 'idle' } as Partial<ReturnType<typeof useGasQuoteCircle>>);
}

function setDefaults() {
  setIdleHooks();
  setRelay();
  // 既定は relay の経路 (JPYC・relay 対応のチェーン)・free (forwarder なし)・relayer は健全。
  vi.mocked(resolveJpycGaslessProvider).mockReturnValue('eip3009-relay');
  vi.mocked(jpycForwarderFor).mockReturnValue(null);
  vi.mocked(useRelayHealth).mockReturnValue({ degraded: false });
  window.sessionStorage.clear();
  window.localStorage.clear();
}

// 結果不明・IP の混雑の枠 (PaymentStatusPanel) は next/dynamic (ssr:false) で後から読み込まれ、読み込みが終わるまで何も
// 描かない。最初に、この欄の外の枠 (通常決済の受領の確認中) を一度出して読み込みを終わらせておく。
// - 「出さない」の確かめが、読み込み前の空で偽って通らないように。
// - 同じページの別の枠で読み込み済みなら、この欄の枠も同じ render で出る (各 test は render の直後に待たずに見る)。
//   部品の側で別の dynamic() を持つと、読み込みの状態が別になって 1 tick 遅れて出るので、ここで落ちる。
beforeAll(async () => {
  setDefaults();
  mockHook(useStandardPayment, {
    mutate: vi.fn(),
    retryFee: vi.fn(),
    retryReceipt: vi.fn(),
    phase: 'merchant-unknown',
    isPending: false,
    isUnknown: true,
    isMerchantUnknown: true,
    isFeeUnknown: false,
    data: undefined,
    error: new Error('receipt rpc failed'),
    merchantTxHash: `0x${'c'.repeat(64)}`,
    isRestoring: false,
    hasActiveIntent: true,
    hasAttempt: true,
  } as Partial<ReturnType<typeof useStandardPayment>>);
  const { unmount } = render(<CheckoutForm params={{ ...PARAMS, mode: 'standard' }} />);
  await screen.findByText(CF.standardUnknownTitle);
  unmount();
});

beforeEach(() => {
  vi.clearAllMocks();
  setDefaults();
});

type ElementDom = {
  tag: string;
  role: string | null;
  text: string[];
  /** 題 (最初の p) の class。結果不明の枠は題にアイコンを並べる形 (flex) になる。 */
  titleClass: string | null;
  spinner: boolean;
  buttons: { name: string; disabled: boolean }[];
  links: { name: string; href: string | null }[];
};

function elementDom(el: HTMLElement): ElementDom {
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    text: Array.from(el.querySelectorAll('p')).map((p) => p.textContent ?? ''),
    titleClass: el.querySelector('p')?.getAttribute('class') ?? null,
    // 結果の確認中の回転アイコン (装飾なので aria-hidden)。
    spinner: el.querySelector('svg[aria-hidden="true"]') !== null,
    buttons: within(el).queryAllByRole('button').map((b) => ({
      name: b.textContent ?? '',
      disabled: (b as HTMLButtonElement).disabled,
    })),
    links: within(el).queryAllByRole('link').map((a) => ({ name: a.textContent ?? '', href: a.getAttribute('href') })),
  };
}

/** 「注文を中止して戻る」と前のお支払いの案内のあいだの兄弟の要素 (= relay の状態の案内の欄) を、並びどおりに返す。 */
function relayStatusArea(): ElementDom[] {
  const before = screen.getByRole('link', { name: CF.cancelLink });
  const after = screen.getByText(CF.previousPaymentConfirmingOther);
  expect(before.parentElement).toBe(after.parentElement);
  const out: ElementDom[] = [];
  for (let el = before.nextElementSibling; el && el !== after; el = el.nextElementSibling) {
    out.push(elementDom(el as HTMLElement));
  }
  return out;
}

const fallbackBanner = (message: string): ElementDom => ({
  tag: 'div',
  role: null,
  text: [RF.title, message, RF.gasHint.replace('{nativeToken}', NATIVE_TOKEN)],
  titleClass: 'font-semibold',
  spinner: false,
  buttons: [{ name: RF.switchButton, disabled: false }],
  links: [],
});

const responseUnknownPanel = (opts: { auto: boolean; disabled?: boolean }): ElementDom => ({
  tag: 'div',
  role: null,
  text: [CF.responseUnknownTitle, opts.auto ? CF.responseUnknownAutoBody : CF.responseUnknownBody],
  // 題にアイコンを並べる形 (titleWithIcon)。回転アイコンの有無にかかわらず同じ。
  titleClass: 'flex items-center gap-1.5 font-semibold',
  spinner: opts.auto,
  buttons: opts.auto ? [] : [{ name: CF.responseUnknownRetryButton, disabled: opts.disabled ?? false }],
  links: [],
});

const ipRateLimitedPanel = (opts: { retryAfterSeconds: number | null; disabled?: boolean }): ElementDom => ({
  tag: 'div',
  role: null,
  text: [
    CF.ipRateLimitedTitle,
    opts.retryAfterSeconds === null
      ? CF.ipRateLimitedBody
      : CF.ipRateLimitedBodyWithRetryAfter.replace('{seconds}', String(opts.retryAfterSeconds)),
  ],
  titleClass: 'font-semibold',
  spinner: false,
  buttons: [{ name: CF.ipRateLimitedRetryButton, disabled: opts.disabled ?? false }],
  links: [],
});

describe('CheckoutForm — relay の状態の案内の欄 (RelayStatusBanners の characterization・第 9 回レビュー F-04)', () => {
  it('relayer が健全で送る前: 何も出さない', () => {
    render(<CheckoutForm params={PARAMS} />);
    expect(relayStatusArea()).toEqual([]);
  });

  describe('混雑の先回り (Layer B・relayer が degraded)', () => {
    beforeEach(() => {
      vi.mocked(useRelayHealth).mockReturnValue({ degraded: true, reason: 'low_balance' });
    });

    it('送る前: 先回りの文言と「通常支払いに切り替える」を出す', () => {
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([fallbackBanner(CF.relayDegradedPreflight)]);
    });

    it('切り替えるボタンで通常決済になり、欄は空になる', async () => {
      const user = userEvent.setup();
      render(<CheckoutForm params={PARAMS} />);
      await user.click(screen.getByRole('button', { name: RF.switchButton }));
      expect(relayStatusArea()).toEqual([]);
      // 見出しの「通常決済（ガス代は自分で負担）」のバッジ (支払先・チェーンと同じ行に並ぶので部分一致で探す)。
      expect(screen.getAllByText(CF.modeBadgeStandard, { exact: false }).length).toBeGreaterThanOrEqual(1);
    });

    it('送信中 (relay.isPending) は出さない', () => {
      setRelay({ isPending: true });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([]);
    });

    it('送信済みで確定待ち (relay.data あり) は出さない', () => {
      setRelay({ data: { txHash: TX_HASH, success: false, pending: true } });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([]);
    });

    it('結果不明 (exhausted・送信中でない・error も data もない) なら先回りは出さず結果不明だけ', () => {
      // 先回りを止めるのは !relayAmbiguous だけの状態 (isPending・relay.error・relay.data のどれも立てない)。
      setRelay({ recoveryState: 'exhausted' });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false })]);
    });

    it('relay の API 失敗があれば Layer A の banner 1 つだけ (先回りの文言は出さない)', () => {
      setRelay({ error: new Error('rate_limited') });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([fallbackBanner(CF.errorRelayRateLimited)]);
    });

    it('送る前の検証エラー (店主受取 0) と並べて出す: エラー枠の後ろに先回りの banner', () => {
      vi.mocked(jpycForwarderFor).mockReturnValue('0x1111111111111111111111111111111111111111');
      render(<CheckoutForm params={{ ...PARAMS, gas: 'merchant', items: [{ name: 'x', qty: 1, price: '1' }] }} />);
      const area = relayStatusArea();
      expect(area).toHaveLength(2);
      expect(area[0]).toMatchObject({ tag: 'div', role: null, titleClass: 'font-semibold', spinner: false, buttons: [], links: [] });
      expect(area[0].text[0]).toBe(CF.errorTitle);
      expect(area[0].text[1]).toContain(CF.errorMerchantUnderflow.slice(0, CF.errorMerchantUnderflow.indexOf('{')));
      expect(area[1]).toEqual(fallbackBanner(CF.relayDegradedPreflight));
    });
  });

  describe('送信結果の確認中 (relay の結果が不明)', () => {
    it('自動で確かめている間 (recoveryState=auto): 回転アイコンつき・ボタンなし', () => {
      setRelay({ isPending: true, recoveryState: 'auto' });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: true })]);
    });

    it('自動の確認を使い切った (recoveryState=exhausted): 「同じ送信内容を再確認」で同じ payload を確かめ直す', async () => {
      const user = userEvent.setup();
      setRelay({ error: new RelayResponseUnknownError(), recoveryState: 'exhausted' });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false })]);
      await user.click(screen.getByRole('button', { name: CF.responseUnknownRetryButton }));
      expect(relayRetrySamePayload).toHaveBeenCalledOnce();
      expect(relayRetryRelay).not.toHaveBeenCalled();
    });

    it('再確認の送信中 (exhausted + isPending): ボタンは disabled', () => {
      setRelay({ isPending: true, recoveryState: 'exhausted' });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false, disabled: true })]);
    });

    it('recoveryState が無くても応答不明の error なら同じ表示 (ボタンあり)', () => {
      setRelay({ error: new RelayResponseUnknownError(), recoveryState: null });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false })]);
    });

    it('recoveryState が undefined でも応答不明の error なら手動の再確認 (ボタンあり・retrySamePayload)', async () => {
      const user = userEvent.setup();
      setRelay({ error: new RelayResponseUnknownError(), recoveryState: undefined });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false })]);
      await user.click(screen.getByRole('button', { name: CF.responseUnknownRetryButton }));
      expect(relayRetrySamePayload).toHaveBeenCalledOnce();
      expect(relayRetryRelay).not.toHaveBeenCalled();
    });

    it('recoveryState が undefined + 送信中: ボタンは disabled', () => {
      setRelay({ error: new RelayResponseUnknownError(), recoveryState: undefined, isPending: true });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false, disabled: true })]);
    });

    it('今の経路が relay でなくても (Pimlico の経路) relay の結果不明は出す', () => {
      vi.mocked(resolveJpycGaslessProvider).mockReturnValue('pimlico-7702');
      setRelay({ error: new RelayResponseUnknownError(), recoveryState: 'exhausted' });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false })]);
    });

    it('API 失敗の error が後から来ても exhausted なら結果不明の表示のまま (切り替えの banner は出さない)', () => {
      setRelay({ error: new Error('relay_not_configured'), recoveryState: 'exhausted' });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false })]);
    });
  });

  describe('IP の混雑 (relay の早期 429)', () => {
    it('待つ秒数あり: 秒数つきの文言と「同じ内容で再試行」で同じ payload を送り直す', async () => {
      const user = userEvent.setup();
      setRelay({ error: new RelayIpRateLimitedError(45) });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([ipRateLimitedPanel({ retryAfterSeconds: 45 })]);
      await user.click(screen.getByRole('button', { name: CF.ipRateLimitedRetryButton }));
      expect(relayRetryRelay).toHaveBeenCalledOnce();
      expect(relayRetrySamePayload).not.toHaveBeenCalled();
    });

    it('待つ秒数なし: 秒数のない文言', () => {
      setRelay({ error: new RelayIpRateLimitedError(null) });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([ipRateLimitedPanel({ retryAfterSeconds: null })]);
    });

    it('再試行の送信中 (isPending): ボタンは disabled', () => {
      setRelay({ error: new RelayIpRateLimitedError(45), isPending: true });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([ipRateLimitedPanel({ retryAfterSeconds: 45, disabled: true })]);
    });

    it('結果不明 (exhausted) と重なったら結果不明だけを出す', () => {
      setRelay({ error: new RelayIpRateLimitedError(45), recoveryState: 'exhausted' });
      render(<CheckoutForm params={PARAMS} />);
      expect(relayStatusArea()).toEqual([responseUnknownPanel({ auto: false })]);
    });
  });

  // 支払いが完了したら (relay.data.success) 出さない。完了後は「注文を中止して戻る」も出ないので、見る範囲の目印ではなく
  // 題で確かめる。3 つの完了の条件を別々に確かめる (ほかの抑止が同時に効く状態にしない)。
  describe('支払いが完了したら (relay.data.success) 出さない', () => {
    const PAID = { txHash: TX_HASH, success: true } as const;

    it('IP の混雑: 結果不明ではない (recoveryState=null) 状態で、完了だけが止める', () => {
      setRelay({ data: PAID, error: new RelayIpRateLimitedError(45), recoveryState: null });
      render(<CheckoutForm params={PARAMS} />);
      expect(screen.queryByRole('link', { name: CF.cancelLink })).toBeNull();
      expect(screen.queryByText(CF.ipRateLimitedTitle)).toBeNull();
      expect(screen.queryByText(CF.responseUnknownTitle)).toBeNull();
    });

    it('結果不明: exhausted で error なしの状態で、完了だけが止める', () => {
      setRelay({ data: PAID, recoveryState: 'exhausted' });
      render(<CheckoutForm params={PARAMS} />);
      expect(screen.queryByRole('link', { name: CF.cancelLink })).toBeNull();
      expect(screen.queryByText(CF.responseUnknownTitle)).toBeNull();
    });

    it('先回り (Layer B): degraded でも出さない', () => {
      // Layer B の完了の条件は単独では効かせられない: relay の経路の完了は relay.data.success なので、完了していれば
      // relay.data があり、先回りの条件 (relayPreflightActive の !relay.data) が先に止める。ここでは結果だけを固定する。
      vi.mocked(useRelayHealth).mockReturnValue({ degraded: true });
      setRelay({ data: PAID });
      render(<CheckoutForm params={PARAMS} />);
      expect(screen.queryByRole('link', { name: CF.cancelLink })).toBeNull();
      expect(screen.queryByText(RF.title)).toBeNull();
      expect(screen.queryByText(CF.relayDegradedPreflight)).toBeNull();
    });
  });
});
