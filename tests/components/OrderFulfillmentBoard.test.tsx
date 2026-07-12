// 受注フルフィルメントボード (厨房/ホール) を実描画で検証。useSiweSession / useOrderFeed は mock
// (react-query/fetch を介さず、描画 + op 発火を直接検証)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { StoredOrder } from '@/lib/orderRelay';

const envHold = vi.hoisted(() => ({
  enablePreorderTime: false,
  enableOrderToken: false,
  enableOrderPickup: false,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enablePreorderTime() {
        return envHold.enablePreorderTime;
      },
      get enableOrderToken() {
        return envHold.enableOrderToken;
      },
      get enableOrderPickup() {
        return envHold.enableOrderPickup;
      },
    },
  };
});

// 受注閲覧トークンの localStorage (店員端末)。token モードのテストで制御する。
const tokenHold = vi.hoisted(() => ({ stored: null as string | null }));
vi.mock('@/lib/orderTokenClient', () => ({
  getStoredOrderToken: () => tokenHold.stored,
  setStoredOrderToken: (t: string) => {
    tokenHold.stored = t;
  },
  clearStoredOrderToken: () => {
    tokenHold.stored = null;
  },
}));

const siwe = vi.hoisted(() => ({
  isSignedIn: true,
  sessionAddress: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: siwe.isSignedIn,
    sessionAddress: siwe.sessionAddress,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
  }),
}));

const mutateSpy = vi.hoisted(() => vi.fn());
const feedHold = vi.hoisted(() => ({
  data: [] as StoredOrder[],
  isError: false,
  error: null as Error | null,
  lastTokenArg: undefined as string | null | undefined, // board が useOrderFeed に渡した token 引数
}));
vi.mock('@/hooks/useOrderFeed', () => ({
  useOrderFeed: (_addr: unknown, _signed: unknown, _ms: unknown, token: string | null | undefined) => {
    feedHold.lastTokenArg = token;
    return {
      feed: { data: feedHold.data, isError: feedHold.isError, error: feedHold.error, isLoading: false, refetch: vi.fn() },
      update: { mutate: mutateSpy, isPending: false },
    };
  },
}));

// 新着アラート音 (Web Audio) + 設定 pref を spy 化 (jsdom は AudioContext 無し)。
const chime = vi.hoisted(() => ({ play: vi.fn(), prime: vi.fn() }));
vi.mock('@/lib/successChime', () => ({
  playNewOrderChime: () => chime.play(),
  primeChimeAudio: () => chime.prime(),
}));
const soundHold = vi.hoisted(() => ({ enabled: false, set: vi.fn() }));
vi.mock('@/lib/soundPref', () => ({
  isOrderAlertSoundEnabled: () => soundHold.enabled,
  setOrderAlertSoundEnabled: (v: boolean) => soundHold.set(v),
}));

import { OrderFulfillmentBoard } from '@/components/OrderFulfillmentBoard';

const TX = `0x${'a'.repeat(64)}`;
const TX2 = `0x${'b'.repeat(64)}`;
function order(over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: 'A1',
    items: [{ name: '牛丼', qty: 1, price: '500' }],
    table: 'T1',
    amount: '1000000000000000000',
    txHash: TX,
    chainId: 137,
    from: '',
    ts: Date.now(), // 既定は「いま」= 経過時間バッジを出さない (個別テストで過去に上書き)
    fulfilled: false,
    ...over,
  };
}

beforeEach(() => {
  siwe.isSignedIn = true;
  siwe.sessionAddress = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81'; // wallet テストで変えるので毎回戻す
  feedHold.data = [order()];
  feedHold.isError = false;
  feedHold.error = null;
  feedHold.lastTokenArg = undefined;
  mutateSpy.mockClear();
  envHold.enablePreorderTime = false; // Phase 4 flag 既定 OFF
  envHold.enableOrderToken = false; // Phase 5 flag 既定 OFF
  envHold.enableOrderPickup = false; // お渡し準備完了通知 flag 既定 OFF
  tokenHold.stored = null;
  soundHold.enabled = false; // 新着アラート音 既定 OFF
  soundHold.set.mockClear();
  chime.play.mockClear();
  chime.prime.mockClear();
  window.history.replaceState(null, '', '/'); // URL を初期化 (?t= strip テストの相互汚染防止)
});

