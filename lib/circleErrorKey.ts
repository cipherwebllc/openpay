// Circle の経路 (USDC ガスレス) の error が持つ「場面の符号」(circleCode) を、案内の文 (messages の CircleErrors) の key に
// 直す (第 10 回レビュー PR-39c)。3 つのフォーム (PaymentForm・CheckoutForm・TipForm) が、error の message (日本語の固定文) の
// 代わりに locale の文を出すのに使う。
//
// error の class は lib/smartAccount/circleSend.ts (遅延 import の chunk) にあり、フォームは First Load に入る。ここは
// circleSend を import しない。判定は error の own property `circleCode` の値だけで、class の同一性 (instanceof) も name も
// 見ない (hook が error を name で見るのと同じ理由 = chunk の境界を越える)。

/** 場面の符号。error の側 (circleSend.ts の 3 つの class) が own property `circleCode` に持つ値。 */
export type CircleErrorCode =
  | 'unconfirmed' // (a) 送った支払いの結果がまだ分からない
  | 'busy_elsewhere' // (b) 別のタブや画面で、同じ支払いが署名の途中
  | 'attempt_ended' // (c) この試みは既に終わっていた (何も送っていない)
  | 'send_rejected'; // (d) 送信の受付で断られた (送金されていない)

/** messages の namespace `CircleErrors` の key。 */
export type CircleErrorKey = 'unconfirmed' | 'busyElsewhere' | 'attemptEnded' | 'sendRejected';

const KEY_BY_CODE: Record<CircleErrorCode, CircleErrorKey> = {
  unconfirmed: 'unconfirmed',
  busy_elsewhere: 'busyElsewhere',
  attempt_ended: 'attemptEnded',
  send_rejected: 'sendRejected',
};
// Map で引く (object を直接引くと、'toString' のような継承した名前が key として返る)。
const KEYS = new Map<unknown, CircleErrorKey>(Object.entries(KEY_BY_CODE));

/** Circle の経路の error なら案内の文の key、それ以外 (符号なし・知らない符号・Error でない値) は null。 */
export function circleErrorKey(error: unknown): CircleErrorKey | null {
  return (
    (error instanceof Error && KEYS.get((error as { circleCode?: unknown }).circleCode)) || null
  );
}
