'use client';

// お店の画面 (/create の決済QR・レジ) が、画面に表示中の QR に会計ごとの印 (bill key) を載せ、その会計を入金の見張り
// (lib/qrSaleWatch.ts) に伝える。払う側は bill key から署名の intentSalt を作り (lib/relay/billKeySalt.ts)、お店の端末は
// チェーンの `Settled` の nonce を計算し直して「この会計の入金」と確かめ、取引履歴に書く。
//
// 載せる QR を決めるのは呼ぶ側: JPYC・forwarder のあるチェーンのガスレス (回収) で、金額のある通常の QR だけ
// (それ以外は url に空文字を渡す)。お店負担の QR・金額なし・EIP-681・通常決済・USDC・forwarder の無いチェーンには載せない。
// 返すのは「画面の QR に描く URL」だけ。URL のコピー・印刷 / PNG / SVG の保存・前回の受け取り QR の保存には、呼ぶ側が
// 元の URL を使う (bill key を画面の外へ出さない)。
//
// bill key は、QR を出すたび・表示する URL が変わるたびに新しく作る。同じ表示のあいだの再描画では作り直さない
// (state に持つ)。作った bill key と会計の写し (元の URL) は見張りに渡し、memory だけに持つ (保存しない)。
//
// 付帯の処理 (掟 13): 見張りの読み込み (dynamic import) と見張りの中の失敗は、QR の表示・開閉・レジの操作へ波及させない
// (Promise は必ずここで受け止め、画面には何も返さない)。見張れなくても QR は bill key つきで出る (払う側の動きは同じ)。

import { useEffect, useRef, useState } from 'react';
import { newBillKey, withBillKey } from '@/lib/url/billKeyQr';

type QrSaleWatch = typeof import('@/lib/qrSaleWatch');

// 見張りの chunk (この画面で 1 回だけ読む)。読めなかったら捨てて、次に QR を出したときにもう一度読む。
let watchChunk: Promise<QrSaleWatch> | null = null;

function withWatch(run: (watch: QrSaleWatch) => void): void {
  watchChunk ??= import('@/lib/qrSaleWatch');
  const loading = watchChunk;
  loading
    .then(run, () => {
      if (watchChunk === loading) watchChunk = null;
    })
    // 見張りの関数は throw しない作りだが、ここで受け止めて未処理の reject にしない (QR の画面へ波及させない)。
    .catch(() => {});
}

export type QrBillKeyArgs = {
  /** 決済QR (/pay) か、レジ (/checkout) か。 */
  kind: 'pay' | 'checkout';
  /** bill key を載せる QR の URL (載せない QR・まだ出せない QR では空文字)。 */
  url: string;
  /** その QR を、いま画面に表示しているか。 */
  shown: boolean;
  /** /pay の値引きの行の名前 (商品名も店名も無いとき・払う側と同じ言葉)。レジでは使わない。 */
  itemName?: string;
};

/** 画面の QR に描く URL (bill key つき)。載せないときは undefined (呼ぶ側は元の URL を描く)。 */
export function useQrBillKey({ kind, url, shown, itemName = '' }: QrBillKeyArgs): string | undefined {
  const wanted = shown && url !== '';
  const [issued, setIssued] = useState<{ url: string; billKey: string } | null>(null);
  // 表示を始めた・表示する URL が変わった → 新しい bill key。表示をやめた → 捨てる (次に出すときは新しく作る)。
  // 描画の途中で state を合わせる (effect で合わせると、bill key の無い QR が 1 回描かれる)。
  let current = issued;
  if (wanted ? issued?.url !== url : issued !== null) {
    current = wanted ? { url, billKey: newBillKey() } : null;
    setIssued(current);
  }
  const itemNameRef = useRef(itemName);
  useEffect(() => {
    itemNameRef.current = itemName;
  }, [itemName]);
  useEffect(() => {
    if (!issued) return;
    const { billKey } = issued;
    // 表示を始めた時刻・やめた時刻は、ここ (その瞬間) で決めて渡す。見張りの chunk の読み込みを待った後の時刻にすると、
    // 読み込みが遅いとき「やめてから 60 秒」の数え始めが後ろへずれる。
    const shownAt = Date.now();
    withWatch((watch) =>
      watch.showQrBill({ billKey, kind, url: issued.url, itemName: itemNameRef.current }, shownAt),
    );
    // 表示をやめた bill key も、見張りが 60 秒は持つ (閉じた直後・出し直した直後の入金を拾う)。
    return () => {
      const hiddenAt = Date.now();
      withWatch((watch) => watch.hideQrBill(billKey, hiddenAt));
    };
  }, [issued, kind]);
  return current ? withBillKey(current.url, current.billKey) : undefined;
}

/** /create のページに 1 つ置く。ページを離れたら、見張りを止める (タブの切り替えでは止めない)。 */
export function useQrSaleWatchScope(): void {
  useEffect(
    () => () => {
      // 読み込んでいなければ、止めるものが無い (ここで chunk を読みにいかない)。
      void watchChunk?.then((watch) => watch.stopQrSaleWatch()).catch(() => {});
    },
    [],
  );
}