describe('OrderFulfillmentBoard', () => {
  it('未サインインはサインインを促す', () => {
    siwe.isSignedIn = false;
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByRole('button', { name: 'サインイン' })).toBeInTheDocument();
  });

  it('厨房: 商品タップで itemCooked op を発火', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: /牛丼/ }));
    expect(mutateSpy).toHaveBeenCalledWith({
      txHash: TX,
      op: { kind: 'itemCooked', index: 0, value: true },
    });
  });

  it('ホール: 商品タップで itemServed op を発火', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    fireEvent.click(screen.getByRole('button', { name: /牛丼/ }));
    expect(mutateSpy).toHaveBeenCalledWith({
      txHash: TX,
      op: { kind: 'itemServed', index: 0, value: true },
    });
  });

  it('ホール + 準備完了通知 ON + ready 前 → 「お渡し準備完了（通知）」で markReady op を発火', () => {
    envHold.enableOrderPickup = true;
    feedHold.data = [order({ table: null })]; // テイクアウト
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    fireEvent.click(screen.getByRole('button', { name: /お渡し準備完了/ }));
    expect(mutateSpy).toHaveBeenCalledWith({
      txHash: TX,
      op: { kind: 'markReady', value: true },
    });
  });

  it('ホール + 準備完了通知 ON + ready 済 → 「通知済み・受取待ち」バッジ + 受け渡しボタン (準備完了ボタンは消える)', () => {
    envHold.enableOrderPickup = true;
    feedHold.data = [order({ ready: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText('通知済み・受取待ち')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /お渡し準備完了/ })).toBeNull();
    // 通知後は受け渡し (fulfill) へ進む 2 段目。
    fireEvent.click(screen.getByRole('button', { name: '配膳済み' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'fulfill', value: true } });
  });

  it('ホール + 準備完了通知 OFF → 準備完了ボタン/バッジ無し (従来どおり配膳済みのみ・inert)', () => {
    feedHold.data = [order({ ready: true })]; // 保存に ready があっても OFF では無視
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByRole('button', { name: /お渡し準備完了/ })).toBeNull();
    expect(screen.queryByText('通知済み・受取待ち')).toBeNull();
    expect(screen.getByRole('button', { name: '配膳済み' })).toBeInTheDocument();
  });

  it('amountUnchecked → 警告バッジと実着金額ラベルを表示', () => {
    feedHold.data = [order({ amountUnchecked: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByText('⚠ 金額未確認')).toBeInTheDocument();
    expect(screen.getByText('実着金額')).toBeInTheDocument();
  });

  it('amountMismatch → 申告合計も表示', () => {
    feedHold.data = [order({ amountMismatch: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByText('⚠ 金額不一致・要確認')).toBeInTheDocument();
    expect(screen.getByText('申告合計: 500 JPYC')).toBeInTheDocument();
  });

  it('厨房 + 準備完了通知 ON → 準備完了ボタンは出さない (ホール専用)', () => {
    envHold.enableOrderPickup = true;
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByRole('button', { name: /お渡し準備完了/ })).toBeNull();
  });

  it('対応済み(fulfill)ボタンは出さない (受注で確定・厨房→ホール連動消失を回避)', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByRole('button', { name: '対応済み' })).toBeNull();
  });

  it('テーブル訂正: 編集→保存で setTable op を発火 (店内・table あり)', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: /T1/ })); // テーブル編集を開く
    fireEvent.change(screen.getByLabelText('テーブル番号'), { target: { value: 'B2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(mutateSpy).toHaveBeenCalledWith({
      txHash: TX,
      op: { kind: 'setTable', table: 'B2' },
    });
  });

  it('テイクアウト (table 空) はテーブル未設定/訂正を出さない', () => {
    feedHold.data = [order({ table: null })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByText('テーブル未設定')).toBeNull();
    expect(screen.queryByText('訂正')).toBeNull();
    // 商品 (調理対象) は出る (テイクアウトでも厨房は調理する)。
    expect(screen.getByRole('button', { name: /牛丼/ })).toBeInTheDocument();
  });

  it('対応済みの注文は表示しない (未対応のみ)', () => {
    feedHold.data = [order({ fulfilled: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByText(/牛丼/)).toBeNull();
    expect(screen.getByText('未対応の受注はありません。')).toBeInTheDocument();
  });

  it('flag ON + pickupAt → 受取予定時刻バッジを Tokyo HH:mm で表示 (Phase 4)', () => {
    envHold.enablePreorderTime = true;
    // Date.UTC(2024,0,15,4,30) = Tokyo 13:30。tokyoHHMM は純関数 (Date.now 非依存)。
    feedHold.data = [order({ pickupAt: Date.UTC(2024, 0, 15, 4, 30) })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText('受取 13:30')).toBeInTheDocument();
  });

  it('flag OFF: pickupAt があってもバッジを出さない (inert)', () => {
    // flag OFF (既定) + pickupAt 有り → 手動 pickup_at 混入でも観測上 inert。
    feedHold.data = [order({ pickupAt: Date.UTC(2024, 0, 15, 4, 30) })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByText(/受取 \d/)).toBeNull();
  });

  it('pickupAt が無ければバッジを出さない', () => {
    envHold.enablePreorderTime = true;
    feedHold.data = [order()]; // pickupAt 無し
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByText(/受取 \d/)).toBeNull();
  });

  it.each([
    ['normal', 16 * 60_000, ['bg-sky-100', 'text-sky-700']],
    ['soon', 15 * 60_000, ['bg-amber-100', 'text-amber-700']],
    ['late', -1, ['bg-red-100', 'text-red-700']],
  ] as const)('pickupAt 緊急度 %s の色を表示', (_urgency, offsetMs, classes) => {
    envHold.enablePreorderTime = true;
    feedHold.data = [order({ pickupAt: Date.now() + offsetMs })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText(/受取 \d/)).toHaveClass(...classes);
  });

  it('pickupAt 緊急度は親の 30s tick で soon から late に更新する', () => {
    vi.useFakeTimers();
    try {
      envHold.enablePreorderTime = true;
      feedHold.data = [order({ pickupAt: Date.now() + 20_000 })];
      renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
      expect(screen.getByText(/受取 \d/)).toHaveClass('bg-amber-100', 'text-amber-700');
      act(() => void vi.advanceTimersByTime(30_000));
      expect(screen.getByText(/受取 \d/)).toHaveClass('bg-red-100', 'text-red-700');
    } finally {
      vi.useRealTimers();
    }
  });

  it('厨房: 注文単位「調理済み」→ kitchenDone op を発火', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: '調理済み' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'kitchenDone', value: true } });
  });

  it('ホール: 注文単位「配膳済み」→ fulfill op を発火 (配膳済み=対応済み)', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    fireEvent.click(screen.getByRole('button', { name: '配膳済み' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'fulfill', value: true } });
  });

  it('厨房: kitchenDone 済みは active から消え「調理済み」折りたたみへ + 未調理に戻す', () => {
    feedHold.data = [order({ kitchenDone: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByText('未完了の受注はありません。')).toBeInTheDocument(); // active 空
    expect(screen.getByText(/調理済み \(1\)/)).toBeInTheDocument(); // 折りたたみセクション
    const doneCard = screen.getByText(/受注番号 #A1/).closest('li');
    expect(doneCard).toHaveClass('border-slate-200', 'bg-white', 'opacity-70');
    expect(doneCard).not.toHaveClass('bg-red-50/60', 'bg-amber-50/70');
    fireEvent.click(screen.getByRole('button', { name: '未調理に戻す' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'kitchenDone', value: false } });
  });

  it('ホール: fulfilled (配膳済み) は active から消え「配膳済み」折りたたみへ + 未配膳に戻す', () => {
    feedHold.data = [order({ fulfilled: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText('未完了の受注はありません。')).toBeInTheDocument(); // active 空
    expect(screen.getByText(/配膳済み \(1\)/)).toBeInTheDocument(); // 折りたたみセクション
    fireEvent.click(screen.getByRole('button', { name: '未配膳に戻す' }));
    expect(mutateSpy).toHaveBeenCalledWith({ txHash: TX, op: { kind: 'fulfill', value: false } });
  });

  it('厨房: fulfilled (ホール配膳済み=対応済み) は厨房から完全に消える', () => {
    feedHold.data = [order({ fulfilled: true, kitchenDone: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    // 厨房は !fulfilled のみ対象 → 対応済みは active にも折りたたみにも出ない (受注で確定済み)。
    expect(screen.getByText('未対応の受注はありません。')).toBeInTheDocument();
    expect(screen.queryByText(/牛丼/)).toBeNull();
  });

  it('独立性: kitchenDone 済みでも ホール配膳では active のまま (調理済み≠対応済み)', () => {
    feedHold.data = [order({ kitchenDone: true })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByRole('button', { name: /牛丼/ })).toBeInTheDocument(); // active カード
    expect(screen.queryByText('未完了の受注はありません。')).toBeNull();
  });

  it('ホール: 全品 調理済み (cooked) なら「配膳準備OK」バッジを表示', () => {
    feedHold.data = [order({ items: [{ name: '牛丼', qty: 1, price: '500', cooked: true }] })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText('配膳準備OK')).toBeInTheDocument();
  });

  it('ホール: 一部未調理なら「配膳準備OK」バッジは出さない', () => {
    feedHold.data = [
      order({
        items: [
          { name: '牛丼', qty: 1, price: '500', cooked: true },
          { name: '味噌汁', qty: 1, price: '100' },
        ],
      }),
    ];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByText('配膳準備OK')).toBeNull();
  });

  it('ホール: 明細が空なら「配膳準備OK」は出さない (every() の空配列 true を items.length>0 で防ぐ)', () => {
    feedHold.data = [order({ items: [] })];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByText('配膳準備OK')).toBeNull();
  });

  // ── UX-4: ヘッダ KPI 件数 ───────────────────────────────────────────────
  it('ヘッダ KPI: 厨房は「調理待ち N」を表示 (active 件数)', () => {
    feedHold.data = [order({ orderId: 'A1', txHash: TX }), order({ orderId: 'A2', txHash: TX2 })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByText('調理待ち 2')).toBeInTheDocument();
  });
  it('ヘッダ KPI: ホールは「配膳待ち N」を表示', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.getByText('配膳待ち 1')).toBeInTheDocument();
  });

  it('厨房: active 注文の未調理品を合算したストリップを表示', () => {
    feedHold.data = [
      order({
        orderId: 'A1',
        txHash: TX,
        items: [
          { name: '牛丼', qty: 2, price: '500' },
          { name: '味噌汁', qty: 4, price: '100', cooked: true },
        ],
      }),
      order({
        orderId: 'A2',
        txHash: TX2,
        items: [
          { name: '牛丼', qty: 3, price: '500' },
          { name: 'プリン', qty: 1, price: '200' },
        ],
      }),
    ];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    const strip = screen.getByText('未調理の合計').parentElement;
    expect(strip).toHaveTextContent('牛丼 ×5');
    expect(strip).toHaveTextContent('プリン ×1');
    expect(strip).not.toHaveTextContent('味噌汁 ×4');
  });

  // ── UX-2: 経過時間バッジ ────────────────────────────────────────────────
  it('経過時間: 受信から約15分なら「15分経過」を表示', () => {
    feedHold.data = [order({ ts: Date.now() - (15 * 60_000 + 5_000) })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    const card = screen.getByText('15分経過').closest('li');
    expect(card).toHaveClass('border-amber-400', 'bg-amber-50/70');
  });
  it('経過時間: 受信から約25分ならカード面を赤くする', () => {
    feedHold.data = [order({ ts: Date.now() - (25 * 60_000 + 5_000) })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    const card = screen.getByText('25分経過').closest('li');
    expect(card).toHaveClass('border-red-400', 'bg-red-50/60');
  });
  it('経過時間: ts 不明 (0) はバッジを出さない', () => {
    feedHold.data = [order({ ts: 0 })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByText(/分経過/)).toBeNull();
  });

  // ── UX-3: ホールで配膳準備OK を先頭に ─────────────────────────────────────
  it('ホール: 全品調理済み (配膳準備OK) の注文を先頭にソート', () => {
    feedHold.data = [
      order({ orderId: 'PLAIN2', txHash: TX, items: [{ name: '牛丼', qty: 1, price: '500' }] }),
      order({
        orderId: 'READY1',
        txHash: TX2,
        items: [{ name: '牛丼', qty: 1, price: '500', cooked: true }],
      }),
    ];
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    const cards = screen.getAllByText(/受注番号/);
    expect(cards[0].textContent).toContain('READY1'); // 配膳準備OK が先頭
    expect(cards[1].textContent).toContain('PLAIN2');
  });

  // ── P2-7: 厨房の受取締切順 ────────────────────────────────────────────────
  it('厨房: flag OFF は pickupAt があっても受信順と note 非表示を維持 (inert 回帰フェンス)', () => {
    feedHold.data = [
      order({ orderId: 'FIRST', txHash: TX, pickupAt: 2_000_000_000_000 }),
      order({ orderId: 'SECOND', txHash: TX2, pickupAt: 1_900_000_000_000 }),
    ];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    const cards = screen.getAllByText(/受注番号/);
    expect(cards[0]).toHaveTextContent('FIRST');
    expect(cards[1]).toHaveTextContent('SECOND');
    expect(screen.queryByText('受取時刻順に並んでいます')).toBeNull();
  });

  it('厨房: flag ON でも active に pickupAt が無ければ受信順と note 非表示を維持', () => {
    envHold.enablePreorderTime = true;
    feedHold.data = [
      order({ orderId: 'FIRST', txHash: TX, ts: 2_000_000_000_000 }),
      order({ orderId: 'SECOND', txHash: TX2, ts: 1_900_000_000_000 }),
    ];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    const cards = screen.getAllByText(/受注番号/);
    expect(cards[0]).toHaveTextContent('FIRST');
    expect(cards[1]).toHaveTextContent('SECOND');
    expect(screen.queryByText('受取時刻順に並んでいます')).toBeNull();
  });

  it('厨房: flag ON + pickupAt ありなら締切キー順、同キーは ts 昇順にし note を表示', () => {
    envHold.enablePreorderTime = true;
    const sharedPickupAt = 2_000_000_000_000;
    feedHold.data = [
      order({
        orderId: 'SAME-LATE-TS',
        txHash: TX,
        ts: 1_800_000_200_000,
        pickupAt: sharedPickupAt,
      }),
      order({
        orderId: 'EARLIEST',
        txHash: TX2,
        ts: 1_800_000_300_000,
        pickupAt: 1_900_000_000_000,
      }),
      order({
        orderId: 'SAME-EARLY-TS',
        txHash: `0x${'c'.repeat(64)}`,
        ts: 1_800_000_100_000,
        pickupAt: sharedPickupAt,
      }),
    ];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    const cards = screen.getAllByText(/受注番号/);
    expect(cards[0]).toHaveTextContent('EARLIEST');
    expect(cards[1]).toHaveTextContent('SAME-EARLY-TS');
    expect(cards[2]).toHaveTextContent('SAME-LATE-TS');
    expect(screen.getByText('受取時刻順に並んでいます')).toHaveClass('text-xs');
  });

  // ── UX-1: 新着アラート (音トグル + 点滅) ──────────────────────────────────
  it('通知音トグル: ON で設定保存 + AudioContext 解錠 + テスト音', () => {
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: /通知音/ }));
    expect(soundHold.set).toHaveBeenCalledWith(true);
    expect(chime.prime).toHaveBeenCalled(); // user gesture 中に解錠
    expect(chime.play).toHaveBeenCalled(); // 有効化の確認音
  });

  it('新着注文: 初回ロード分は鳴らさず、後続の新 txHash で「新着」+ 音 (音ON時)', () => {
    soundHold.enabled = true; // mount 時に音 ON
    feedHold.data = [order({ orderId: 'A1', txHash: TX })];
    const { rerender } = renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByText('新着')).toBeNull(); // 初回は新着扱いしない
    chime.play.mockClear();
    // 新しい注文がポーリングで届く (新しい配列参照で effect 再走)。
    feedHold.data = [order({ orderId: 'A1', txHash: TX }), order({ orderId: 'A2', txHash: TX2 })];
    rerender(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByText('新着')).toBeInTheDocument();
    expect(chime.play).toHaveBeenCalled();
  });

  it('新着注文: 音 OFF なら点滅のみで音は鳴らさない', () => {
    soundHold.enabled = false;
    feedHold.data = [order({ orderId: 'A1', txHash: TX })];
    const { rerender } = renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    chime.play.mockClear();
    feedHold.data = [order({ orderId: 'A1', txHash: TX }), order({ orderId: 'A2', txHash: TX2 })];
    rerender(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByText('新着')).toBeInTheDocument(); // 点滅は出る
    expect(chime.play).not.toHaveBeenCalled(); // 音は鳴らない
  });

  it('新着注文: 遅延済みでも点滅・amber ring をカード面の遅延色より優先', () => {
    const oldTs = Date.now() - 25 * 60_000;
    feedHold.data = [order({ orderId: 'A1', txHash: TX, ts: oldTs })];
    const { rerender } = renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    feedHold.data = [
      order({ orderId: 'A1', txHash: TX, ts: oldTs }),
      order({ orderId: 'A2', txHash: TX2, ts: oldTs }),
    ];
    rerender(<OrderFulfillmentBoard mode="kitchen" />);
    const newCard = screen.getByText(/受注番号 #A2/).closest('li');
    expect(newCard).toHaveClass('animate-pulse', 'border-amber-400', 'bg-white', 'ring-2');
    expect(newCard).not.toHaveClass('bg-red-50/60');
  });

  // ── LARP-2: 永続ON復元時の prime-on-first-gesture (Codex P2 修正の実証) ──────
  it('音 ON 復元時: 最初の pointerdown で AudioContext を一度だけ解錠 (永続ONでも鳴る経路)', () => {
    soundHold.enabled = true; // 永続値 ON で復元 (トグル操作なし → この時点では prime されない)
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(chime.prime).not.toHaveBeenCalled(); // gesture 前は未解錠
    act(() => void window.dispatchEvent(new Event('pointerdown')));
    expect(chime.prime).toHaveBeenCalledTimes(1); // 最初のタップで解錠
    act(() => void window.dispatchEvent(new Event('pointerdown')));
    expect(chime.prime).toHaveBeenCalledTimes(1); // once = 二度目以降は張り直さない
  });

  it('音 OFF のときは pointerdown で解錠しない (リスナを張らない)', () => {
    soundHold.enabled = false;
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    act(() => void window.dispatchEvent(new Event('pointerdown')));
    expect(chime.prime).not.toHaveBeenCalled();
  });

  // ── LARP-3: 検出の不変条件 (誤アラートしない) ─────────────────────────────
  it('状態更新 (同一 txHash) では再アラートしない (txHash 安定が根拠)', () => {
    soundHold.enabled = true;
    feedHold.data = [order({ orderId: 'A1', txHash: TX })];
    const { rerender } = renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    chime.play.mockClear();
    // 同一 txHash のまま kitchenDone を立てる (= 店主操作の状態更新)。新着でも音でもない。
    feedHold.data = [order({ orderId: 'A1', txHash: TX, kitchenDone: true })];
    rerender(<OrderFulfillmentBoard mode="kitchen" />);
    expect(chime.play).not.toHaveBeenCalled();
    expect(screen.queryByText('新着')).toBeNull();
  });

  it('wallet 変更: 別店舗の既存注文を新着扱いしない (sessionAddress 変更で検出リセット)', () => {
    soundHold.enabled = true;
    siwe.sessionAddress = '0xaaa0000000000000000000000000000000000000';
    feedHold.data = [order({ orderId: 'A1', txHash: TX })];
    const { rerender } = renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    chime.play.mockClear();
    // 別 wallet に切替 + その wallet の既存注文 (別 txHash) が表示される。
    siwe.sessionAddress = '0xbbb0000000000000000000000000000000000000';
    feedHold.data = [order({ orderId: 'B2', txHash: TX2 })];
    rerender(<OrderFulfillmentBoard mode="kitchen" />);
    expect(chime.play).not.toHaveBeenCalled(); // 切替直後の初期スナップショットは鳴らさない
    expect(screen.queryByText('新着')).toBeNull();
  });

  // ── LARP-4: タイマー経路を fake timers で実発火 ───────────────────────────
  it('新着バッジは FLASH_MS 経過で自動消灯する (setTimeout 経路)', () => {
    vi.useFakeTimers();
    try {
      feedHold.data = [order({ orderId: 'A1', txHash: TX })];
      const { rerender } = renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
      feedHold.data = [order({ orderId: 'A1', txHash: TX }), order({ orderId: 'A2', txHash: TX2 })];
      act(() => rerender(<OrderFulfillmentBoard mode="kitchen" />));
      expect(screen.getByText('新着')).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(6_000)); // FLASH_MS
      expect(screen.queryByText('新着')).toBeNull(); // 自動消灯
    } finally {
      vi.useRealTimers();
    }
  });

  it('経過時間は 30s tick で更新される (setInterval 経路・10分跨ぎ)', () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      // 受信から 9分30秒 → マウント時は「9分経過」。
      feedHold.data = [order({ orderId: 'A1', txHash: TX, ts: t0 - (9 * 60_000 + 30_000) })];
      renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
      expect(screen.getByText('9分経過')).toBeInTheDocument();
      // 60s 進める → interval が now を更新 → 10分30秒 → 「10分経過」。
      act(() => void vi.advanceTimersByTime(60_000));
      expect(screen.getByText('10分経過')).toBeInTheDocument();
      expect(screen.queryByText('9分経過')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── OT-5: token モード (店員端末・資金鍵なし) ─────────────────────────────
  it('token モード: enableOrderToken + initialToken なら SIWE 無し (未サインイン) でも board 描画', () => {
    envHold.enableOrderToken = true;
    siwe.isSignedIn = false; // 店員端末はウォレット未接続
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" initialToken={'a'.repeat(43)} />);
    // サインインを促さず受注 (牛丼) を表示。
    expect(screen.queryByRole('button', { name: 'サインイン' })).toBeNull();
    expect(screen.getByRole('button', { name: /牛丼/ })).toBeInTheDocument();
    expect(tokenHold.stored).toBe('a'.repeat(43)); // localStorage に保持
  });

  it('token モード: ?t= 取り込み後に URL からトークンを除去 (露出低減・localStorage で継続)', () => {
    envHold.enableOrderToken = true;
    siwe.isSignedIn = false;
    window.history.replaceState(null, '', `/ja/orders/kitchen?t=${'a'.repeat(43)}`);
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" initialToken={'a'.repeat(43)} />);
    expect(window.location.search).not.toContain('t='); // URL から除去された
    expect(tokenHold.stored).toBe('a'.repeat(43)); // localStorage には保持 (再読込でも機能継続)
    expect(screen.getByRole('button', { name: /牛丼/ })).toBeInTheDocument(); // 受注は表示されたまま
  });

  it('token モード: 保存済みトークンを ?t= 無しでも復元 (再訪)', () => {
    envHold.enableOrderToken = true;
    siwe.isSignedIn = false;
    tokenHold.stored = 'b'.repeat(43); // 前回保存
    renderWithIntl(<OrderFulfillmentBoard mode="hall" />);
    expect(screen.queryByRole('button', { name: 'サインイン' })).toBeNull();
    expect(screen.getByRole('button', { name: /牛丼/ })).toBeInTheDocument();
  });

  it('enableOrderToken OFF: initialToken があっても token 無視 → 未サインインはサインイン要求', () => {
    envHold.enableOrderToken = false;
    siwe.isSignedIn = false;
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" initialToken={'a'.repeat(43)} />);
    expect(screen.getByRole('button', { name: 'サインイン' })).toBeInTheDocument(); // token 無効 → SIWE 専用
  });

  it('token モード: 未サインインの店員端末でも新着アラート (点滅) が出る', () => {
    envHold.enableOrderToken = true;
    siwe.isSignedIn = false; // 店員端末 (ウォレット未接続)
    feedHold.data = [order({ orderId: 'A1', txHash: TX })];
    const { rerender } = renderWithIntl(<OrderFulfillmentBoard mode="kitchen" initialToken={'a'.repeat(43)} />);
    expect(screen.queryByText('新着')).toBeNull(); // 初回スナップショットは新着扱いしない
    feedHold.data = [order({ orderId: 'A1', txHash: TX }), order({ orderId: 'A2', txHash: TX2 })];
    act(() => rerender(<OrderFulfillmentBoard mode="kitchen" initialToken={'a'.repeat(43)} />));
    expect(screen.getByText('新着')).toBeInTheDocument(); // token モードでも検出が動く
  });

  it('サインイン済みは保存トークンより SIWE を優先 (別店舗トークンの取り違え防止)', () => {
    envHold.enableOrderToken = true;
    siwe.isSignedIn = true; // オーナーがサインイン済み
    tokenHold.stored = 'c'.repeat(43); // 端末に別トークンが残っている
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(feedHold.lastTokenArg).toBeNull(); // token は使わず SIWE で読む
    expect(screen.getByRole('button', { name: /牛丼/ })).toBeInTheDocument();
  });

  it('サインイン済み + 保存トークンあり: token state 読込で新着検出が初期化されず取りこぼさない', () => {
    // signed-in 中に localStorage の別トークンが token state に載っても、検出主体は受取アドレスのまま
    // (feedSubject)。token 載りで initRef がリセットされ次の新着を初回扱いで握り潰す回帰のガード。
    envHold.enableOrderToken = true;
    siwe.isSignedIn = true;
    tokenHold.stored = 'c'.repeat(43);
    feedHold.data = [order({ orderId: 'A1', txHash: TX })];
    const { rerender } = renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.queryByText('新着')).toBeNull(); // 初回スナップショット
    feedHold.data = [order({ orderId: 'A1', txHash: TX }), order({ orderId: 'A2', txHash: TX2 })];
    act(() => rerender(<OrderFulfillmentBoard mode="kitchen" />));
    expect(screen.getByText('新着')).toBeInTheDocument(); // signed-in でも新着を検出する
  });

  it('失効トークン: feed が 401 invalid_token → 保存を破棄して token モードを抜ける', () => {
    envHold.enableOrderToken = true;
    siwe.isSignedIn = false;
    tokenHold.stored = 'd'.repeat(43);
    feedHold.isError = true;
    feedHold.error = new Error('invalid_token');
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(tokenHold.stored).toBeNull(); // localStorage の失効トークンを破棄
    expect(screen.getByRole('button', { name: 'サインイン' })).toBeInTheDocument(); // SIWE 要求へ
  });

  it('KV 障害 (401 以外) では保存トークンを消さない (再試行で復帰)', () => {
    envHold.enableOrderToken = true;
    siwe.isSignedIn = false;
    tokenHold.stored = 'e'.repeat(43);
    feedHold.isError = true;
    feedHold.error = new Error('kv_error'); // 一時障害
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(tokenHold.stored).toBe('e'.repeat(43)); // 保持 (失効ではない)
  });
});
