import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';

// 第 10 回レビュー H-K: 購入済みの商品をもう一度買う前の確認の段。
// 画面 (CreatorStorePurchaseFlow)・購入 hook (useHostedStorePurchase)・購入済みの読み取り
// (useStoreAlreadyPurchased)・確認の段・最終確認の画面は実物をつなぐ。mock は境界だけ:
// wagmi (ウォレット)・fetch (server)・env / forwarder の設定値・ConnectButton (jsdom で OOM)。

const FORWARDER = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' as Address;
const MERCHANT = '0x2222222222222222222222222222222222222222' as Address;
const FEE_RECEIVER = '0x3333333333333333333333333333333333333333' as Address;
const PAYER = '0x1111111111111111111111111111111111111111' as Address;
const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const INTENT_SALT = `0x${'ab'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'cd'.repeat(65)}` as Hex;
const RESOURCE_ID = `h_${'a'.repeat(32)}`;
const TITLE = 'Fixture product';
const PRICE_JPYC = '1200';
const PRICE = 1_200n * 10n ** 18n;
const FEE = 12n * 10n ** 18n;
const NOW = 1_800_000_000_000;
const PURCHASED_AT = NOW - 5 * 60_000;

const wallet = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as string | undefined,
  chainId: 80002 as number | undefined,
  signTypedData: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: wallet.address, chainId: wallet.chainId }),
  useWalletClient: () => ({ data: { signTypedData: wallet.signTypedData } }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      networkEnv: 'testnet',
      feeReceiver: '0x3333333333333333333333333333333333333333',
      feeReceiverConfigured: true,
      enableLicenseNftUi: false,
    },
  };
});

vi.mock('@/lib/relay/forwarderConfig', () => ({
  configuredJpycForwarderFor: () =>
    '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));

vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">接続</button>,
}));

import { CreatorStorePurchaseFlow } from '@/components/CreatorStorePurchaseFlow';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function paymentRequired(): Record<string, unknown> {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:80002',
        maxAmountRequired: (PRICE + FEE).toString(),
        resource: `https://open-pay.jp/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}`,
        description: TITLE,
        mimeType: 'application/json',
        payTo: FORWARDER,
        maxTimeoutSeconds: 600,
        asset: JPYC,
        extra: {
          name: 'JPY Coin',
          version: '1',
          decimals: 18,
          assetTransferMethod: 'eip3009',
          openpay: {
            mode: 'forwarder-split',
            forwarder: FORWARDER,
            merchant: MERCHANT,
            merchantValue: PRICE.toString(),
            feeReceiver: FEE_RECEIVER,
            feeValue: FEE.toString(),
            commitVersion: FORWARDER_COMMIT_VERSION,
            intentSalt: INTENT_SALT,
            authorizationValidBeforeMax: '2000000000',
          },
        },
      },
    ],
    error: 'payment_required',
  };
}

/** own content API が購入 (grant) に基づいて返す 200。 */
function purchasedContent(): Response {
  return jsonResponse(
    {
      ok: true,
      state: 'ready',
      resourceId: RESOURCE_ID,
      title: TITLE,
      contentRevision: 1,
      intentSalt: `0x${'12'.repeat(32)}`,
      purchasedAt: PURCHASED_AT,
      txHash: `0x${'ef'.repeat(32)}`,
      kind: 'text',
      value: 'secret body',
    },
    200,
  );
}

function notPurchasedContent(): Response {
  return jsonResponse({ ok: false, error: 'not_found' }, 404);
}

type ContentResponder = () => Promise<Response>;

const server = {
  /** SIWE session の address (null = 未ログイン)。 */
  session: PAYER as Address | null,
  /** own content API の応答。呼ばれた順に使い、最後の 1 つを使い続ける。 */
  content: [] as ContentResponder[],
};

function installFetch() {
  let contentCalls = 0;
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/auth/siwe/me') {
        return jsonResponse({ ok: true, address: server.session }, 200);
      }
      if (url === `/api/store/content/${RESOURCE_ID}`) {
        const responder =
          server.content[Math.min(contentCalls, server.content.length - 1)]!;
        contentCalls += 1;
        return responder();
      }
      if (url.startsWith(`/api/paid/hosted/${RESOURCE_ID}?`)) {
        return new Headers(init?.headers).has('X-PAYMENT')
          ? jsonResponse({ ok: true, state: 'pending' }, 202)
          : jsonResponse(paymentRequired(), 402);
      }
      if (url.startsWith('/api/store/purchase/status?')) {
        return jsonResponse({ ok: true, state: 'pending' }, 200);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
}

