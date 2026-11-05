import { useState } from 'react';

// wagmi の useSwitchChain の代わり (vi.mock('wagmi') の中で使う)。本物 (TanStack の mutation) と同じく、
// switchChain を呼ぶと pending になって前回の error を消し (error: null・variables は今回のもの)、結果が出たら
// pending を戻して error を入れる (成功なら null)。失敗は switchChain が投げるのではなく error に出る。
//   - `error`: 次に呼んだときの結果 (Error = 失敗・null = 成功)。
//   - `hold`: true なら結果を出さずに pending のまま止める。テストから `release()` を呼ぶと、その時点の
//     `error` で終える (act の中で呼ぶ)。
//   - `hold` が false なら、呼んだその場で結果まで進む (押した描画で結果が見える)。
export type SwitchChainStub = {
  switchChain: (variables: { chainId: number }) => void;
  error: Error | null;
  hold: boolean;
  release: () => void;
};

type SwitchState = {
  isPending: boolean;
  error: Error | null;
  variables?: { chainId: number };
};

export function useSwitchChainStub(stub: SwitchChainStub) {
  const [state, setState] = useState<SwitchState>({ isPending: false, error: null });
  return {
    switchChain: (variables: { chainId: number }) => {
      stub.switchChain(variables);
      setState({ isPending: true, error: null, variables });
      const finish = () => setState({ isPending: false, error: stub.error, variables });
      if (stub.hold) stub.release = finish;
      else finish();
    },
    ...state,
  };
}
