import { createConfig } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { supportedChains, transportForChain } from './chains';
import { env } from './env';

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
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
