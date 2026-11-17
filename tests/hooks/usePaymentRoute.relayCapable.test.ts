// hooks/usePaymentRoute.ts の relayCapable: 通常決済を求められていなければ relay の経路になるか。ガスレスで払えないウォレットの
// 見分け (hooks/useGaslessUnsupportedWallet.ts) の enabled にだけ使い、通常決済に切り替えた後も同じ口座の結果を保つ。
// 経路 (route・isStandard・useRelay) は変えない。USDC・split (disableRelay)・relay の無いチェーンでは false (余計に読まない)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const providers = vi.hoisted(() => ({
  jpyc: 'eip3009-relay' as 'eip3009-relay' | 'pimlico-7702',
  usdc: 'pimlico' as 'pimlico' | 'circle',
}));
vi.mock('@/lib/jpycGaslessProvider', () => ({ resolveJpycGaslessProvider: () => providers.jpyc }));
vi.mock('@/lib/circlePaymaster', () => ({ resolveUsdcGaslessProvider: () => providers.usdc }));
vi.mock('@/lib/relay/forwarderConfig', () => ({ jpycForwarderFor: () => null }));

import { usePaymentRoute } from '@/hooks/usePaymentRoute';
import type { TokenDeployment } from '@/lib/tokens';

const deployment = { chainId: 137, symbol: 'jpyc' } as unknown as TokenDeployment;
const route = (args: { standardRequested?: boolean; disableRelay?: boolean } = {}) =>
  renderHook(() =>
    usePaymentRoute({
      deployment,
      walletChainId: 137,
      standardRequested: args.standardRequested ?? false,
      disableRelay: args.disableRelay ?? false,
      pinnedRoute: null,
    }),
  ).result.current;

beforeEach(() => {
  providers.jpyc = 'eip3009-relay';
  providers.usdc = 'pimlico';
});

describe('usePaymentRoute の relayCapable', () => {
  it('JPYC の relay の経路: ガスレスでも通常決済でも true (経路は今までどおり)', () => {
    expect(route()).toMatchObject({ useRelay: true, isStandard: false, relayCapable: true });
    expect(route({ standardRequested: true })).toMatchObject({ useRelay: false, isStandard: true, relayCapable: true });
  });

  it('split (disableRelay) は false', () => {
    expect(route({ disableRelay: true })).toMatchObject({ useRelay: false, relayCapable: false });
    expect(route({ disableRelay: true, standardRequested: true })).toMatchObject({ relayCapable: false });
  });

  it('relay の無い経路 (USDC・relay の無いチェーン・flag OFF) は false', () => {
    providers.jpyc = 'pimlico-7702';
    expect(route()).toMatchObject({ useRelay: false, relayCapable: false });
    expect(route({ standardRequested: true })).toMatchObject({ relayCapable: false });
    providers.usdc = 'circle';
    expect(route()).toMatchObject({ isCircle: true, relayCapable: false });
  });
});
