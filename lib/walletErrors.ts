// ウォレット由来のエラー分類。ConnectButton.tsx の isUserRejection と同等のロジックを
// 共有化する (計測で「顧客が署名を拒否した」(= 想定内・離脱) と「署名処理が技術的に失敗
// した」(= 要調査) を区別するため)。
//
// viem の UserRejectedRequestError も message に 'User rejected the request.' を含むので
// message ベースで拾える (型 import せず message 判定に倒すことで viem version 差にも頑健)。
//
// 注: ConnectButton.tsx:10 / その他 2 コンポーネントの重複は本 P1 では触らない (scope 限定・
// 計画 §2)。将来それらをこの共有関数へ寄せる。

export function isUserRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('connection request reset')
  );
}
