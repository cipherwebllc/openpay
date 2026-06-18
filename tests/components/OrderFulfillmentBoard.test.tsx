// 受注フルフィルメントボード (厨房/ホール) を実描画で検証。useSiweSession / useOrderFeed は mock
// (react-query/fetch を介さず、描画 + op 発火を直接検証)。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import type { StoredOrder } from '@/lib/orderRelay';

const envHold = vi.hoisted(() => ({ enablePreorderTime: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enablePreorderTime() {
        return envHold.enablePreorderTime;
      },
    },
  };
});

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
const feedHold = vi.hoisted(() => ({ data: [] as StoredOrder[] }));
vi.mock('@/hooks/useOrderFeed', () => ({
  useOrderFeed: () => ({
    feed: { data: feedHold.data, isError: false, isLoading: false, refetch: vi.fn() },
    update: { mutate: mutateSpy, isPending: false },
  }),
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
  mutateSpy.mockClear();
  envHold.enablePreorderTime = false; // Phase 4 flag 既定 OFF
  soundHold.enabled = false; // 新着アラート音 既定 OFF
  soundHold.set.mockClear();
  chime.play.mockClear();
  chime.prime.mockClear();
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

  // ── UX-2: 経過時間バッジ ────────────────────────────────────────────────
  it('経過時間: 受信から約15分なら「15分経過」を表示', () => {
    feedHold.data = [order({ ts: Date.now() - (15 * 60_000 + 5_000) })];
    renderWithIntl(<OrderFulfillmentBoard mode="kitchen" />);
    expect(screen.getByText('15分経過')).toBeInTheDocument();
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
});