type FetchMock = ReturnType<typeof installFetch>;

function callsTo(fetchMock: FetchMock, kind: 'quote' | 'payment' | 'content') {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = String(input);
    if (kind === 'content') return url.startsWith('/api/store/content/');
    if (!url.startsWith('/api/paid/hosted/')) return false;
    const signed = new Headers(init?.headers).has('X-PAYMENT');
    return kind === 'payment' ? signed : !signed;
  });
}

function renderFlow(locale: 'ja' | 'en' = 'ja') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const view = renderWithIntl(
    <QueryClientProvider client={queryClient}>
      <CreatorStorePurchaseFlow
        open
        product={{
          id: RESOURCE_ID,
          title: TITLE,
          priceJpyc: PRICE_JPYC,
          merchant: MERCHANT,
        }}
        sellerDisclosureHref={`/${locale}/store/seller/0xseller`}
        onClose={onClose}
      />
    </QueryClientProvider>,
    { locale },
  );
  return { ...view, onClose };
}

const LABEL = {
  review: '購入内容を確認する',
  confirm: '支払って購入を確定する',
  back: '戻って内容を訂正する',
  title: 'この商品は購入済みです',
  again: 'もう一度購入する',
  cancel: 'やめる',
  library: 'ライブラリで開く',
};

/** 購入済みの読み取りが 1 回終わるまで待つ (応答の後の state の反映も流す)。 */
async function contentSettled(fetchMock: FetchMock, times: number) {
  await waitFor(() =>
    expect(callsTo(fetchMock, 'content')).toHaveLength(times),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  wallet.address = PAYER;
  wallet.chainId = 80002;
  wallet.signTypedData.mockReset();
  wallet.signTypedData.mockResolvedValue(SIGNATURE);
  server.session = PAYER;
  server.content = [async () => notPurchasedContent()];
});

