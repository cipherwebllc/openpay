import { http, createConfig } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { customRpcUrlForChain, supportedChains } from './chains';
import { env } from './env';

const transports = Object.fromEntries(
  supportedChains.map((c) => {
    const url = customRpcUrlForChain(c.id);
    return [c.id, url ? http(url) : http()];
  }),
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
            url:
              typeof window !== 'undefined'
                ? window.location.origin
                : 'https://openpay.local',
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
