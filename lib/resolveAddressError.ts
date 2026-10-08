// lib/resolveAddress.ts が自分で判定して投げる、利用者にそのまま見せてよい誤り (未登録・形式違い)。
// それ以外 (RPC・CCIP-Read の外部サーバの失敗など) は生の英語の技術的な文面なので、画面では言い換える
// (components/AddressInput.tsx)。lib/resolveAddress は viem のクライアントを持つので遅延 import しており、
// 画面がクラスだけを使えるように小さなモジュールに分ける。
export class ResolveAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveAddressError';
  }
}
