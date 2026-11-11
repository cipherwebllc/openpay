import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { parseEther, getAddress } from 'viem';
import { renderWithIntl } from '../_helpers/i18n';
import { chainForSlug } from '@/lib/chains';
import type { NativeTipParams } from '@/lib/url';

// wagmi の native 送金境界を hoisted ホルダで mock し、各 test で状態を差し替える。
// ConnectButton は jsdom で重い wagmi graph を描画し OOM を招くため stub する
// (memory:paymentform-oom-rootcause)。
const h = vi.hoisted(() => ({
  account: {
    address: undefined as `0x${string}` | undefined,
    isConnected: false,
    chainId: undefined as number | undefined,
  },
  balance: { data: undefined as { value: bigint } | undefined },
  send: {
    sendTransaction: vi.fn(),
    data: undefined as `0x${string}` | undefined,
    isPending: false,
    error: null as Error | null,
  },
  receipt: {
    data: undefined as { status: 'success' | 'reverted' } | undefined,
    isLoading: false,
    isSuccess: false,
  },
  switchChain: vi.fn(),
  // null でなければ、h.send の代わりにこの hook の戻り値を useSendTransaction の戻り値にする (下の H-O の describe)。
  useSend: null as null | (() => unknown),
}));

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => h.balance,
  useSendTransaction: () => (h.useSend ? h.useSend() : h.send),
  useWaitForTransactionReceipt: () => h.receipt,
  useSwitchChain: () => ({ switchChain: h.switchChain, isPending: false }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <div data-testid="connect-button" />,
}));

import { NativeTipForm } from '@/components/NativeTipForm';

const TO = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const POLYGON = chainForSlug('polygon');
const SYMBOL = POLYGON.nativeCurrency.symbol;

function render(overrides: Partial<NativeTipParams> = {}) {
  return renderWithIntl(
    <NativeTipForm params={{ to: TO, chain: 'polygon', ...overrides }} />,
    { locale: 'ja' },
  );
}

beforeEach(() => {
  h.account = { address: undefined, isConnected: false, chainId: undefined };
  h.balance = { data: undefined };
  h.send = {
    sendTransaction: vi.fn(),
    data: undefined,
    isPending: false,
    error: null,
  };
  h.receipt = { data: undefined, isLoading: false, isSuccess: false };
  h.switchChain = vi.fn();
  h.useSend = null;
});

