import { describe, it, expect } from 'vitest';
import {
  resolvePaymentRoute,
  isStandardRoute,
  isRelayRoute,
  isRecoverRoute,
  isCircleRoute,
  type PaymentRoute,
  type PaymentRouteInput,
} from '@/lib/paymentRoute';
import type { JpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import type { UsdcGaslessProvider } from '@/lib/circlePaymaster';

// resolvePaymentRoute は現行 CheckoutForm の経路判定をそのまま再現する純関数。Phase 1 の他段
// (PaymentForm/TipForm/money 計算純関数化) の **錨** になるため、入力空間を網羅した真理値表で
// 「token × gasMode 相当 (provider) × flag 相当 (provider/forwarder) × chain 相当 (provider)」の
// 全組合せに対し route と派生 boolean を固定する。経路追加時はこの表に行を足す。
//
// 注: 経路解決の env/chain 依存は resolveJpycGaslessProvider / resolveUsdcGaslessProvider /
// jpycForwarderFor が持ち (それぞれ単体テスト済)、本関数はその **解決済み結果** を受けるだけ。
// よって入力は 4 軸の直積 = 2(isStandard) × 2(jpyc) × 2(usdc) × 2(forwarder) = 16 通り。

const JPYC_PROVIDERS: readonly JpycGaslessProvider[] = [
  'pimlico-7702',
  'eip3009-relay',
];
const USDC_PROVIDERS: readonly UsdcGaslessProvider[] = ['pimlico', 'circle'];
const BOOLS: readonly boolean[] = [false, true];

// 入力 → 期待 route を、CheckoutForm の現行ロジックとは独立に「素朴に」決める参照実装。
// (resolvePaymentRoute と式が一致するのは当然だが、ここは優先順位を人間可読に明記した
//  別系統の期待値生成器として置き、両者が全 16 通りで一致することを確認する。)
function expectedRoute(input: PaymentRouteInput): PaymentRoute {
  // 1. standard は最優先 (現行 useRelay / isCircle は両方 !isStandard で gate)。
  if (input.isStandard) return { kind: 'standard' };
  // 2. 非 standard かつ JPYC relay 解決 → relay。recover は forwarder 有無。
  if (input.jpycGaslessProvider === 'eip3009-relay') {
    return { kind: 'relay', recover: input.hasJpycForwarder };
  }
  // 3. 非 standard かつ非 relay かつ USDC circle 解決 → gasless/circle。
  if (input.usdcGaslessProvider === 'circle') {
    return { kind: 'gasless', provider: 'circle' };
  }
  // 4. それ以外 → gasless/pimlico。
  return { kind: 'gasless', provider: 'pimlico' };
}

describe('resolvePaymentRoute — 真理値表 (16 通り全網羅)', () => {
  const cases: PaymentRouteInput[] = [];
  for (const isStandard of BOOLS) {
    for (const jpycGaslessProvider of JPYC_PROVIDERS) {
      for (const usdcGaslessProvider of USDC_PROVIDERS) {
        for (const hasJpycForwarder of BOOLS) {
          cases.push({
            isStandard,
            jpycGaslessProvider,
            usdcGaslessProvider,
            hasJpycForwarder,
          });
        }
      }
    }
  }

  it('全 16 組合せを生成している (網羅性の自己検査)', () => {
    expect(cases).toHaveLength(16);
  });

  for (const input of cases) {
    const label =
      `isStandard=${input.isStandard} ` +
      `jpyc=${input.jpycGaslessProvider} ` +
      `usdc=${input.usdcGaslessProvider} ` +
      `forwarder=${input.hasJpycForwarder}`;

    it(`route + 派生 boolean: ${label}`, () => {
      const route = resolvePaymentRoute(input);
      const want = expectedRoute(input);
      expect(route).toEqual(want);

      // 派生ヘルパが現行 CheckoutForm の boolean と一致することを固定:
      //   isStandard = route.kind==='standard'
      //   useRelay   = route.kind==='relay'
      //   useRecover = relay かつ recover
      //   isCircle   = gasless かつ provider==='circle'
      expect(isStandardRoute(route)).toBe(want.kind === 'standard');
      expect(isRelayRoute(route)).toBe(want.kind === 'relay');
      expect(isRecoverRoute(route)).toBe(
        want.kind === 'relay' && want.recover,
      );
      expect(isCircleRoute(route)).toBe(
        want.kind === 'gasless' && want.provider === 'circle',
      );

      // 排他性: 4 経路 boolean のうち「standard / relay / gasless」は同時に複数 true に
      // ならない (kind は 1 つ)。recover は relay の部分集合、circle は gasless の部分集合。
      const kinds = [
        isStandardRoute(route),
        isRelayRoute(route),
        route.kind === 'gasless',
      ].filter(Boolean);
      expect(kinds).toHaveLength(1);
    });
  }
});

describe('resolvePaymentRoute — 経路ごとの代表例 (現行 CheckoutForm 対応)', () => {
  it('standard: mode=standard / SA fallback override (他軸は無視される)', () => {
    // 非 standard 軸がどう転んでも standard が最優先。
    expect(
      resolvePaymentRoute({
        isStandard: true,
        jpycGaslessProvider: 'eip3009-relay',
        usdcGaslessProvider: 'circle',
        hasJpycForwarder: true,
      }),
    ).toEqual({ kind: 'standard' });
  });

  it('relay free: JPYC relay 解決 + forwarder 無し (OpenPay がガス負担)', () => {
    expect(
      resolvePaymentRoute({
        isStandard: false,
        jpycGaslessProvider: 'eip3009-relay',
        usdcGaslessProvider: 'pimlico',
        hasJpycForwarder: false,
      }),
    ).toEqual({ kind: 'relay', recover: false });
  });

  it('relay recover: JPYC relay 解決 + forwarder 設定済み (gas 相当額を回収)', () => {
    expect(
      resolvePaymentRoute({
        isStandard: false,
        jpycGaslessProvider: 'eip3009-relay',
        usdcGaslessProvider: 'pimlico',
        hasJpycForwarder: true,
      }),
    ).toEqual({ kind: 'relay', recover: true });
  });

  it('gasless/circle: 非 relay かつ USDC circle 解決', () => {
    expect(
      resolvePaymentRoute({
        isStandard: false,
        jpycGaslessProvider: 'pimlico-7702',
        usdcGaslessProvider: 'circle',
        hasJpycForwarder: false,
      }),
    ).toEqual({ kind: 'gasless', provider: 'circle' });
  });

  it('gasless/pimlico: 従来の Pimlico erc20 / sponsorship (relay でも circle でもない)', () => {
    expect(
      resolvePaymentRoute({
        isStandard: false,
        jpycGaslessProvider: 'pimlico-7702',
        usdcGaslessProvider: 'pimlico',
        hasJpycForwarder: false,
      }),
    ).toEqual({ kind: 'gasless', provider: 'pimlico' });
  });

  it('relay は circle より優先: JPYC relay 解決時は forwarder/usdc 軸に関わらず relay (現行 useRelay が isCircle を実質排他)', () => {
    // 現行 CheckoutForm では isCircle = !isStandard && usdcProvider==='circle' で useRelay と
    // 独立だが、JPYC deployment では usdcProvider が常に 'pimlico'、USDC deployment では
    // jpycProvider が常に 'pimlico-7702' になるため実際には排他。本関数は relay を先に評価し、
    // 万一両軸が同時に立っても relay に倒す (token が両者を満たすことは production で起きない)。
    const route = resolvePaymentRoute({
      isStandard: false,
      jpycGaslessProvider: 'eip3009-relay',
      usdcGaslessProvider: 'circle',
      hasJpycForwarder: false,
    });
    expect(route).toEqual({ kind: 'relay', recover: false });
    expect(isCircleRoute(route)).toBe(false);
  });
});

describe('resolvePaymentRoute — disableRelay (PaymentForm の split 専用ガード)', () => {
  // disableRelay は PaymentForm の `useRelay = !isStandard && !hasSplit && ...` の `!hasSplit` に対応。
  // split 決済では relay (Phase 1 単発のみ) を抑止し、JPYC は非 relay の Pimlico 経路 (USDC provider は
  // JPYC で常に 'pimlico')、USDC は circle 判定不変 (現行 isCircle は split を gate しない) になる。
  // CheckoutForm は split 非対応で disableRelay を渡さない (省略 = false = relay 抑止なし)。

  it('省略時は relay 抑止なし (CheckoutForm 現行挙動): JPYC relay 解決 → relay', () => {
    expect(
      resolvePaymentRoute({
        isStandard: false,
        jpycGaslessProvider: 'eip3009-relay',
        usdcGaslessProvider: 'pimlico',
        hasJpycForwarder: false,
      }),
    ).toEqual({ kind: 'relay', recover: false });
  });

  it('disableRelay=false は省略と同値 (relay 解決 → relay)', () => {
    expect(
      resolvePaymentRoute({
        isStandard: false,
        jpycGaslessProvider: 'eip3009-relay',
        usdcGaslessProvider: 'pimlico',
        hasJpycForwarder: true,
        disableRelay: false,
      }),
    ).toEqual({ kind: 'relay', recover: true });
  });

  it('JPYC split (disableRelay=true): relay 抑止 → gasless/pimlico (USDC provider は JPYC で常に pimlico)', () => {
    expect(
      resolvePaymentRoute({
        isStandard: false,
        jpycGaslessProvider: 'eip3009-relay',
        usdcGaslessProvider: 'pimlico',
        hasJpycForwarder: true,
        disableRelay: true,
      }),
    ).toEqual({ kind: 'gasless', provider: 'pimlico' });
  });

  it('USDC split + circle (disableRelay=true): relay は元々非成立なので circle 判定は不変', () => {
    // USDC deployment では jpycProvider が常に 'pimlico-7702' で relay にならないため、
    // disableRelay の有無に関わらず circle に倒れる (現行 PaymentForm の isCircle が split を gate
    // しないのと一致)。
    const route = resolvePaymentRoute({
      isStandard: false,
      jpycGaslessProvider: 'pimlico-7702',
      usdcGaslessProvider: 'circle',
      hasJpycForwarder: false,
      disableRelay: true,
    });
    expect(route).toEqual({ kind: 'gasless', provider: 'circle' });
    expect(isCircleRoute(route)).toBe(true);
  });

  it('standard は disableRelay より優先 (standard 最優先は不変)', () => {
    expect(
      resolvePaymentRoute({
        isStandard: true,
        jpycGaslessProvider: 'eip3009-relay',
        usdcGaslessProvider: 'pimlico',
        hasJpycForwarder: true,
        disableRelay: true,
      }),
    ).toEqual({ kind: 'standard' });
  });
});
