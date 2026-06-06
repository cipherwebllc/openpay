import { createConfig, createStorage, noopStorage } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
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

const connectors = [
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
          metadata: {
            name: 'OpenPay',
            description: 'Gasless QR payment for small merchants',
            url: typeof window !== 'undefined' ? window.location.origin : '',
            icons: [],
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
