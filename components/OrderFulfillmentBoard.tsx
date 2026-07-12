'use client';

// 受注フルフィルメントの全画面ボード (Phase 3)。mode で 厨房 (調理) / ホール (配膳) を切替。
// - 厨房: 商品別「調理済み」トグル + 注文「調理済み」(中間 kitchenDone・厨房側だけ折りたたむ)。
// - ホール: 調理済み品は **青** (配膳待ちが一目) + 商品別「配膳済み」トグル + 注文「配膳済み」
//   (= fulfilled = 対応済み。受注ページからも消える)。全品調理済みは「配膳準備OK」で先頭に並ぶ。
// 稼働 UX: 新着アラート (音/点滅)・経過時間バッジ・未完了件数 KPI。
// 受取ウォレットで SIWE サインイン → useOrderFeed (8s ポーリング・状態更新は op POST + kvEval 原子)。
// ルート (app/[locale]/orders/{kitchen,hall}) が env.enableOrderFulfillment でゲートしてマウントする。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, BellOff, RefreshCw } from 'lucide-react';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useOrderFeed } from '@/hooks/useOrderFeed';
import { useNewOrderFlash } from '@/hooks/useNewOrderFlash';
import { OrderCard } from '@/components/OrderCard';
import { isOrderAlertSoundEnabled, setOrderAlertSoundEnabled } from '@/lib/soundPref';
import { primeChimeAudio, playNewOrderChime } from '@/lib/successChime';
import { getStoredOrderToken, setStoredOrderToken, clearStoredOrderToken } from '@/lib/orderTokenClient';
import { type StoredOrder, uncookedItemTotals } from '@/lib/orderRelay';

// 受注カードのレスポンシブグリッド (active / 折りたたみ done で共有 = 列数を一致させる)。
const CARD_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3';

