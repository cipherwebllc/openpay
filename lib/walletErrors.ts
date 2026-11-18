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

// ここから下の 2 つは、通常決済の会計の印の予約を解く判定だけが使う (hooks/useStandardPayment.ts の K4b)。上の 2 つ (計測・表示用)
// より厳しい: 「ウォレットが tx を出さずに断った」と確かめられたときだけ真にする。確かめられないものは全部 false。

/**
 * ウォレットが EIP-1193 の 4001 (userRejectedRequest) で答えたと、code で確かめられたか。文言では決めない (isUserRejection は
 * 'connection request reset' のような、ウォレットが tx を出した後に応答だけが失われたのかもしれない失敗も拒否に数える)。
 *
 * error の cause の連なりをたどり、次の両方のときだけ true:
 *   - いちばん奥の error (それ以上 cause の無い = ウォレットが投げた元の error) の code が数の 4001。
 *   - 途中の error の code は、無いか 4001 (4001 でない code が 1 つも無い)。
 * 途中の 4001 だけでは決めない (包む側が文言や別の code から作った 4001 かもしれない)。奥の 4001 だけでも決めない (包んだ側が別の
 * code を付けたなら、その 4001 が送信そのものへの答えかどうか分からない)。
 *   - wagmi の writeContract の拒否は ContractFunctionExecutionError → TransactionExecutionError → viem の
 *     UserRejectedRequestError (code 4001) → ウォレットが投げた元の error (code 4001) の形で届く (code があるのは奥の 2 つ)。
 *   - viem (utils/buildRequest.ts) は WalletConnect の 5000 (CAIP-25 の User Rejected) も UserRejectedRequestError (code 4001) に
 *     包む。元の error の code は 5000 なので false (EIP-1193 の 4001 ではない)。
 *   - viem は、ウォレットが投げた error に code が無いと UnknownRpcError (code -1) に包む。その cause の奥に 4001 があっても false。
 *   - wagmi の walletConnect の connector は、接続・チェーンの切り替えで、文言 (user rejected・connection request reset) から
 *     UserRejectedRequestError (code 4001) を作る。元の error に code が無いので false。
 *   - 元の error の code が無い・数の 4001 でない ('4001' の文字列など) は false。
 */
export function isEip1193UserRejection(err: unknown): boolean {
  let node = err;
  // 16 段まで (viem と wagmi の包みは 4 段)。輪になった cause・深すぎる連なりは、元の error を確かめられないので false。
  for (let depth = 0; depth < 16; depth += 1) {
    if (typeof node !== 'object' || node === null) return false;
    const { code, cause } = node as { code?: unknown; cause?: unknown };
    if (code !== undefined && code !== 4001) return false;
    if (cause === undefined || cause === null) return code === 4001;
    node = cause;
  }
  return false;
}

/**
 * その接続 (wagmi の connector の type) で届く 4001 が、ウォレット自身の答えか。
 *   - injected: provider がウォレット自身 (拡張・ウォレットのアプリの中のブラウザ)。
 *   - walletConnect: ウォレットの JSON-RPC の応答が relay でそのまま届く (dapp の側の @walletconnect/* は 4001 を作らない)。
 * Coinbase Wallet SDK (coinbaseWallet) は false: SDK が dapp の側で 4001 を作る (popup が閉じたとき = core/communicator の
 * disconnect・code の無い失敗の文に denied / rejected があるとき = core/error/serialize)。承認の後に popup を閉じると、tx が
 * 出ていても 4001 が届きうる。知らない接続 (mock・これから足す接続・未接続) も false。
 */
export function rejectionCodeIsWalletAnswer(connectorType: string | undefined): boolean {
  return connectorType === 'injected' || connectorType === 'walletConnect';
}
