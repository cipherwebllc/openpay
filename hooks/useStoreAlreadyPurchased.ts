'use client';

// この買い手 (SIWE でログイン済みのウォレット) がこの商品を購入済みかを、購入の前に確かめる (第 10 回レビュー H-K)。
//
// 支払いの応答を失った後 (署名して送ったが、結果が返る前にタブを閉じた・読み直した) は、購入 hook の
// 「購入の途中」の印 (memory だけ) が消える。1 本目が確定した後の再購入は仕様なので server は止めない
// = 払えたことを知らずにもう一度払える。ここで分かるのは「server が購入の記録を返した」ことだけで、
// 購入を止めるかどうかは呼び出し側 (CreatorStorePurchaseFlow の確認の段) が決める。
//
// 読むのは購入済みライブラリと同じ own content API (GET /api/store/content/{id}・SIWE 必須・selector なし
// = 最新の購入)。新しい API は足さない。応答には商品の本文も入るが、ここでは購入の記録の有無と購入日時
// だけを取り出し、本文は state に置かない。
//
// React Query を使わない: 購入画面の component テストは QueryClientProvider なしで描画しており、
// この読み取りは 1 回きりで cache を共有する相手もいない。

import { useEffect, useState } from 'react';

export type StoreKnownPurchase = {
  /** 最新の購入の日時 (ms)。server の購入記録の値。 */
  purchasedAt: number;
};

type UseStoreAlreadyPurchasedInput = {
  resourceId: string;
  /** 接続中のウォレットと一致する SIWE session の address。一致しない・未ログインなら null (読まない)。 */
  sessionAddress: string | null;
  /** 購入画面が開いている間だけ読む。 */
  enabled: boolean;
  /** 値が変わるたびに読み直す (新しい見積もりごと = 画面を開いた後に確定した購入を拾う)。 */
  refreshKey?: string | null;
};

type Known = { scope: string; purchasedAt: number };

/** 購入 (grant) に基づく own content API の 200 だけを購入済みとみなす。 */
function purchasedAtFrom(body: unknown, resourceId: string): number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  // intentSalt / purchasedAt は購入の記録からの応答にだけ入る。購入せずに譲渡で license を持つ
  // ウォレット (source=holder) の 200 には無いので、「購入済み」とは言わない。
  if (
    value.ok !== true ||
    value.resourceId !== resourceId ||
    typeof value.intentSalt !== 'string' ||
    !Number.isSafeInteger(value.purchasedAt) ||
    (value.purchasedAt as number) <= 0
  ) {
    return null;
  }
  return value.purchasedAt as number;
}

/**
 * 購入済みと server が返したときだけ値を返す。未ログイン・読み込み中・404 (購入の記録なし)・
 * 読み取りの失敗はすべて null で、呼び出し側は今までどおり購入へ進める。
 */
export function useStoreAlreadyPurchased({
  resourceId,
  sessionAddress,
  enabled,
  refreshKey = null,
}: UseStoreAlreadyPurchasedInput): StoreKnownPurchase | null {
  const scope =
    enabled && sessionAddress
      ? `${sessionAddress.toLowerCase()}:${resourceId}`
      : null;
  const [known, setKnown] = useState<Known | null>(null);

  useEffect(() => {
    if (scope === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/store/content/${encodeURIComponent(resourceId)}`,
          {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          },
        );
        if (response.status !== 200) return;
        const purchasedAt = purchasedAtFrom(await response.json(), resourceId);
        if (purchasedAt === null) return;
        // 応答が届いた時点の買い手・商品ではなく、依頼した時点の scope で記録する
        // (切り替えた後に届いた古い応答は、下の scope の照合で使われない)。
        setKnown({ scope, purchasedAt });
      } catch {
        // 何の波及を断つか: 購入済みかどうかの読み取りは購入の付帯の処理。通信の失敗・JSON でない応答で
        // 購入の画面を止めない (分からないときは確認の段を出さず、今までどおり進める)。
      }
    })();
    return () => controller.abort();
  }, [scope, resourceId, refreshKey]);

  // 別のウォレット・別の商品で分かった結果を、今の買い手・今の商品に使わない。
  return scope !== null && known !== null && known.scope === scope
    ? { purchasedAt: known.purchasedAt }
    : null;
}
