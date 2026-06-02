// 共有 ConnectButton stub。実 ConnectButton (components/ConnectButton.tsx) は jsdom で
// 重い wagmi/connector module graph を render 評価し、worker OOM を起こす
// (詳細 memory:paymentform-oom-rootcause)。form/container test の対象は PaymentForm 等の
// ロジックなので、ConnectButton を軽量 stub に差し替えて OOM を回避する。
//
// ⚠️ global mock (tests/setup.ts) にはしないこと: ConnectButton.test.tsx が実コンポーネントを
//    import して接続/未接続挙動を検証している (tests/components/ConnectButton.test.tsx) ため、
//    global に差し替えるとその検証が壊れる。各 form/container test で個別に vi.mock する:
//
//      vi.mock('@/components/ConnectButton', async () => ({
//        ConnectButton: (await import('../_helpers/connectButtonStub')).ConnectButtonStub,
//      }));
//
//    (async factory + dynamic import = vi.mock の hoisting で top-level import を参照する
//     問題を避ける標準パターン。SUT import より前に評価される。)
//
// accessible name は送信ボタンの「ウォレット接続」系 label と衝突させない (Codex 指摘)。
// presence を assert する test 用に中立な testid だけ持たせる (button role は付けない)。
export function ConnectButtonStub() {
  return <div data-testid="connect-button" />;
}