describe('CreatorStorePurchaseFlow: 購入済みの商品をもう一度買う前の確認 (H-K)', () => {
  it('購入済みでなければ確認を出さず、今までどおり見積もり → 署名 → 送信が 1 回ずつ進む', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch();
    renderFlow();

    await user.click(await screen.findByRole('button', { name: LABEL.review }));
    await user.click(await screen.findByRole('button', { name: LABEL.confirm }));
    await waitFor(() => expect(callsTo(fetchMock, 'payment')).toHaveLength(1));

    expect(screen.queryByText(LABEL.title)).not.toBeInTheDocument();
    expect(callsTo(fetchMock, 'quote')).toHaveLength(1);
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('購入済みと分かっていれば、押しても見積もりへ進まず確認を出す。「もう一度購入する」で今までどおり 1 回だけ進む', async () => {
    const user = userEvent.setup();

    // 基準: 購入済みでない買い手の、同じ時刻・同じ見積もりでの署名と送信。
    const baselineFetch = installFetch();
    const baseline = renderFlow();
    await user.click(await screen.findByRole('button', { name: LABEL.review }));
    await user.click(await screen.findByRole('button', { name: LABEL.confirm }));
    await waitFor(() =>
      expect(callsTo(baselineFetch, 'payment')).toHaveLength(1),
    );
    const baselineQuote = callsTo(baselineFetch, 'quote')[0]!;
    const baselinePayment = callsTo(baselineFetch, 'payment')[0]!;
    const baselineSign = wallet.signTypedData.mock.calls[0]!;
    baseline.unmount();
    baselineFetch.mockRestore();
    wallet.signTypedData.mockClear();

    server.content = [async () => purchasedContent()];
    const fetchMock = installFetch();
    renderFlow();
    await contentSettled(fetchMock, 1);

    // 1. 押すと確認の段が出て、見積もりにも署名にも進まない。
    await user.click(screen.getByRole('button', { name: LABEL.review }));
    const heading = await screen.findByRole('heading', { name: LABEL.title });
    expect(heading).toHaveFocus();
    const notice = heading.closest('section')!;
    expect(notice).toHaveTextContent('このウォレットでこの商品を購入した記録があります');
    expect(notice).toHaveTextContent(
      `前回の購入: ${new Intl.DateTimeFormat('ja', { dateStyle: 'medium', timeStyle: 'short' }).format(PURCHASED_AT)}`,
    );
    expect(
      within(notice).getByRole('link', { name: LABEL.library }),
    ).toHaveAttribute('href', '/ja/store/library');
    // 下の画面は隠れていて、押せない。
    expect(
      screen.queryByRole('button', { name: LABEL.review }),
    ).not.toBeInTheDocument();
    expect(callsTo(fetchMock, 'quote')).toHaveLength(0);
    expect(wallet.signTypedData).not.toHaveBeenCalled();

    // 2. 「もう一度購入する」で見積もりへ進む (1 回)。
    await user.click(within(notice).getByRole('button', { name: LABEL.again }));
    const confirm = await screen.findByRole('button', { name: LABEL.confirm });
    expect(screen.queryByText(LABEL.title)).not.toBeInTheDocument();
    expect(callsTo(fetchMock, 'quote')).toHaveLength(1);
    expect(callsTo(fetchMock, 'quote')[0]).toEqual(baselineQuote);
    expect(wallet.signTypedData).not.toHaveBeenCalled();

    // 3. 同じ購入の試みの中では、もう一度は聞かない。署名と送信は基準と同じ引数で 1 回ずつ。
    await user.click(confirm);
    await waitFor(() => expect(callsTo(fetchMock, 'payment')).toHaveLength(1));
    expect(screen.queryByText(LABEL.title)).not.toBeInTheDocument();
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    expect(wallet.signTypedData.mock.calls[0]).toEqual(baselineSign);
    expect(callsTo(fetchMock, 'payment')[0]).toEqual(baselinePayment);
    expect(callsTo(fetchMock, 'quote')).toHaveLength(1);
  });

  it('「やめる」は何も進めず、押したボタンへ focus を戻す。もう一度押すと、もう一度確認する', async () => {
    const user = userEvent.setup();
    server.content = [async () => purchasedContent()];
    const fetchMock = installFetch();
    const { onClose } = renderFlow();
    await contentSettled(fetchMock, 1);

    await user.click(screen.getByRole('button', { name: LABEL.review }));
    await user.click(await screen.findByRole('button', { name: LABEL.cancel }));

    expect(screen.queryByText(LABEL.title)).not.toBeInTheDocument();
    const review = screen.getByRole('button', { name: LABEL.review });
    expect(review).toHaveFocus();
    expect(callsTo(fetchMock, 'quote')).toHaveLength(0);
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(review);
    expect(
      await screen.findByRole('heading', { name: LABEL.title }),
    ).toBeVisible();
    expect(callsTo(fetchMock, 'quote')).toHaveLength(0);
  });

  it('確認の段で「閉じる」を押しても、見積もり・署名は起きない', async () => {
    const user = userEvent.setup();
    server.content = [async () => purchasedContent()];
    const fetchMock = installFetch();
    const { onClose } = renderFlow();
    await contentSettled(fetchMock, 1);

    await user.click(screen.getByRole('button', { name: LABEL.review }));
    await screen.findByRole('heading', { name: LABEL.title });
    await user.click(screen.getByRole('button', { name: '閉じる' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(callsTo(fetchMock, 'quote')).toHaveLength(0);
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });

  it('見積もりの後で購入済みと分かったら、署名の前に確認を出す。「やめる」で最終確認へ戻り、「もう一度購入する」で 1 回だけ署名する', async () => {
    const user = userEvent.setup();
    // 画面を開いたときは購入の記録なし (1 本目がまだ確定していない)。見積もりの後の読み直しで購入済み。
    server.content = [
      async () => notPurchasedContent(),
      async () => purchasedContent(),
    ];
    const fetchMock = installFetch();
    renderFlow();
    await contentSettled(fetchMock, 1);

    // 分かっていないので、止めずに見積もりへ進む。
    await user.click(screen.getByRole('button', { name: LABEL.review }));
    const confirm = await screen.findByRole('button', { name: LABEL.confirm });
    expect(callsTo(fetchMock, 'quote')).toHaveLength(1);
    await contentSettled(fetchMock, 2);

    await user.click(confirm);
    const heading = await screen.findByRole('heading', { name: LABEL.title });
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, 'payment')).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: LABEL.confirm }),
    ).not.toBeInTheDocument();

    await user.click(
      within(heading.closest('section')!).getByRole('button', {
        name: LABEL.cancel,
      }),
    );
    expect(screen.queryByText(LABEL.title)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: LABEL.confirm })).toHaveFocus();
    expect(wallet.signTypedData).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: LABEL.confirm }));
    await user.click(await screen.findByRole('button', { name: LABEL.again }));
    await waitFor(() => expect(callsTo(fetchMock, 'payment')).toHaveLength(1));
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    // 見積もりは取り直さない (同じ見積もりに署名する)。
    expect(callsTo(fetchMock, 'quote')).toHaveLength(1);
  });

  it('「戻って内容を訂正する」の後の見積もりは別の購入の試みなので、もう一度確認する', async () => {
    const user = userEvent.setup();
    server.content = [async () => purchasedContent()];
    const fetchMock = installFetch();
    renderFlow();
    await contentSettled(fetchMock, 1);

    await user.click(screen.getByRole('button', { name: LABEL.review }));
    await user.click(await screen.findByRole('button', { name: LABEL.again }));
    await user.click(await screen.findByRole('button', { name: LABEL.back }));
    expect(callsTo(fetchMock, 'quote')).toHaveLength(1);

    await user.click(await screen.findByRole('button', { name: LABEL.review }));
    expect(
      await screen.findByRole('heading', { name: LABEL.title }),
    ).toBeVisible();
    expect(callsTo(fetchMock, 'quote')).toHaveLength(1);
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });

  it.each([
    ['読み取りが失敗 (通信断)', async () => { throw new TypeError('Failed to fetch'); }],
    ['読み取りが 503', async () => jsonResponse({ ok: false, error: 'storage_unavailable' }, 503)],
    ['読み取りが終わらない (読み込み中)', () => new Promise<Response>(() => {})],
    ['JSON でない 200', async () => new Response('<html>', { status: 200 })],
  ] as [string, ContentResponder][])(
    '%s のときは確認を出さず、購入を止めない',
    async (_label, responder) => {
      const user = userEvent.setup();
      server.content = [responder];
      const fetchMock = installFetch();
      renderFlow();
      await waitFor(() =>
        expect(callsTo(fetchMock, 'content')).toHaveLength(1),
      );

      await user.click(
        await screen.findByRole('button', { name: LABEL.review }),
      );
      await user.click(
        await screen.findByRole('button', { name: LABEL.confirm }),
      );
      await waitFor(() =>
        expect(callsTo(fetchMock, 'payment')).toHaveLength(1),
      );

      expect(screen.queryByText(LABEL.title)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(callsTo(fetchMock, 'quote')).toHaveLength(1);
      expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    },
  );

  it('未ログイン (ウォレットをつないだだけ) の間は、購入済みかを読まない', async () => {
    server.session = null;
    server.content = [async () => purchasedContent()];
    const fetchMock = installFetch();
    renderFlow();

    expect(
      await screen.findByRole('button', { name: 'ログインして購入内容を確認' }),
    ).toBeVisible();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(callsTo(fetchMock, 'content')).toHaveLength(0);
    expect(screen.queryByText(LABEL.title)).not.toBeInTheDocument();
  });

  it('英語でも同じ確認を出す', async () => {
    const user = userEvent.setup();
    server.content = [async () => purchasedContent()];
    const fetchMock = installFetch();
    renderFlow('en');
    await contentSettled(fetchMock, 1);

    await user.click(
      screen.getByRole('button', { name: 'Review purchase details' }),
    );
    const heading = await screen.findByRole('heading', {
      name: 'You already purchased this product',
    });
    const notice = heading.closest('section')!;
    expect(notice).toHaveTextContent(
      'This wallet has a purchase record for this product.',
    );
    expect(notice).toHaveTextContent(
      `Last purchase: ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(PURCHASED_AT)}`,
    );
    expect(
      within(notice).getByRole('link', { name: 'Open in library' }),
    ).toHaveAttribute('href', '/en/store/library');
    expect(
      within(notice).getByRole('button', { name: 'Buy again' }),
    ).toBeVisible();
    expect(within(notice).getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(callsTo(fetchMock, 'quote')).toHaveLength(0);
  });
});
