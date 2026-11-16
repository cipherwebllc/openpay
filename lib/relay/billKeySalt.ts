// 会計ごとの印 (bill key) から、JPYC ガスレス (forwarder のある経路 = recover) の intentSalt を作る純関数。
// 払う側 (hooks/useJpycEip3009Payment) と、入金を確かめるお店の端末が、同じこの関数を使う (再実装しない)。
// server-only にしない・遅延 chunk から読む (/pay・/checkout の First Load JS に載せない)。
//
// bill key = お店が QR を出すたびに作る 128 bit の乱数を base64url にした 22 字。QR の URL の `bk` に載る。
// 払う側が intentSalt = keccak256(abi.encode(BILL_KEY_TAG, bill key の文字列)) で署名すると、forwarder の nonce
// (lib/relay/forwarderIntent の buildForwarderNonce) は金額・受取先・intentSalt を全部含む hash なので、Settled の nonce が
// 同じ式で計算し直した値と一致すれば「この bill key の QR から作られた、この金額・この受取先の支払い」と分かる。
// チェーンに出るのは hash した intentSalt だけで、bill key そのものは出ない。
//
// encode は lib/orderBind の orderBindSalt と同じ書き方 (abi.encode・先頭に用途の TAG)。bill key は 22 字の文字列を
// そのまま string として hash する (base64 を 16 byte に decode しない: decode すると、末尾の余りの bit だけが違う 2 つの
// 文字列が同じ byte になる)。値は golden vector で固定 (tests/lib/billKeySalt.test.ts)。

import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';

export const BILL_KEY_TAG: Hex = keccak256(toHex('openpay.bill-key.v1'));

// base64url の 22 字だけを bill key として受ける。
const BILL_KEY_RE = /^[A-Za-z0-9_-]{22}$/;

// 形の正しい bill key なら intentSalt、違えば null (呼ぶ側は「bill key が無い」ものとして扱う・throw しない)。
export function billKeySalt(billKey: unknown): Hex | null {
  if (typeof billKey !== 'string' || !BILL_KEY_RE.test(billKey)) return null;
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [BILL_KEY_TAG, billKey]),
  );
}

// 払う側の 1 回の署名に使う intentSalt と有効期限 (validBefore)。形の違う bill key は null。
// used = 呼ぶ側 (1 つの画面の mount) が持つ「この bill key の署名に使った有効期限」の集まりで、この関数が書き足す。
// 同じ bill key・同じ有効期限は 2 度返さない (重なったら 1 秒ずつ先へずらす): bill key の intentSalt は毎回同じ値なので、
// 同じ秒に署名し直すと nonce まで同じになり、relay は 1 回目 (revert など) の結果を返す。有効期限をずらせば別の nonce になる。
// ずれるのは重なった回数の秒だけ (端末の時計が戻ったときは、戻った後の値をそのまま使う)。
export function billKeyIntent(
  billKey: unknown,
  validBefore: bigint,
  used: Set<string>,
): { intentSalt: Hex; validBefore: bigint } | null {
  const intentSalt = billKeySalt(billKey);
  if (!intentSalt) return null;
  let unique = validBefore;
  while (used.has(`${intentSalt}:${unique}`)) unique += 1n;
  used.add(`${intentSalt}:${unique}`);
  return { intentSalt, validBefore: unique };
}
