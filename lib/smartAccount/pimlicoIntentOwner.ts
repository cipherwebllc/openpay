// Pimlico の経路の記録の「同じ intent」と「同じ版」の定義 (第 10 回レビュー PR-02 の Codex レビュー P1 と、その 2 回目)。定義はここ
// 1 つで、使うのは intent の関所 (lib/smartAccount/pimlicoIntent.ts の storedVersion) と hook (hooks/useBatchPayment.ts の、控えの
// 無い記録の receipt 待ちの失敗と確定の片付け)。hook が静的に読むので、ここには何も import しない (/pay /checkout /tip /[handle] の
// First Load JS)。
//
// 同じ intent (isSameIntent): 確定 (receipt が取れた op の記録の片付け) にだけ使う。その nonce の op が取り込まれた以上、同じ intent の
// どの版の記録も終わっている。
//   送信の控え (send) のある記録: EntryPoint・sender・nonce (key と seq) が同じ。同じ nonce で作り直した op・bundler の返した hash
//     で直した記録は、hash が違っても同じ intent (EntryPoint は同じ EntryPoint・sender・nonce の op を最大 1 本しか実行しない)。
//   控えの無い記録 (控えを足す前の記録・MAv2 の facade で送った記録): userOpHash が同じ。
//   片方だけ控えがある: 別の intent (控えの無い記録が控えを持つようになる道は無い)。
//
// 同じ版 (isSameVersion): 確定によらない後からの書き込みと削除 (compare-and-set) に使う。同じ intent で、userOpHash と updatedAt も
// 同じ。送り直しは updatedAt (期限の基準) を進め、作り直しと hash の直しは userOpHash を変えるので、ほかの試みが新しくした記録は
// 「別の版」になる。何の波及を断つか: 古い写しを知っている試みが、新しくなった記録を上書きして期限の基準を巻き戻す (早く閉じて、
// まだ実行されうる op の上に払い直せる)・作り直した op の記録を消す (reload の後に確かめられず払い直せる) こと。
// status (pending / unknown) は版に入れない: reload はどちらも結果不確定として復元し、安全に関係しない。入れると、画面の無い試みが
// 応答不明を書いただけで、画面のある試みが同じ記録を期限で閉じられなくなる。
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

export function isSameVersion(
  a: IntentIdentity & { updatedAt: number },
  b: IntentIdentity & { updatedAt: number },
): boolean {
  return isSameIntent(a, b) && a.userOpHash === b.userOpHash && a.updatedAt === b.updatedAt;
}
