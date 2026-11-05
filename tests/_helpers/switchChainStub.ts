import { useState } from 'react';

// wagmi の useSwitchChain の代わり (vi.mock('wagmi') の中で使う)。wagmi と同じく、切り替えの失敗は switchChain が
// 投げるのではなく、次の描画で error / variables に出る。`stub.error` を入れておくと、ボタンを押したとき
// (= switchChain を呼んだとき) にその error で失敗したことになる。null なら何も起きない (成功も失敗もしない)。
export type SwitchChainStub = {
  switchChain: (variables: { chainId: number }) => void;
  error: Error | null;
};

export function useSwitchChainStub(stub: SwitchChainStub) {
  const [state, setState] = useState<{
    error: Error | null;
    variables?: { chainId: number };
  }>({ error: null });
  return {
    switchChain: (variables: { chainId: number }) => {
      stub.switchChain(variables);
      if (stub.error) setState({ error: stub.error, variables });
    },
    isPending: false,
    ...state,
  };
}
