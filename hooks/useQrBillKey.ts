'use client';

// お店の画面 (/create の決済QR・レジ) が、画面に表示中の QR に会計ごとの印 (bill key) を載せ、その会計を入金の見張り
// (lib/qrSaleWatch.ts) に伝える。払う側は bill key から署名の intentSalt を作り (lib/relay/billKeySalt.ts)、お店の端末は
// チェーンの `Settled` の nonce を計算し直して「この会計の入金」と確かめ、取引履歴に書く。通常決済の QR の会計は、JPYC の
// `Transfer` の tx の input にある印 (billKeyStdMark) で確かめる (払う側が印を付けるのは別の変更から)。
//
// 載せる QR を決めるのは呼ぶ側: JPYC・forwarder のあるチェーンのガスレス (回収) と、JPYC の通常決済で、金額のある通常の
// QR だけ (それ以外は url に空文字を渡す)。お店負担の QR・金額なし・EIP-681・USDC・forwarder の無いチェーンのガスレスには
// 載せない。
// 返すのは「画面の QR に描く URL」と、下の「入金の確認」だけ。URL のコピー・印刷 / PNG / SVG の保存・前回の受け取り QR の
// 保存には、呼ぶ側が元の URL を使う (bill key を画面の外へ出さない)。
//
// bill key は、QR を出すたび・表示する URL が変わるたびに新しく作る。同じ表示のあいだの再描画では作り直さない
// (state に持つ)。作った bill key と会計の写し (元の URL) は見張りに渡し、memory だけに持つ (保存しない)。
//
// 入金の確認 (confirmed): 見張りが、この会計の入金を取引履歴に書いたら知らせてくる (lib/qrSaleWatch.ts の頭の注記の
// 「画面への知らせ」)。書けなかったかもしれない (notSaved) ときも知らせてくる。返すのは、いま表示している会計 (bill key) の
// 知らせを合わせたもの: 同じ会計の知らせは巻き戻さない (何件目かは大きい方・notSaved は一度付いたら付いたまま = 2 件目が
// 書けても、1 件目が書けなかったかもしれないことは消さない)。QR を閉じた後・出し直した後に見つけた前の会計の入金
// (見張りは閉じた後も 60 秒読む) は、履歴には入るが、ここでは受けない・返さない。新しい会計の QR を出したら、前の会計の
// 知らせは返さない (画面から消える)。
//
// 付帯の処理 (掟 13): 見張りの読み込み (dynamic import) と見張りの中の失敗は、QR の表示・開閉・レジの操作へ波及させない
// (Promise は必ずここで受け止め、画面には何も返さない)。見張れなくても QR は bill key つきで出る (払う側の動きは同じ)。

import { useEffect, useRef, useState } from 'react';
import { formatStoreDeviceAmount } from '@/lib/storeDevicePayment';
import { newBillKey, withBillKey } from '@/lib/url/billKeyQr';

// 見張りの module は型だけを使う (静的な import にしない = /create の First Load JS に載せない)。
type QrSaleWatch = typeof import('@/lib/qrSaleWatch');
type QrBillRecorded = import('@/lib/qrSaleWatch').QrBillRecorded;

/**
 * 表示中の会計の入金を、見張りが確かめた (count = 何件目か・amount = 行の売上総額 = 請求額 (wei)・notSaved = その会計の
 * 入金のどれかを、この端末の履歴に書けなかったかもしれない)。
 */
export type QrBillConfirmed = Pick<QrBillRecorded, 'count' | 'amount' | 'notSaved'>;

/**
 * QR の画面 (決済QR・レジ) に出す入金の確認の文 (QrPreviewModal の billConfirmed)。t は QrGenerator の namespace のもの。
 * 文の選び方は、見張りが書いた行と同じ数え方: 1 件目 (明細つきの行) と、同じ会計への 2 件目以降 (明細なしの行 = 二重の
 * お支払いかもしれない)。額は書いた行の売上総額 (= 請求額) を、お店の端末で送るの「入金を確認しました（{amount}）」
 * (RegisterMode.storeDevice.received) と同じ形 (例「1400 JPYC」) で出す。
 */
export function qrBillConfirmedText(
  t: (key: 'billPaymentRecorded' | 'billPaymentAnother', values: { amount: string }) => string,
  confirmed: QrBillConfirmed,
): string {
  return t(confirmed.count === 1 ? 'billPaymentRecorded' : 'billPaymentAnother', {
    amount: formatStoreDeviceAmount(confirmed.amount),
  });
}

