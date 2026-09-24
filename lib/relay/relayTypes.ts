// Shared relay outcomes; no runtime dependency on either public relay entry point.
import type { Hex } from 'viem';

// submit 済 tx の最終状態。'pending' は「broadcast 済だが確定待ち」(timeout 等)。
// 重要: broadcast 後の不確定は 'error' ではなく 'pending' を返す。'error' は client を
// standard mode に fallback させるため、tx が後で確定すると二重支払いになる (Codex #4)。
export type RelayTaskOutcome =
  | { state: 'success'; txHash: Hex }
  | { state: 'reverted'; txHash?: Hex }
  // broadcast 済 or broadcast 不確定 (Gelato timeout 等)。txHash は分かれば同梱・無ければ省略。
  | { state: 'pending'; txHash?: Hex }
  // broadcast されなかったことが確実な失敗のみ (Gelato Cancelled/Blacklisted/NotFound)。
  // client は standard へ fallback 可。timeout 等の不確定は 'pending' を使うこと。
  | { state: 'error'; detail: string };

export type RelayResult =
  | { kind: 'success'; txHash: Hex }
  | { kind: 'reverted'; txHash?: Hex }
  // broadcast 済だが未確定 (確認待ち)。client は standard へ fallback してはならない
  // (二重支払い防止)。txHash があれば追跡可能、authorizationState 既使用時は無し。
  | { kind: 'pending'; txHash?: Hex }
  // pre-submit に弾いた (検証/残高/rate-limit)。httpStatus + 理由コード。
  | { kind: 'rejected'; httpStatus: number; reason: string }
  // submit "前" のエラー (検証通過後〜broadcast 前: 残高 race / RPC / 資金不足)。tx は
  // 出ていないので client は安全に fallback 可。broadcast 後は使わない (pending を使う)。
  | { kind: 'relay_error'; detail: string };
