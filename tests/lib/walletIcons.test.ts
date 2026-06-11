import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GENERIC_WALLET_ICON, walletIconSrc } from '@/lib/walletIcons';

describe('walletIconSrc', () => {
  it('EIP-6963 の connector.icon (data URI) を最優先で返す', () => {
    const dataUri = 'data:image/svg+xml;base64,PHN2Zy8+';
    expect(
      walletIconSrc({ id: 'io.metamask', name: 'MetaMask', icon: dataUri }),
    ).toBe(dataUri);
  });

  it.each([
    // [id, name, 期待ファイル] — id (rdns / SDK id) と name のどちらでも引けること
    ['io.metamask', 'MetaMask', 'MetaMask.svg'],
    ['metaMaskSDK', 'MetaMask', 'MetaMask.svg'],
    ['walletConnect', 'WalletConnect', 'walletConnectWallet.svg'],
    ['coinbaseWalletSDK', 'Coinbase Wallet', 'coinbaseWallet.svg'],
    ['app.phantom', 'Phantom', 'phantomWallet.svg'],
    ['io.rabby', 'Rabby Wallet', 'rabbyWallet.svg'],
    ['me.rainbow', 'Rainbow', 'rainbowWallet.svg'],
    ['com.brave.wallet', 'Brave Wallet', 'braveWallet.svg'],
    ['io.zerion.wallet', 'Zerion', 'zerionWallet.svg'],
    ['injected', 'Argent', 'argentWallet.svg'],
    ['app.backpack', 'Backpack', 'backpackWallet.svg'],
    ['com.binance.wallet', 'Binance Wallet', 'binanceWallet.svg'],
    ['injected', 'Ledger Live', 'ledgerWallet.svg'],
    ['com.roninchain.wallet', 'Ronin Wallet', 'roninWallet.svg'],
    ['injected', 'Taho', 'tahoWallet.svg'],
    ['injected', 'Best Wallet', 'bestWallet.svg'],
    ['app.core.extension', 'Core', 'coreWallet.svg'],
    ['global.safe', 'Safe{Wallet}', 'safeWallet.svg'],
  ])('id=%s name=%s → /wallets/%s', (id, name, file) => {
    expect(walletIconSrc({ id, name })).toBe(`/wallets/${file}`);
  });

  it('未知のウォレットは汎用アイコン (injectedWallet.svg) に倒す', () => {
    expect(walletIconSrc({ id: 'injected', name: 'Injected' })).toBe(
      GENERIC_WALLET_ICON,
    );
    expect(walletIconSrc({ id: 'xyz.unknown', name: 'Unknown Wallet' })).toBe(
      GENERIC_WALLET_ICON,
    );
  });

  it('id 欠落 (テスト/mock 由来) でも name だけで引ける', () => {
    expect(walletIconSrc({ name: 'MetaMask' })).toBe('/wallets/MetaMask.svg');
  });

  it('マッピング先のファイルが public/wallets/ に実在する (リンク切れフェンス)', () => {
    const files = new Set(readdirSync(join(process.cwd(), 'public', 'wallets')));
    // 全マッピングを踏む代表入力 + 汎用フォールバック
    const samples = [
      'MetaMask', 'WalletConnect', 'Coinbase Wallet', 'Phantom', 'Rabby Wallet',
      'Rainbow', 'Brave Wallet', 'Zerion', 'Argent', 'Backpack', 'Binance Wallet',
      'Ledger Live', 'Ronin Wallet', 'Taho', 'Best Wallet', 'Core', 'Safe{Wallet}',
      'Unknown',
    ];
    for (const name of samples) {
      const src = walletIconSrc({ name });
      const file = src.replace('/wallets/', '');
      expect(files.has(file), `${name} → ${src} が public/wallets/ に無い`).toBe(true);
    }
  });
});