/**
 * QR の画面 (QrPreviewModal) に渡す、入金の確認 (緑・billConfirmed) と、履歴に書けなかったかもしれない注意 (amber・
 * billNotSaved)。1 件目だけで書けなかったかもしれないときは、緑の「取引履歴に記録しました」を出さない (注意だけ)。
 * 2 件目以降の「二重のお支払いかもしれません」と注意は、両方が当たれば両方出す。
 */
export function qrBillNotices(
  t: (key: 'billPaymentRecorded' | 'billPaymentAnother' | 'billPaymentNotSaved', values?: { amount: string }) => string,
  confirmed: QrBillConfirmed,
): { billConfirmed?: string; billNotSaved?: string } {
  const notSavedOnly = confirmed.notSaved === true && confirmed.count === 1;
  return {
    ...(notSavedOnly ? {} : { billConfirmed: qrBillConfirmedText(t, confirmed) }),
    ...(confirmed.notSaved ? { billNotSaved: t('billPaymentNotSaved') } : {}),
  };
}

// 同じ会計の知らせを合わせる (巻き戻さない): 何件目かは大きい方 (額はその知らせの額)・notSaved は一度付いたら付いたまま。
function mergeRecorded(prev: QrBillRecorded | null, event: QrBillRecorded): QrBillRecorded {
  if (prev?.billKey !== event.billKey) return event;
  const latest = event.count >= prev.count ? event : prev;
  return {
    billKey: event.billKey,
    count: latest.count,
    amount: latest.amount,
    ...(prev.notSaved || event.notSaved ? { notSaved: true as const } : {}),
  };
}

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

export type QrBillKeyResult = {
  /** 画面の QR に描く URL (bill key つき)。載せないときは undefined (呼ぶ側は元の URL を描く)。 */
  screenUrl: string | undefined;
  /** 表示中の会計の入金を、見張りが確かめた (まだ無い・表示していないときは null)。 */
  confirmed: QrBillConfirmed | null;
};

export function useQrBillKey({ kind, url, shown, itemName = '' }: QrBillKeyArgs): QrBillKeyResult {
  const wanted = shown && url !== '';
  const [issued, setIssued] = useState<{ url: string; billKey: string } | null>(null);
  // 表示を始めた・表示する URL が変わった → 新しい bill key。表示をやめた → 捨てる (次に出すときは新しく作る)。
  // 描画の途中で state を合わせる (effect で合わせると、bill key の無い QR が 1 回描かれる)。
  let current = issued;
  if (wanted ? issued?.url !== url : issued !== null) {
    current = wanted ? { url, billKey: newBillKey() } : null;
    setIssued(current);
  }
  const [recorded, setRecorded] = useState<QrBillRecorded | null>(null);
  // いま表示している bill key (effect の中で決める)。見張りの知らせは、閉じた後・出し直した後にも届くので、届いた時点で
  // 表示中の会計の分だけを受ける (前の会計の知らせで、表示中の会計の知らせを上書きしない)。
  const shownKeyRef = useRef<string | null>(null);
  const itemNameRef = useRef(itemName);
  useEffect(() => {
    itemNameRef.current = itemName;
  }, [itemName]);
  useEffect(() => {
    if (!issued) return;
    const { billKey } = issued;
    shownKeyRef.current = billKey;
    // 表示を始めた時刻・やめた時刻は、ここ (その瞬間) で決めて渡す。見張りの chunk の読み込みを待った後の時刻にすると、
    // 読み込みが遅いとき「やめてから 60 秒」の数え始めが後ろへずれる。
    const shownAt = Date.now();
    const onRecorded = (event: QrBillRecorded) => {
      if (shownKeyRef.current === event.billKey) setRecorded((prev) => mergeRecorded(prev, event));
    };
    withWatch((watch) =>
      watch.showQrBill({ billKey, kind, url: issued.url, itemName: itemNameRef.current }, shownAt, onRecorded),
    );
    // 表示をやめた bill key も、見張りが 60 秒は持つ (閉じた直後・出し直した直後の入金を拾う)。
    return () => {
      if (shownKeyRef.current === billKey) shownKeyRef.current = null;
      const hiddenAt = Date.now();
      withWatch((watch) => watch.hideQrBill(billKey, hiddenAt));
    };
  }, [issued, kind]);
  // 返すのは、いま描く会計の知らせだけ (閉じた・出し直した = current が変わったら、前の会計の知らせは返さない)。
  const confirmed: QrBillConfirmed | null =
    current && recorded?.billKey === current.billKey
      ? {
          count: recorded.count,
          amount: recorded.amount,
          ...(recorded.notSaved ? { notSaved: recorded.notSaved } : {}),
        }
      : null;
  return { screenUrl: current ? withBillKey(current.url, current.billKey) : undefined, confirmed };
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
