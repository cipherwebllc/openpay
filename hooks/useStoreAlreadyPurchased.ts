'use client';

// この買い手 (SIWE でログイン済みのウォレット) がこの商品を購入済みかを、購入の前に確かめる (第 10 回レビュー H-K)。
//
// 支払いの応答を失った後 (署名して送ったが、結果が返る前にタブを閉じた・読み直した) は、購入 hook の
// 「購入の途中」の印 (memory だけ) が消える。1 本目が確定した後の再購入は仕様なので server は止めない
// = 払えたことを知らずにもう一度払える。ここで分かるのは「server が購入の記録を返した」ことだけで、
// 購入を止めるかどうかは呼び出し側 (CreatorStorePurchaseFlow の確認の段) が決める。
//
// 読むのは購入の有無だけを返す route (GET /api/store/purchased/{id}・SIWE 必須・応答は purchased と購入日時だけ)。
// 商品の本文を返す own content API (/api/store/content/{id}) は読まない: rate limit の枠が別なので、この読み取りが
// ライブラリの商品の読み取りと購入の直後の読み戻しの枠を食わない (Codex P2-2)。
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

/** 購入の記録がある (purchased: true と購入日時) 200 だけを購入済みとみなす。 */
function purchasedAtFrom(body: unknown): number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  if (
    value.ok !== true ||
    value.purchased !== true ||
    !Number.isSafeInteger(value.purchasedAt) ||
    (value.purchasedAt as number) <= 0
  ) {
    return null;
  }
  return value.purchasedAt as number;
}

/**
 * 購入済みと server が返したときだけ値を返す。未ログイン・読み込み中・purchased: false (購入の記録なし)・
 * 読み取りの失敗 (401・429・503・通信の失敗) はすべて null で、呼び出し側は今までどおり購入へ進める。
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
          `/api/store/purchased/${encodeURIComponent(resourceId)}`,
          {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          },
        );
        if (response.status !== 200) return;
        const purchasedAt = purchasedAtFrom(await response.json());
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