export function OrderFulfillmentBoard({
  mode,
  initialToken,
}: {
  mode: 'kitchen' | 'hall';
  initialToken?: string;
}) {
  const t = useTranslations('OrderFulfillment');
  const { isSignedIn, sessionAddress, signIn, isSigningIn, signInError } = useSiweSession();
  // 受注閲覧トークン (店員端末・enableOrderToken 時のみ)。?t= を一度開けば localStorage に保持し、
  // 以降は SIWE 無し (資金鍵不要) で受注を閲覧/操作できる。
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!env.enableOrderToken) return;
    if (initialToken) {
      setStoredOrderToken(initialToken);
      setToken(initialToken);
      // 取り込んだら URL から ?t= を除去 (履歴/スクショ/肩越しでのトークン露出を減らす)。localStorage に
      // 保持済みなので再読込・再訪でも機能継続。sandboxed iframe 等で history 不可なら無視 (機能影響なし)。
      // 取り込んだら URL から ?t= を除去 (履歴/スクショ/肩越しでのトークン露出を減らす)。localStorage に
      // 保持済みなので再読込・再訪でも機能継続。sandboxed iframe 等で history 不可なら無視 (機能影響なし)。
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('t')) {
          url.searchParams.delete('t');
          window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        }
      } catch {
        /* history/URL API 不可環境はそのまま (トークンは localStorage で機能継続) */
      }
    } else {
      setToken(getStoredOrderToken());
    }
  }, [initialToken]);
  // token モード = 店員端末 (未サインイン)。**サインイン済みなら SIWE を優先**: 別店舗の保存トークンが
  // 残っていても、署名済みオーナーは常に自分の受取アドレスの受注を見る (取り違え防止)。
  const tokenMode = env.enableOrderToken && Boolean(token) && !isSignedIn;
  // 稼働画面なので少し短めの 8s ポーリング。token があれば SIWE 不要でそのトークンの受注を読む。
  const { feed, update } = useOrderFeed(sessionAddress, isSignedIn, 8_000, tokenMode ? token : null);
  // 失効トークン (rotate/revoke 済み) は feed が 401 invalid_token を返す → 保存を破棄し token モードを
  // 抜ける (サインイン要求へ)。失効リンクで 401 を繰り返さない。KV 障害 (503) では消さない (再試行で復帰)。
  useEffect(() => {
    if (!tokenMode) return;
    if (feed.isError && feed.error instanceof Error && feed.error.message === 'invalid_token') {
      clearStoredOrderToken();
      setToken(null);
    }
  }, [tokenMode, feed.isError, feed.error]);
  // テーブル訂正 (setTable op)。編集中の注文 txHash + 入力ドラフト。
  const [editTx, setEditTx] = useState<string | null>(null);
  const [tableDraft, setTableDraft] = useState('');

  // 経過時間バッジ用の現在時刻 (30s tick・分単位表示なので粗くて十分)。
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // 新着注文アラート音 (既定 OFF・明示オプトイン)。mount 後に永続値を反映 (hydration mismatch 回避)。
  const [soundOn, setSoundOn] = useState(false);
  useEffect(() => setSoundOn(isOrderAlertSoundEnabled()), []);
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;
  // トグル: 副作用 (永続化・AudioContext 解錠・テスト音) は **click ハンドラ本体で同期実行**。
  // setState updater 内だと React が gesture の同期スタック外で再実行しうる (StrictMode 二重・自動再生
  // ポリシーで解錠が無効) ため。
  const toggleSound = useCallback(() => {
    const next = !soundOnRef.current;
    setOrderAlertSoundEnabled(next);
    if (next) {
      primeChimeAudio(); // user gesture 中に解錠
      playNewOrderChime(); // 有効化を音で確認
    }
    setSoundOn(next);
  }, []);
  // 永続値で soundOn を復元したページは AudioContext が未解錠 (gesture 無し) → モバイルで
  // 「ON 表示なのに鳴らない」を避けるため、ON のときは最初の任意タップで一度だけ解錠する。
  useEffect(() => {
    if (!soundOn) return; // useEffect は client のみ → window 存在は自明 (prime も内部でガード)
    const prime = () => primeChimeAudio();
    window.addEventListener('pointerdown', prime, { once: true });
    return () => window.removeEventListener('pointerdown', prime);
  }, [soundOn]);

  // 新着注文の点滅記帳は useNewOrderFlash に委譲 (初回スナップショットは鳴らさず seen に積む・以降の
  // 新 txHash を点滅・タイマー掃除・主体変化での初期化)。音/チャイムは **ここに残す**: 新着検出時に
  // onNewOrders 経由で soundOnRef の最新トグル状態を見て鳴らす。
  // 検出主体 = feed のスコープ (token モードなら token・それ以外は受取アドレス)。signed-in 中は token を
  // 主体にしない: 署名済み端末に別店舗トークンが残り token state が載っても、それで検出をリセットすると
  // signed-in の次の新着を初回スナップショット扱いで取りこぼす (feed 自体は sessionAddress を読んでいる)。
  const feedSubject = tokenMode ? token : sessionAddress;
  // feed が有効 (SIWE サインイン or token モード) かつ成功スナップショットのみ検出対象。token モードの
  // 店員端末でも新着アラートが要る (= isSignedIn だけで絞らない)。無効/ロード中/エラーでは seed もしない。
  const flashing = useNewOrderFlash(
    (feed.data ?? []).map((o) => o.txHash),
    feedSubject,
    {
      enabled: (isSignedIn || tokenMode) && !feed.isLoading && !feed.isError,
      onNewOrders: () => {
        if (soundOnRef.current) playNewOrderChime();
      },
    },
  );

  // active/done の分け方は mode で異なる:
  //  - 厨房: 「調理済み」(kitchenDone) は **中間**。fulfilled 済みは除外し、kitchenDone で折りたたむ
  //    (調理済みでもオーダーは未対応のまま = ホールが配膳するまで残る)。
  //  - ホール: 「配膳済み」= **対応済み (fulfilled)**。全件を対象に fulfilled で active/done を分ける
  //    (配膳=客に提供=取引完了。受注ページの対応済みと同一・受注からも消える)。
  const all = feed.data ?? [];
  const orders = mode === 'kitchen' ? all.filter((o) => !o.fulfilled) : all;
  const isStationDone = (o: StoredOrder) =>
    mode === 'kitchen' ? o.kitchenDone === true : o.fulfilled;
  const activeOrders = orders.filter((o) => !isStationDone(o));
  const doneOrders = orders.filter((o) => isStationDone(o));
  const uncookedTotals = mode === 'kitchen' ? uncookedItemTotals(activeOrders) : [];

  // ホールの「配膳準備OK」= 全品 調理済み (厨房完了)。バッジ + 並べ替えの両方で使う。
  const allCooked = (o: StoredOrder): boolean =>
    o.items.length > 0 && o.items.every((it) => it.cooked === true);
  // ホールは **配膳準備OK を先頭**へ (いま出せる注文を上に)・同群は受信が古い順 (FIFO)。
  // ts 不明 (0) は最後に回す (sentinel を最古扱いして先頭に来るのを防ぐ)。厨房は受信順のまま。
  const tsKey = (o: StoredOrder): number => (o.ts > 0 ? o.ts : Number.MAX_SAFE_INTEGER);
  const sortedActive =
    mode === 'hall'
      ? [...activeOrders].sort(
          (a, b) => Number(allCooked(b)) - Number(allCooked(a)) || tsKey(a) - tsKey(b),
        )
      : activeOrders;

  // 受信からの経過分 (ts 不明=0 は null)。色しきい値で遅れを可視化。
  const elapsedMin = (o: StoredOrder): number | null =>
    o.ts > 0 ? Math.max(0, Math.floor((now - o.ts) / 60_000)) : null;

  const toggleItem = (o: StoredOrder, index: number, on: boolean) =>
    update.mutate({
      txHash: o.txHash,
      op:
        mode === 'kitchen'
          ? { kind: 'itemCooked', index, value: !on }
          : { kind: 'itemServed', index, value: !on },
    });
  // 注文単位の完了。厨房=「調理済み」(中間 kitchenDone)・ホール=「配膳済み」= 対応済み (fulfill)。
  // クリックで done 化し折りたたみへ・戻すで復帰。
  const setStationDone = (o: StoredOrder, value: boolean) =>
    update.mutate({
      txHash: o.txHash,
      op: mode === 'kitchen' ? { kind: 'kitchenDone', value } : { kind: 'fulfill', value },
    });
  // お渡し準備完了通知 (ホール・flag ENABLE_ORDER_PICKUP)。顧客の /order/status が次のポーリングで
  // 'ready' を検知しチャイム + 「お渡しする準備ができました」を表示する。
  const markReady = (o: StoredOrder, value: boolean) =>
    update.mutate({ txHash: o.txHash, op: { kind: 'markReady', value } });
  const doneSectionLabel = mode === 'kitchen' ? t('cookedSection') : t('servedSection');

  // 受注カード。inDone=true は折りたたみ「調理済み/配膳済み」セクション側 (淡色・ボタンは「戻す」)。
  // 表示は OrderCard に委譲し、ここでは now/flashing/編集状態に依存する派生プロップだけ算出する
  // (OrderCard は memo され raw now では再レンダーしない — ageMin など算出済みの値だけ渡す)。
  const renderCard = (o: StoredOrder, inDone: boolean) => {
    // お渡し準備完了通知 (flag ENABLE_ORDER_PICKUP・ホールのみ)。ready 前は「準備完了(通知)」ボタン、
    // ready 後 (active) は「通知済み・受取待ち」バッジ + 既存「受け渡し済」へ進む 2 段階。
    const hallReady = mode === 'hall' && env.enableOrderPickup && o.ready === true;
    const showMarkReady = mode === 'hall' && env.enableOrderPickup && !inDone && !o.ready;
    return (
      <OrderCard
        key={o.txHash}
        order={o}
        mode={mode}
        inDone={inDone}
        isNew={!inDone && flashing.has(o.txHash)} // 新着 (点滅) — 折りたたみ側は対象外
        ageMin={elapsedMin(o)} // 受信からの経過分 (null=不明)
        hallReady={hallReady}
        showMarkReady={showMarkReady}
        readyToServe={allCooked(o)} // 全品 調理済み (= 配膳準備OK・ホール)
        isPending={update.isPending}
        isEditingTable={editTx === o.txHash}
        tableDraft={tableDraft}
        onToggleItem={(index, on) => toggleItem(o, index, on)}
        onSetStationDone={(value) => setStationDone(o, value)}
        onMarkReady={(value) => markReady(o, value)}
        onStartEditTable={() => {
          setEditTx(o.txHash);
          setTableDraft(o.table ?? '');
        }}
        onTableDraftChange={setTableDraft}
        onSaveTable={() => {
          update.mutate({
            txHash: o.txHash,
            op: { kind: 'setTable', table: tableDraft.trim() || null },
          });
          setEditTx(null);
        }}
        onCancelEditTable={() => setEditTx(null)}
      />
    );
  };

  // token モード (店員端末) は SIWE 不要。それ以外は受取ウォレットのサインインを促す。
  if (!tokenMode && !isSignedIn) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
        <p className="text-sm text-slate-600">{t('signInPrompt')}</p>
        <button
          type="button"
          onClick={() => void signIn(t('signInStatement')).catch(() => {})}
          disabled={isSigningIn}
          className="mt-3 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
        >
          {isSigningIn ? t('signingIn') : t('signIn')}
        </button>
        {signInError && <p className="mt-2 text-xs text-red-600">{t('signInError')}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-slate-900">
            {mode === 'kitchen' ? t('kitchenTitle') : t('hallTitle')}
          </h1>
          {/* ヘッダ KPI: 未完了件数 (厨房=調理待ち / ホール=配膳待ち)。0 件は出さない。 */}
          {activeOrders.length > 0 && (
            <span className="rounded-full bg-brand/10 px-2.5 py-0.5 text-sm font-bold text-brand">
              {mode === 'kitchen'
                ? t('pendingCountKitchen', { n: activeOrders.length })
                : t('pendingCountHall', { n: activeOrders.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* 新着注文の音アラート ON/OFF (既定 OFF・ON の瞬間にブラウザ自動再生を解錠)。 */}
          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={soundOn}
            className={`flex items-center gap-1 text-xs font-medium ${
              soundOn ? 'text-brand' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            {soundOn ? (
              <Bell className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <BellOff className="h-3.5 w-3.5" aria-hidden />
            )}
            {soundOn ? t('alertSoundOn') : t('alertSoundOff')}
          </button>
          <button
            type="button"
            onClick={() => feed.refetch()}
            className="flex items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t('refresh')}
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-400">{t('autoRefresh')}</p>
      {/* 状態更新 (op POST) の失敗 (409 競合枯渇 / KV / ネットワーク) を黙殺せず告知。 */}
      {update.isError && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {t('updateError')}
        </p>
      )}

      {feed.isError ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('loadError')}
        </p>
      ) : feed.isLoading ? (
        <p className="text-center text-sm text-slate-400">{t('loading')}</p>
      ) : orders.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-400">
          {t('empty')}
        </p>
      ) : (
        <>
          {mode === 'kitchen' && activeOrders.length > 0 && uncookedTotals.length > 0 ? (
            <div className="mb-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                {t('uncookedTotalsLabel')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {uncookedTotals.slice(0, 12).map((item) => (
                  <span
                    key={item.name}
                    className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700"
                  >
                    {item.name} ×{item.qty}
                  </span>
                ))}
                {uncookedTotals.length > 12 ? (
                  <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600">
                    +{uncookedTotals.length - 12}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {activeOrders.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-400">
              {t('allStationDone')}
            </p>
          ) : (
            <ul className={CARD_GRID}>{sortedActive.map((o) => renderCard(o, false))}</ul>
          )}
          {/* 調理済み/配膳済み: 削除でなく折りたたみで保持 (戻すで復帰)。受注ページの対応済みと同流儀。 */}
          {doneOrders.length > 0 && (
            <details className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-600">
                {doneSectionLabel} ({doneOrders.length})
              </summary>
              <ul className={`mt-3 ${CARD_GRID}`}>{doneOrders.map((o) => renderCard(o, true))}</ul>
            </details>
          )}
        </>
      )}
      <p className="text-[11px] text-slate-400">{t('claimedNote')}</p>
    </div>
  );
}
