import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OpenPay',
    short_name: 'OpenPay',
    description:
      'ウォレットアドレス 1 つで導入できる、ガスレス決済 QR & Tip widget。',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#1e3a8a',
    lang: 'ja',
    icons: [
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    categories: ['finance', 'business', 'productivity'],
    // PWA shortcuts: icon long-press / context menu から /scan へ直行できる。
    // 仕様上 Android Chrome は反映、iOS Safari は無視 (Safari は icon コンテキスト
    // メニューに shortcut を出さない)。ja を default url にしているのは next-intl
    // の Accept-Language detection に任せると localePrefix=always で常に redirect が
    // 入るため、最初から /ja/scan を打って 1 ホップ削る目的。
    shortcuts: [
      {
        name: 'スキャンして支払う',
        short_name: 'スキャン',
        description:
          '事前接続済みのウォレットで、店舗 QR を読んで即決済する',
        url: '/ja/scan',
        icons: [
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    ],
  };
}
