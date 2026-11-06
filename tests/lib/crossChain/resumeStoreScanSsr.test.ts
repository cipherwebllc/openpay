// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readResumeStateForScan } from '@/lib/crossChain/resumeStore';

// A-1: SSR (window が無い) は描画だけで決済が起きないので「記録なし」。ブラウザでの storage の取得拒否
// (「読めない」= ロック) とは区別する (jsdom 側は resumeStore.test.ts)。
describe('readResumeStateForScan on the server', () => {
  it('reports no record when there is no window', () => {
    expect(typeof window).toBe('undefined');
    expect(readResumeStateForScan({
      account: '0x1111111111111111111111111111111111111111', kind: 'cctp-v2', sourceChainId: 84532,
      destChainId: 80002, recipient: '0x2222222222222222222222222222222222222222', valueAtomic: 1n, feeAtomic: 0n,
    })).toEqual({ kind: 'absent' });
  });
});
