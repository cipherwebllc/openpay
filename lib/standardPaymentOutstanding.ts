// 通常決済 (hooks/useStandardPayment) がウォレットへ出したまま、結果 (hash・拒否・失敗) がまだ返っていない要求の登録簿。
// この tab の JS が生きている間だけ持つ (module の範囲・保存しない)。
//
// H-D (第 10 回レビュー・Codex の MUST): 復旧の印 (sessionStorage の 1 つの鍵) は同じタブの画面で共有するので、画面を離れた
// hook の要求 A が出たままの間に新しい画面で支払い B を始めると、遅れて解決した A の印が B の印を上書きし、A の receipt の
// 成功で印が消えて B の印は失われる (開き直すと B をもう一度払える)。同じタブの中では、結果の出ていない要求を同時に 1 つだけに
// する: 別の画面 (別の hook) の要求が出たままの間は、新しい支払いも利用料の送り直しも始めない。
// 断つ波及: 離れた画面の要求の結果による、新しい画面の支払いの印の上書き (= 開き直した画面からの二重の送金)。
// 読み直す・タブを閉じると消えるが、そのときは要求の結果を受け取る JS も消えるので、上書きする側もいない。

export type StandardWalletRequestKind = 'merchant' | 'fee';

// key は writeContract に渡した variables (試みごとに新しい object)。owner は要求を出した hook (1 つの画面)。
const outstanding = new Map<
  object,
  { owner: object; kind: StandardWalletRequestKind }
>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function addStandardWalletRequest(
  request: object,
  owner: object,
  kind: StandardWalletRequestKind,
): void {
  outstanding.set(request, { owner, kind });
  notify();
}

export function removeStandardWalletRequest(request: object): void {
  if (!outstanding.delete(request)) return;
  notify();
}

// owner 以外の hook が出したままの要求の種類 (最後に出したもの)。無ければ null。
export function standardWalletRequestElsewhere(
  owner: object,
): StandardWalletRequestKind | null {
  let kind: StandardWalletRequestKind | null = null;
  for (const entry of outstanding.values()) {
    if (entry.owner !== owner) kind = entry.kind;
  }
  return kind;
}

export function subscribeStandardWalletRequests(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
