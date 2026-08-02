import { createConfig, createStorage, noopStorage } from 'wagmi';
import { coinbaseWallet, injected, mock, walletConnect } from 'wagmi/connectors';
import { supportedChains, transportForChain } from './chains';
import { env } from './env';

// localStorage 自体に触れない環境 (SNS のアプリ内ブラウザ・「サイトデータをブロック」設定・
// sandboxed iframe など) では `window.localStorage` プロパティアクセス自体が SecurityError を
// 投げる。wagmi のデフォルト getDefaultStorage は条件式で `window.localStorage` を直接参照する
// ため、そこで throw → WagmiProvider のハイドレーション全体がクラッシュし白画面になる
// (Sentry: "Failed to read the 'localStorage' property from 'Window': Access is denied")。
// 各操作を try/catch で吸収し、使えなければ永続化だけ諦める (決済 UI 自体は動かす)。
// テスト可能なように export する。
export function guardedLocalStorage() {
  return {
    getItem(key: string): string | null {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage 利用不可: 永続化を諦める (接続情報は次回再接続で復元) */
      }
    },
    removeItem(key: string): void {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* noop */
      }
    },
  };
}

// transport は transportForChain に集約 (mainnet/sepolia は公開 fallback 列で
// viem default の eth.merkle.io 依存を回避、他 chain は custom RPC or default)。
const transports = Object.fromEntries(
  supportedChains.map((c) => [c.id, transportForChain(c.id)]),
);

// 接続後 UI の実機スクショ検証用 mock ウォレット (受取ページ磨き上げ P4)。
// 二重ガード: production ビルドでは NODE_ENV 条件が build 時に false 確定して
// dead code elimination で消える (本番バンドルに含まれない)。開発ビルドでも
// env opt-in が無ければ出ない (誤有効化のまま検証する事故を防ぐ)。
// アドレスは hardhat/anvil 既知のテストアカウント #0 (秘密鍵公知・資産を置かない)。
const enableMockWallet =
  process.env.NODE_ENV !== 'production' &&
  process.env.NEXT_PUBLIC_ENABLE_MOCK_WALLET === '1';

const connectors = [
  ...(enableMockWallet
    ? [mock({ accounts: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'] })]
    : []),
  injected(),
  injected({ target: 'rabby' }),
  coinbaseWallet({
    appName: 'OpenPay',
    preference: 'all',
  }),
  // walletConnect() は projectId 必須のため未設定時は除外
  ...(env.wcProjectId
    ? [
        walletConnect({
          projectId: env.wcProjectId,
          showQrModal: true,
          // metadata はウォレット側の「要求元」表示と Reown Verify API のドメイン照合に使われる。
          // url が空/不一致・icons が空だと未検証扱いになり、Blockaid の deceptive 判定
          // (要求元がハッシュ表示・赤警告) を誘発する一因になる (plans/sign-reassurance-ux.md §9)。
          // url は実 origin (preview/local も自分の origin)・SSR 評価時のみ canonical へ fallback。
          metadata: {
            name: 'OpenPay',
            description: 'Gasless QR payment for small merchants',
            url:
              typeof window !== 'undefined'
                ? window.location.origin
                : 'https://open-pay.jp',
            icons: ['https://open-pay.jp/icon-512.png'],
          },
        }),
      ]
    : []),
];

export const wagmiConfig = createConfig({
  chains: supportedChains,
  connectors,
  transports,
  ssr: true,
  // server では window 不在のため noopStorage、client では localStorage を
  // try/catch で包んだ storage (ブロック環境でのハイドレーションクラッシュを防ぐ)。
  storage: createStorage({
    storage: typeof window === 'undefined' ? noopStorage : guardedLocalStorage(),
  }),
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
