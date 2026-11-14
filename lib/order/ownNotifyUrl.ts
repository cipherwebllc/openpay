// `webhook=` が OpenPay 自身の受注 notify の URL (同じ origin + pathname が `/api/order/notify`) かの解析 (第 10 回レビュー PR-14)。
//
// client 側の 4 か所が別々に `new URL` していた解析を、ここ 1 つにした。ここがするのは解析だけで、`h` の数・正規化・
// お店の @handle との照合といった方針は、使う所ごとに違うまま呼び出し側に残してある (そろえていない)。
// 方針を変えるときは、下の表と tests/components/CheckoutForm.orderNotify.characterization.test.tsx の「自社 URL の判定の表」
// (URL_ROWS) を一緒に直す。
//
// | 使う所 | 自社の URL に加えて求めること | 読めない URL (unreadable) |
// |---|---|---|
// | 1. hooks/useCheckoutOrderNotify.ts の isOwnOrderNotifyUrl。使うのは 3 つ: 完了の通知 (effect A)・払う前の下限の守り (components/CheckoutForm.tsx の sendsOrderNotify)・控えを読めなかったときの警告 (同 JSX) | 何も求めない (`h` を見ない)。完了の通知は URL の文字列そのままへ送る | 自社でない (送らない・守らない・警告を出さない) |
// | 2. hooks/useCheckoutOrderNotify.ts の通常決済の部分の通知 (effect D) | この画面で払ったときは何も求めない。読み直した画面 (submitSnapshotRef が空) のときだけ、`store_handle` があり・`h` がちょうど 1 つ・`h` と `store_handle` が toLowerCase で同じ (trim も `@` 外しもしない) | 自社でない (送らない) |
// | 3. components/CheckoutForm.tsx の onSubmit (relay で払うときの注文の束縛) | `h` がちょうど 1 つ (違えば invalid_handle → 「URL が不正」の案内で止める)。値は `h` のまま lib/orderBind.ts の canonicalOrder へ渡し、正規化と形式の確かめはそちらがする | **止める** (「保存できない」の案内)。自社でない URL (other) は束ねずに払うが、読めない URL はそれと同じにしない |
// | 4. lib/orderDeliveryContext.ts の matchesOrderDeliveryContext (読み直した画面で、保存した束縛つきの注文を今の URL と照らす) | `h` がちょうど 1 つ・`h` を trim して先頭の `@` を外して小文字にしたものが、保存した注文の handle と同じ | 自社でない (照合しない) |
//
// 差の理由 (code とコメントから読み取れる範囲。書いていないものは「記録に無い」):
//   - origin と pathname を完全一致で見る (4 か所とも): 部分一致だと、第三者の URL (`https://shop/hook?next=/api/order/notify` など) へ
//     payload や statusToken を送りうる (effect A のコメント)。
//   - 1 が読めない URL を「自社でない」にする: 不正な callback が、関係のない会計の画面に受注の復旧の警告を出さないため
//     (isOwnOrderNotifyUrl のコメント)。
//   - 2 が読み直した画面でだけ `h` と `store_handle` を照らす: 読み直した画面の部分の通知は、保存した送金の hash を今の URL に
//     結び付けて、URL の webhook の文字列そのままへ送る。結び付けてよいかは会計の指紋 (lib/checkoutIntentContext.ts の
//     checkoutIntentContextFingerprint) で確かめるが、指紋の値の列に `store_handle` は入っていて、webhook は入っていない
//     (「callback URL … は入力にせず」)。指紋が合っても webhook の `h` が別のお店を指す URL だと、そのお店へ通知してしまうので、
//     `h` を `store_handle` と照らす (tests/components/CheckoutForm.test.tsx の「standard reload: fingerprint が一致しても
//     webhook handle が店舗と違えば通知しない」。この条件とテストは commit 0e268d38 で一緒に入った)。
//     この画面で払ったとき (復元ではなく、指紋も使わない) は照らさない。
//     4 と違って `@` を外さない理由は、記録に無い。
//   - 3 が `h` 1 つを求める: 自社の URL なのに注文を束ねられないまま送金に進ませない (catch のコメント
//     「Storage/invalid own-origin context must not broadcast an order with a missing opening」)。
//     読めない URL が「URL が不正」でなく「保存できない」の案内になるのは、移す前に `new URL` の例外が catch の
//     「それ以外」の側に落ちていたのをそのまま残したもので、案内を分けた理由は記録に無い。
//   - 4 が正規化する: 保存した注文の handle は canonicalOrder が lib/handle の normalizeHandle で正規化した値なので、同じ正規化で
//     比べる (lib/orderDeliveryContext.ts の「Match lib/handle's normalization …」)。
//   - 1 が `h` を見ない理由 (`h` が無くても 2 つでも完了の通知を送る) は、記録に無い。
//
// 宛先を組む側 (`new URL('/api/order/notify', origin)`・components/MobileOrderView.tsx) と server の route は、ここを使わない。
// この file は何も import しない: lib/orderDeliveryContext.ts が CheckoutForm の最初の描画で使うので、ABI や storage の
// module を巻き込まない。

export type OwnOrderNotifyUrl =
  // 同じ origin + pathname が '/api/order/notify'。handles は searchParams.getAll('h') のまま (trim・小文字化・`@` 外しをしない)。
  | { kind: 'own'; handles: string[] }
  // URL として読めるが、自社の notify ではない。
  | { kind: 'other' }
  // `new URL` が投げた (相対 URL・URL でない文字列)。
  | { kind: 'unreadable' };

export function parseOwnOrderNotifyUrl(webhook: string, origin: string): OwnOrderNotifyUrl {
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    // 読めない URL の扱いは使う所ごとに違う (冒頭の表) ので、ここで other に丸めずに分けて返す。
    return { kind: 'unreadable' };
  }
  if (url.origin !== origin || url.pathname !== '/api/order/notify') return { kind: 'other' };
  return { kind: 'own', handles: url.searchParams.getAll('h') };
}
