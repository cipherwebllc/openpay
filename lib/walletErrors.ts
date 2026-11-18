// ウォレット由来のエラー分類。
// - isUserRejection: 計測で「顧客が署名を拒否した」(= 想定内・離脱) と「署名処理が技術的に失敗
//   した」(= 要調査) を区別する。
// - isConnectRejection: 接続 (wagmi の useConnect) のエラーを画面に出さない判定。ConnectButton と
//   WalletBadge が同じ実装を別々に持っていたものを 1 つにした (全レビュー第 8 回 F-5 / PR-17)。
//
// viem の UserRejectedRequestError も message に 'User rejected the request.' を含むので
// message ベースで拾える (型 import せず message 判定に倒すことで viem version 差にも頑健)。
//
// 2 つは判定が違うので 1 つにしていない: isConnectRejection は 'user denied' を拒否に数えず、
// Error でない object (message だけを持つ) もそのまま判定する。寄せると接続エラーの表示が変わる。
// components/NativeTipForm.tsx の isUserRejection も判定語 ('rejected the request') と引数の型
// (null 可) が違うので、ここへは寄せていない (tests/lib/walletErrors.test.ts が違いを固定する)。

export function isUserRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('connection request reset')
  );
}

export function isConnectRejection(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return msg.includes('user rejected') || msg.includes('connection request reset');
}
