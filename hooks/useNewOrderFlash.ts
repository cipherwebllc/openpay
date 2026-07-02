'use client';

// 新着注文の点滅 (フラッシュ) 記帳を担う client hook。OrderFulfillmentBoard から抽出。
// - 初回スナップショットの注文は「新着」にしない (seen に積むだけ)。以降に現れた新しい id を
//   flashMs だけ点滅させ、現在点滅中の id 集合を返す。
// - subject (フィードのスコープ = 受取アドレス or 受注閲覧トークン) が変わったら検出を初期化
//   (別店舗/別端末の既存注文を新着扱いしない)。
// - 音/チャイムは呼出側の責務: 新着を検出したら onNewOrders(fresh) を呼ぶだけ (この hook は鳴らさない)。
// id は決済単位で安定な txHash を想定 (状態更新では変わらない = 状態トグルで再アラートしない)。
// seen は **毎回 現フィード全件 (done 含む)** で作り直す = 対応済み⇄戻すの往復で誤アラートせず、
// かつ古い id を溜め込まない (メモリ上限=フィード件数)。

import { useEffect, useRef, useState } from 'react';

const DEFAULT_FLASH_MS = 6_000; // 新着カードの点滅持続

export function useNewOrderFlash(
  // 現フィード全件の安定 id (txHash)。done 含む全件を渡す (prune の単一情報源)。
  ids: string[],
  // 検出主体 (feed のスコープ)。変化で検出を初期化する。
  subject: string | null | undefined,
  {
    enabled,
    flashMs = DEFAULT_FLASH_MS,
    onNewOrders,
  }: {
    // feed が有効 (SIWE サインイン or token モード) かつ成功スナップショットのときだけ true。
    // false のときは seed もしない (無効 query の空データで seed → 有効化後に全件誤アラート、を避ける)。
    enabled: boolean;
    flashMs?: number;
    // 新着 (初回スナップショット以降の新規 id) を検出したら呼ぶ。呼出側が音を鳴らす等に使う。
    onNewOrders?: (fresh: string[]) => void;
  },
): Set<string> {
  const seenRef = useRef<Set<string>>(new Set());
  const initRef = useRef(false); // 初回スナップショットを seed 済みか
  const flashTimers = useRef<Set<number>>(new Set());
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  // onNewOrders は毎レンダー新規参照になりうるので ref 経由で最新を読む (検出 effect の dep から外す)。
  const onNewOrdersRef = useRef(onNewOrders);
  onNewOrdersRef.current = onNewOrders;

  // unmount で未発火タイマーを掃除 (溜め込み/リーク防止)。
  useEffect(() => () => flashTimers.current.forEach((id) => clearTimeout(id)), []);

  // 主体が変わったら検出を初期化 (別店舗/別端末の既存注文を新着扱いしない)。
  useEffect(() => {
    seenRef.current = new Set();
    initRef.current = false;
    setFlashing(new Set());
  }, [subject]);

  // 新着検出。ids の **内容** 変化 (idsKey) を trigger にする — 毎レンダーの新規配列参照では回さない
  // (30s 経過タイマー等の再レンダーで無駄に走らせない)。txHash に ',' は現れないので join が安定キー。
  const idsKey = ids.join(',');
  useEffect(() => {
    if (!enabled) return;
    const idSet = new Set(ids);
    if (!initRef.current) {
      seenRef.current = idSet; // 初回スナップショット = 既知 (鳴らさない)
      initRef.current = true;
      return;
    }
    const fresh = ids.filter((id) => !seenRef.current.has(id));
    seenRef.current = idSet; // 毎回作り直し = prune (古い id を溜めない)
    if (fresh.length === 0) return;
    setFlashing((prev) => {
      const nextSet = new Set(prev);
      fresh.forEach((id) => nextSet.add(id));
      return nextSet;
    });
    onNewOrdersRef.current?.(fresh); // 音/チャイムは呼出側 (この hook は鳴らさない)
    const timer = window.setTimeout(() => {
      flashTimers.current.delete(timer); // 発火済み id を破棄 (溜め込み防止)
      setFlashing((prev) => {
        const nextSet = new Set(prev);
        fresh.forEach((id) => nextSet.delete(id));
        return nextSet;
      });
    }, flashMs);
    flashTimers.current.add(timer);
    // idsKey/enabled/flashMs だけを trigger に (ids は idsKey が代表・onNewOrders は ref 経由)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, enabled, flashMs]);

  return flashing;
}
