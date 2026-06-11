// ウォレットアプリ誘導のディープリンク + モバイル platform 判定の純関数群。
// ConnectButton.tsx (WC しか出ないモバイルで MetaMask アプリ内ブラウザへ誘導) と
// PwaInstallHint.tsx (iOS/Android 別のインストール手順) が共有する。
// SSR 安全は呼出側責務 (引数で loc を受ける / platform 判定は client effect 後)。

// ウォレットアプリ (MetaMask) の in-app ブラウザで現在ページを開くディープリンク。
// モバイルの通常ブラウザでは injected provider が無く接続できないことが多いため、
// ウォレットアプリへ誘導する (metamask.app.link/dapp/<host+path+search>)。
// MetaMask アプリ内で開けば origin が実 URL (Verify 登録済) になり、WalletConnect
// 経由で 64 桁ハッシュが要求元になる場合の Blockaid 警告を構造的に回避できる。
export function metamaskDappLink(loc: {
  host: string;
  pathname: string;
  search: string;
}): string {
  return `https://metamask.app.link/dapp/${loc.host}${loc.pathname}${loc.search}`;
}

export type MobilePlatform = 'ios' | 'android' | 'other';

// モバイル platform を UA + maxTouchPoints から判定する。
// iPad は iPadOS 13+ で「Mac 風 UA」を返すので UA だけでは見分け不可。
// navigator.maxTouchPoints が iPadOS 公式推奨の判別シグナル (Safari/iPadOS では
// 5 を返し、純デスクトップ Mac では 0)。`'ontouchend' in document` は
// GlobalEventHandlers 由来で多くの環境で常に true を返すため当てにならない。
export function detectMobilePlatform(): MobilePlatform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  const maxTouch = navigator.maxTouchPoints ?? 0;
  const isIpad = /Macintosh/.test(ua) && maxTouch > 1;
  if (/iPhone|iPod/.test(ua) || isIpad) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

// ios || android のショートカット (誘導 UI の表示条件で使う)。
export function isMobilePlatform(): boolean {
  const p = detectMobilePlatform();
  return p === 'ios' || p === 'android';
}
