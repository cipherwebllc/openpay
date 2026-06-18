'use client';

// 受注フルフィルメントの全画面ボード (Phase 3)。mode で 厨房 (調理) / ホール (配膳) を切替。
// - 厨房: 商品別「調理済み」トグル + 注文「対応済み」。
// - ホール: 調理済みは **青** (配膳待ちが一目で分かる) + 商品別「配膳済み」トグル + 注文「対応済み」。
// 受取ウォレットで SIWE サインイン → useOrderFeed (8s ポーリング・状態更新は op POST + kvEval 原子)。
// ルート (app/[locale]/orders/{kitchen,hall}) が env.enableOrderFulfillment でゲートしてマウントする。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { Bell, BellOff, CheckCircle2, Clock, RefreshCw, RotateCcw } from 'lucide-react';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useOrderFeed } from '@/hooks/useOrderFeed';
import { isJpycChainSlug, slugForChain } from '@/lib/chains';
import { JPYC_CHAIN_LABEL } from '@/lib/mobileOrder';
import { tokyoHHMM } from '@/lib/shopTime';
import { isOrderAlertSoundEnabled, setOrderAlertSoundEnabled } from '@/lib/soundPref';
import { primeChimeAudio, playNewOrderChime } from '@/lib/successChime';
import type { StoredOrder } from '@/lib/orderRelay';

const JPYC_DECIMALS = 18;
// 経過時間バッジの色しきい値 (分)。受信からの経過でホール/厨房が遅れを察知する。
const ELAPSED_WARN_MIN = 10; // これ以上で黄
const ELAPSED_LATE_MIN = 20; // これ以上で赤
const FLASH_MS = 6_000; // 新着カードの点滅持続

function chainLabel(chainId: number): string {
  const slug = slugForChain(chainId);
  return slug && isJpycChainSlug(slug) ? JPYC_CHAIN_LABEL[slug] : `chain ${chainId}`;
}