describe('NativeTipForm', () => {
  it('チェーン名とネイティブ記号を表示', () => {
    render();
    expect(screen.getByText(`${POLYGON.name} · ${SYMBOL}`)).toBeInTheDocument();
  });

  it('未接続 → 接続ボタン文言', () => {
    render();
    expect(
      screen.getByRole('button', { name: 'ウォレットを接続' }),
    ).toBeInTheDocument();
  });

  it('接続済・別チェーン → チェーン切替を促す', () => {
    h.account = { address: TO, isConnected: true, chainId: 1 }; // mainnet ETH 等
    render();
    // インライン切替ボタン「{chainName} に切り替える」(送信ボタン「チェーンを切り替える」とは別)。
    expect(
      screen.getByRole('button', { name: /に切り替える/ }),
    ).toBeInTheDocument();
  });

  it('接続済・正チェーン → 既定プリセット額で送るボタン', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    render();
    expect(screen.getByRole('button', { name: /を送る/ })).toBeInTheDocument();
  });

  it('残高不足 → 注記 + 送るボタン無効', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: 0n } }; // 既定プリセット 1 POL に満たない
    render();
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: /を送る/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('送るボタン押下で sendTransaction を {to,value,chainId} で呼ぶ', async () => {
    const user = userEvent.setup();
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    render();
    await user.click(screen.getByRole('button', { name: /を送る/ }));
    expect(h.send.sendTransaction).toHaveBeenCalledOnce();
    // 送金の中身 (第 1 引数) は今までどおり。第 2 引数は同期の印を外す onSettled だけ (H-O)。
    expect(h.send.sendTransaction.mock.calls[0][0]).toEqual({
      to: TO,
      value: parseEther('1'), // polygon 既定プリセット先頭 = '1'
      chainId: POLYGON.id,
    });
    expect(Object.keys(h.send.sendTransaction.mock.calls[0][1])).toEqual(['onSettled']);
  });

  it('送信中 (txHash 取得・未確定) → 確定待ち表示 + 再送不可', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    h.send = { ...h.send, data: `0x${'a'.repeat(64)}` };
    h.receipt = { data: undefined, isLoading: true, isSuccess: false };
    render();
    const btn = screen.getByRole('button', { name: /確定待ち/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('確定 → 成功パネル + tx + エクスプローラリンク', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    h.send = { ...h.send, data: `0x${'a'.repeat(64)}` };
    h.receipt = { data: { status: 'success' }, isLoading: false, isSuccess: true };
    render();
    expect(screen.getByText(/応援ありがとう/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /エクスプローラ/ }),
    ).toBeInTheDocument();
  });

  it('revert → エラー文言を表示 + 再送ボタンは有効 (リロードせず再試行可)', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    h.send = { ...h.send, data: `0x${'a'.repeat(64)}` };
    h.receipt = { data: { status: 'reverted' }, isLoading: false, isSuccess: false };
    render();
    expect(screen.getByText(/ネットワーク上で失敗/)).toBeInTheDocument();
    // revert 後は txHash が残っても再送を許す (二重チップは success 時のみ防ぐ)。
    expect(
      (screen.getByRole('button', { name: /を送る/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('19 桁小数の custom 入力 → 精度超過エラー文言を表示 (理由不明の不送信を解消)', async () => {
    const user = userEvent.setup();
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    render();
    // 18 桁ネイティブに対し 19 桁 = 精度超過 (amountWei は 0n に落ちる)。
    await user.type(
      screen.getByPlaceholderText('例: 1'),
      '1.1234567890123456789',
    );
    expect(screen.getByText(/小数点以下は最大 18 桁/)).toBeInTheDocument();
  });

  it('残高ぴったり → gas 予約分で insufficient 扱い・送信不可', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    // 既定プリセット 1 POL に対し残高もちょうど 1 POL。gas 予約 (0.001) が乗らず拒否される。
    h.balance = { data: { value: parseEther('1') } };
    render();
    expect(screen.getByText(/残高が不足/)).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: /を送る/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('残高 − 0.002 の額 → gas 予約 (0.001) を差し引いても足り送信可', async () => {
    const user = userEvent.setup();
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('1') } };
    render();
    // 1 − 0.002 = 0.998。0.998 + 0.001 予約 = 0.999 ≤ 1 残高 → 送信可。
    await user.type(screen.getByPlaceholderText('例: 1'), '0.998');
    expect(screen.queryByText(/残高が不足/)).toBeNull();
    expect(
      (screen.getByRole('button', { name: /を送る/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  // 「署名安心 UX」P2: ネイティブ送金は通常の送金確認 1 行ヒントのみ (計画 §3.3)。
  it('署名安心: native ヒント 1 行を送信ボタン直上に出す (フルパネルは出さない)', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    render();
    expect(
      screen.getByText(/通常の送金確認が表示されます/),
    ).toBeInTheDocument();
    // フルパネル (relay free) の見出しは出さない。
    expect(screen.queryByText(/求められるのは「署名」1回だけ/)).toBeNull();
  });

  it('署名安心: 確定後 (成功) は native ヒントを出さない', () => {
    h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
    h.balance = { data: { value: parseEther('100') } };
    h.send = { ...h.send, data: `0x${'a'.repeat(64)}` };
    h.receipt = { data: { status: 'success' }, isLoading: false, isSuccess: true };
    render();
    expect(screen.queryByText(/通常の送金確認が表示されます/)).toBeNull();
  });

  // H-O: 送信の入口の同期の印 (sendingRef)。ボタンを閉じる isSending は再描画の後にしか変わらないので、
  // 再描画の前に続けてクリックされるとウォレットへの依頼が 2 件出ていた。
  describe('送金の入口の同期の印 (H-O)', () => {
    type Hash = `0x${string}`;
    const HASH: Hash = `0x${'b'.repeat(64)}`;
    const SEND = { to: TO, value: parseEther('1'), chainId: POLYGON.id };
    let walletRequest: Mock<(variables: unknown) => Promise<Hash>>;
    let pending: { resolve: (hash: Hash) => void; reject: (err: Error) => void }[];

    // wagmi 2.19.5 の useSendTransaction は useMutation の mutate をそのまま sendTransaction として返す
    // (node_modules/wagmi/dist/esm/hooks/useSendTransaction.js)。印を外す onSettled が本物の mutation の順で
    // 呼ばれることを確かめるために、ウォレットへの依頼 (mutationFn) だけを差し替えた本物の useMutation を使う。
    function useRealSend() {
      const { mutate, data, isPending, error } = useMutation<Hash, Error, unknown>({
        mutationFn: walletRequest,
      });
      return { sendTransaction: mutate, data, isPending, error };
    }

    function connect() {
      h.account = { address: TO, isConnected: true, chainId: POLYGON.id };
      h.balance = { data: { value: parseEther('100') } };
    }

    function renderReal(reactStrictMode = false) {
      connect();
      h.useSend = useRealSend;
      return renderWithIntl(
        <QueryClientProvider client={new QueryClient()}>
          <NativeTipForm params={{ to: TO, chain: 'polygon' }} />
        </QueryClientProvider>,
        { locale: 'ja', reactStrictMode },
      );
    }

    const sendButton = () =>
      screen.getByRole('button', { name: /を送る/ }) as HTMLButtonElement;

    // 同じ tick (間に再描画をはさまない) に 2 回クリックする。1 回目の後もボタンは開いたまま = 2 回目を
    // 断てるのは state ではなく同期の印だけ。
    function clickTwiceInOneTick() {
      const btn = sendButton();
      act(() => {
        fireEvent.click(btn);
        expect(btn.disabled).toBe(false);
        fireEvent.click(btn);
      });
    }

    // 依頼を出して、送信中の表示 (state の反映) まで待つ。
    async function clickAndWaitForSending() {
      fireEvent.click(sendButton());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '送信中…' })).toBeDisabled(),
      );
    }

    beforeEach(() => {
      pending = [];
      walletRequest = vi.fn(
        () =>
          new Promise<Hash>((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      );
    });

    it.each([false, true])(
      '同じ tick に 2 回クリック → sendTransaction は 1 回だけ (reactStrictMode: %s)',
      (reactStrictMode) => {
        connect();
        renderWithIntl(<NativeTipForm params={{ to: TO, chain: 'polygon' }} />, {
          locale: 'ja',
          reactStrictMode,
        });
        clickTwiceInOneTick();
        expect(h.send.sendTransaction).toHaveBeenCalledTimes(1);
        expect(h.send.sendTransaction.mock.calls[0][0]).toEqual(SEND);
      },
    );

    it.each([false, true])(
      '同じ tick に 2 回クリック → ウォレットへの依頼は 1 件だけ (本物の mutation・reactStrictMode: %s)',
      async (reactStrictMode) => {
        renderReal(reactStrictMode);
        clickTwiceInOneTick();
        // 送信中の表示が出た = 出た依頼はすべて mutationFn まで進んでいる。
        await waitFor(() =>
          expect(screen.getByRole('button', { name: '送信中…' })).toBeDisabled(),
        );
        expect(walletRequest).toHaveBeenCalledTimes(1);
        expect(walletRequest.mock.calls[0][0]).toEqual(SEND);
      },
    );

    it('結果が決まるまでは、state が反映されないまま後からクリックされても 2 件目を出さない。決まったら外れる', () => {
      // h.send は isPending が false のまま = state がいつまでも描画に反映されない最悪の場合。
      connect();
      render();
      fireEvent.click(sendButton());
      // fireEvent ごとに再描画が済んでいる (別の tick)。ボタンは開いたままでも、依頼中は出さない。
      expect(sendButton().disabled).toBe(false);
      fireEvent.click(sendButton());
      expect(h.send.sendTransaction).toHaveBeenCalledTimes(1);

      // 結果が決まった (wagmi が mutate ごとの onSettled を呼ぶ) → 次のクリックは通る。
      act(() => h.send.sendTransaction.mock.calls[0][1].onSettled());
      fireEvent.click(sendButton());
      expect(h.send.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])(
      'ウォレットで拒否 → error は出さず、もう一度押すと送れる (reactStrictMode: %s)',
      async (reactStrictMode) => {
        renderReal(reactStrictMode);
        await clickAndWaitForSending();
        expect(walletRequest).toHaveBeenCalledTimes(1);

        await act(async () => pending[0].reject(new Error('User rejected the request.')));
        await waitFor(() => expect(sendButton().disabled).toBe(false));
        expect(screen.queryByText('エラー')).toBeNull();

        await clickAndWaitForSending();
        expect(walletRequest).toHaveBeenCalledTimes(2);
        expect(walletRequest.mock.calls[1][0]).toEqual(SEND);
      },
    );

    it('error (拒否以外) → error の文を出し、もう一度押すと送れる', async () => {
      renderReal();
      await clickAndWaitForSending();

      await act(async () => pending[0].reject(new Error('insufficient funds for gas')));
      await waitFor(() => expect(sendButton().disabled).toBe(false));
      expect(screen.getByText('エラー')).toBeInTheDocument();
      expect(screen.getByText('insufficient funds for gas')).toBeInTheDocument();

      await clickAndWaitForSending();
      expect(walletRequest).toHaveBeenCalledTimes(2);
    });

    it('成功 → 成功の欄を出し、ボタンは閉じたままで 2 件目を出さない (今までどおり)', async () => {
      renderReal();
      await clickAndWaitForSending();

      h.receipt = { data: { status: 'success' }, isLoading: false, isSuccess: true };
      await act(async () => pending[0].resolve(HASH));
      await waitFor(() =>
        expect(screen.getByText(/応援ありがとう/)).toBeInTheDocument(),
      );
      expect(screen.getByText(HASH)).toBeInTheDocument();
      expect(sendButton().disabled).toBe(true);
      fireEvent.click(sendButton());
      expect(walletRequest).toHaveBeenCalledTimes(1);
    });

    it('hash が返った後に revert → 今までどおり、もう一度押すと送れる (印は外れている)', async () => {
      renderReal();
      await clickAndWaitForSending();

      h.receipt = { data: { status: 'reverted' }, isLoading: false, isSuccess: false };
      await act(async () => pending[0].resolve(HASH));
      await waitFor(() =>
        expect(screen.getByText(/ネットワーク上で失敗/)).toBeInTheDocument(),
      );
      expect(sendButton().disabled).toBe(false);

      await clickAndWaitForSending();
      expect(walletRequest).toHaveBeenCalledTimes(2);
    });
  });
});
