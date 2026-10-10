// Agent への入金 (ERC-20 transfer) が、ウォレットで置き換えられた取引 (同じ nonce の別の取引) で届いたかの照合。
//
// viem の waitForTransactionReceipt は置換を見つけると onReplaced に置換 tx の receipt を渡す。reason は
//   repriced  = to・value・calldata が同じ (ガス代だけ変更) → 同じ送金
//   cancelled = 自分宛て 0 送金 → 送られていない
//   replaced  = それ以外 (calldata が違う) → 「送られていない」とは限らない。ガス上限や他の項目を変えただけで
//               同じ transfer が実行されたこともあるので、receipt の Transfer ログ (token・from・to・金額) で決める。
// 判定を間違えると「入金が届いたのに失敗表示 → 再送で二重入金」か「届いていないのに成功表示」になるので、
// reason の文字列ではなく receipt のログ (オンチェーンの事実) を見る。

import { erc20Abi, isAddressEqual, parseEventLogs, type Address, type Log } from 'viem';

export type ExpectedTransfer = { token: Address; from: Address; to: Address; amount: bigint };

/** 置換 tx の receipt (status と logs だけ使う)。 */
export type ReplacementReceiptLike = { status: 'success' | 'reverted'; logs: readonly Log[] };

/** 置換 tx が成功し、期待どおりの Transfer (token・from・to・金額が一致) を含むか。 */
export function replacementDeliveredTransfer(receipt: ReplacementReceiptLike, expected: ExpectedTransfer): boolean {
  if (receipt.status !== 'success') return false;
  let transfers: { address: Address; args: { from: Address; to: Address; value: bigint } }[];
  try {
    transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs as Log[] });
  } catch {
    // ログを読めない receipt は「届いた」と言えない (安全側 = 失敗扱い・再入力は呼び出し側が許す)。
    return false;
  }
  return transfers.some(
    (log) =>
      isAddressEqual(log.address, expected.token) &&
      isAddressEqual(log.args.from, expected.from) &&
      isAddressEqual(log.args.to, expected.to) &&
      log.args.value === expected.amount,
  );
}