export function OrderFulfillmentBoard({ mode }: { mode: 'kitchen' | 'hall' }) {
  const t = useTranslations('OrderFulfillment');
  const { isSignedIn, sessionAddress, signIn, isSigningIn, signInError } = useSiweSession();
  // 稼働画面なので少し短めの 8s ポーリング。
  const { feed, update } = useOrderFeed(sessionAddress, isSignedIn, 8_000);
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
    if (!soundOn || typeof window === 'undefined') return;
    const prime = () => primeChimeAudio();
    window.addEventListener('pointerdown', prime, { once: true });
    return () => window.removeEventListener('pointerdown', prime);
  }, [soundOn]);

  // 新着検出: 初回スナップショットの注文は鳴らさず seen に積むだけ。以降の新 txHash を「新着」
  // として点滅 + (有効なら) 音。txHash は決済単位で安定 (調理済み等の状態更新では変わらない) ので
  // 状態トグルでは再アラートしない。seen は **毎回 現フィード全件 (done 含む)** で作り直す
  // = 対応済み⇄戻すの往復で誤アラートせず、かつ古い txHash を溜め込まない (メモリ上限=フィード件数)。
  const seenRef = useRef<Set<string>>(new Set());
  const initRef = useRef(false);
  const flashTimers = useRef<Set<number>>(new Set());
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  useEffect(() => () => flashTimers.current.forEach((id) => clearTimeout(id)), []);
  // 受取ウォレットが変わったら検出を初期化 (別店舗の既存注文を新着扱いしない)。
  useEffect(() => {
    seenRef.current = new Set();
    initRef.current = false;
    setFlashing(new Set());
  }, [sessionAddress]);
  const feedData = feed.data;
  const feedLoading = feed.isLoading;
  const feedError = feed.isError;
  useEffect(() => {
    // 認証済み + 成功スナップショットのみ対象。未サインイン/ロード中/エラー時は seed もしない
    // (disabled query は非ロードかつ data 無しになりうる → 空 seed → サインイン後に全件誤アラート)。
    if (!isSignedIn || feedLoading || feedError) return;
    const ids = (feedData ?? []).map((o) => o.txHash);
    const idSet = new Set(ids);
    if (!initRef.current) {
      seenRef.current = idSet; // 初回スナップショット = 既知 (鳴らさない)
      initRef.current = true;
      return;
    }
    const fresh = ids.filter((id) => !seenRef.current.has(id));
    seenRef.current = idSet; // 毎回作り直し = prune (古い txHash を溜めない)
    if (fresh.length === 0) return;
    setFlashing((prev) => {
      const nextSet = new Set(prev);
      fresh.forEach((id) => nextSet.add(id));
      return nextSet;
    });
    if (soundOnRef.current) playNewOrderChime();
    const timer = window.setTimeout(() => {
      flashTimers.current.delete(timer); // 発火済み id を破棄 (溜め込み防止)
      setFlashing((prev) => {
        const nextSet = new Set(prev);
        fresh.forEach((id) => nextSet.delete(id));
        return nextSet;
      });
    }, FLASH_MS);
    flashTimers.current.add(timer);
  }, [feedData, feedLoading, feedError, isSignedIn]);

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
  const doneBtnLabel = mode === 'kitchen' ? t('cookedDoneBtn') : t('servedDoneBtn');
  const undoBtnLabel = mode === 'kitchen' ? t('cookedUndo') : t('servedUndo');
  const doneSectionLabel = mode === 'kitchen' ? t('cookedSection') : t('servedSection');

  // 受注カード。inDone=true は折りたたみ「調理済み/配膳済み」セクション側 (淡色・ボタンは「戻す」)。
  const renderCard = (o: StoredOrder, inDone: boolean) => {
    const isNew = !inDone && flashing.has(o.txHash); // 新着 (点滅) — 折りたたみ側は対象外
    const ageMin = elapsedMin(o); // 受信からの経過分 (null=不明)
    return (
    <li
      key={o.txHash}
      className={`flex flex-col rounded-2xl border bg-white p-3 transition ${
        isNew ? 'animate-pulse border-amber-400 ring-2 ring-amber-300' : 'border-slate-200'
      } ${inDone ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-400">
            {t('orderNo')} #{o.orderId}
          </p>
          {/* テーブル表示/訂正は店内 (table あり) のみ。テイクアウト (table 空) は非表示。 */}
          {o.table ? (
            editTx === o.txHash ? (
              <div className="mt-0.5 flex items-center gap-1">
                <input
                  value={tableDraft}
                  onChange={(e) => setTableDraft(e.target.value.slice(0, 64))}
                  aria-label={t('tableLabel')}
                  className="w-24 rounded border border-slate-300 px-2 py-0.5 text-sm focus:border-brand focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    update.mutate({
                      txHash: o.txHash,
                      op: { kind: 'setTable', table: tableDraft.trim() || null },
                    });
                    setEditTx(null);
                  }}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  {t('tableSave')}
                </button>
                <button
                  type="button"
                  onClick={() => setEditTx(null)}
                  className="text-xs text-slate-400 hover:underline"
                >
                  {t('cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditTx(o.txHash);
                  setTableDraft(o.table ?? '');
                }}
                className="mt-0.5 flex items-center gap-1 text-left"
              >
                <span className="text-lg font-bold text-slate-900">{o.table}</span>
                <span className="text-[10px] text-slate-400">{t('tableEdit')}</span>
              </button>
            )
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {/* 新着 (ポーリングで届いた直後・点滅中)。 */}
          {isNew ? (
            <span className="rounded bg-amber-400 px-1.5 py-0.5 text-xs font-bold text-white">
              {t('newBadge')}
            </span>
          ) : null}
          {/* 受信からの経過時間。10分で黄・20分で赤 (遅れを察知)。折りたたみ側は出さない。 */}
          {!inDone && ageMin !== null && ageMin >= 1 ? (
            <span
              className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold ${
                ageMin >= ELAPSED_LATE_MIN
                  ? 'bg-red-100 text-red-700'
                  : ageMin >= ELAPSED_WARN_MIN
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-slate-100 text-slate-500'
              }`}
            >
              <Clock className="h-3 w-3" aria-hidden /> {t('elapsed', { m: ageMin })}
            </span>
          ) : null}
          {/* ホール: 全品 調理済み = 厨房完了 → 「配膳準備OK」(配膳待ちが一目で分かる)。 */}
          {mode === 'hall' && !inDone && allCooked(o) ? (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold text-emerald-700">
              {t('readyToServe')}
            </span>
          ) : null}
          <span className="text-xs text-slate-400">{chainLabel(o.chainId)}</span>
          {/* 受取予定時刻 (Phase 4・preorder のみ・flag ON かつ あるとき)。Asia/Tokyo HH:mm。 */}
          {env.enablePreorderTime && o.pickupAt ? (
            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-semibold text-sky-700">
              {t('pickupAt', { time: tokyoHHMM(o.pickupAt) })}
            </span>
          ) : null}
        </div>
      </div>

      <ul className="mt-2 flex-1 space-y-1">
        {o.items.length === 0 && <li className="text-sm text-slate-400">{t('noItems')}</li>}
        {o.items.map((it, i) => {
          const cooked = it.cooked === true;
          const served = it.served === true;
          const itemDone = mode === 'kitchen' ? cooked : served;
          // ホール: 調理済み (配膳待ち) は青で強調。配膳済みは done 表示。
          const cls =
            mode === 'hall'
              ? served
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 line-through'
                : cooked
                  ? 'border-sky-300 bg-sky-50 text-sky-700'
                  : 'border-slate-200 text-slate-400'
              : cooked
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 line-through'
                : 'border-slate-300 text-slate-700';
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => toggleItem(o, i, itemDone)}
                disabled={update.isPending}
                aria-pressed={itemDone}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${cls}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {it.name} × {it.qty}
                </span>
                {itemDone && <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-slate-400">
          {formatUnits(BigInt(o.amount), JPYC_DECIMALS)} JPYC
        </span>
        {/* 注文単位の完了/戻す。done 側は淡いセカンダリ、active 側は brand。 */}
        <button
          type="button"
          onClick={() => setStationDone(o, !inDone)}
          disabled={update.isPending}
          className={
            inDone
              ? 'flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand disabled:opacity-50'
              : 'flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-50'
          }
        >
          {inDone ? (
            <>
              <RotateCcw className="h-4 w-4" aria-hidden /> {undoBtnLabel}
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4" aria-hidden /> {doneBtnLabel}
            </>
          )}
        </button>
      </div>
    </li>
    );
  };

  if (!isSignedIn) {
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
          {activeOrders.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-400">
              {t('allStationDone')}
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sortedActive.map((o) => renderCard(o, false))}
            </ul>
          )}
          {/* 調理済み/配膳済み: 削除でなく折りたたみで保持 (戻すで復帰)。受注ページの対応済みと同流儀。 */}
          {doneOrders.length > 0 && (
            <details className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-600">
                {doneSectionLabel} ({doneOrders.length})
              </summary>
              <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {doneOrders.map((o) => renderCard(o, true))}
              </ul>
            </details>
          )}
        </>
      )}
      <p className="text-[11px] text-slate-400">{t('claimedNote')}</p>
    </div>
  );
}
