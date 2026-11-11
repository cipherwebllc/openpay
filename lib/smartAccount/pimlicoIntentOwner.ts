// Pimlico の経路の記録の「同じ intent」の定義 (第 10 回レビュー PR-02 の Codex レビュー P1)。記録への後からの書き込み・削除は、
// storage にいま入っている記録がこれで同じ intent のときだけ行う (持ち主の確認)。使うのは intent の関所
// (lib/smartAccount/pimlicoIntent.ts の storedIntent) と hook (hooks/useBatchPayment.ts の、控えの無い記録の receipt 待ちの失敗と
// 確定の片付け) で、定義はここ 1 つ。hook が静的に読むので、ここには何も import しない (/pay /checkout /tip /[handle] の
// First Load JS)。
//
//   送信の控え (send) のある記録: EntryPoint・sender・nonce (key と seq) が同じ。同じ nonce で作り直した op・bundler の返した hash
//     で直した記録は、hash が違っても同じ intent (EntryPoint は同じ EntryPoint・sender・nonce の op を最大 1 本しか実行しない)。
//   控えの無い記録 (控えを足す前の記録・MAv2 の facade で送った記録): userOpHash が同じ。
//   片方だけ控えがある: 別の intent (控えの無い記録が控えを持つようになる道は無い)。
type IntentIdentity = {
  userOpHash: string;
  send?: { entryPoint: string; sender: string; nonceKey: string; nonceSeq: string };
};

export function isSameIntent(a: IntentIdentity, b: IntentIdentity): boolean {
  if (!a.send || !b.send) return !a.send && !b.send && a.userOpHash === b.userOpHash;
  // nonceKey・nonceSeq は 10 進の文字列 (先頭の 0 なし・hooks/useBatchPayment.ts の isDecimal) なので、文字列のまま比べる。
  return (
    a.send.entryPoint.toLowerCase() === b.send.entryPoint.toLowerCase() &&
    a.send.sender.toLowerCase() === b.send.sender.toLowerCase() &&
    a.send.nonceKey === b.send.nonceKey &&
    a.send.nonceSeq === b.send.nonceSeq
  );
}
