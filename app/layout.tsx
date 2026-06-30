import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = 'https://open-pay.jp';
const OG_TITLE =
  'OpenPay — ウォレットアドレス 1 つで始める、店舗向けガスレス決済 QR';
const OG_DESCRIPTION =
  'JPYC・USDC 対応の QR 決済・モバイルオーダーを、かんたんに導入。実店舗・イベントから AI エージェントの課金まで、オープンな決済インフラを提供します。';

// Root layout は <html lang> を [locale]/layout に委譲する。ここでは
// メタデータと viewport だけ持ち、html/body は子で render させる。
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'OpenPay — Gasless QR Payment & Tip Widget',
  description:
    'Gasless (ERC-4337 + Pimlico) JPYC / USDC payments and tip widgets, open source.',
  icons: {
    icon: [{ url: '/icon-512.png', type: 'image/png', sizes: '512x512' }],
    apple: [{ url: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' }],
  },
  appleWebApp: {
    capable: true,
    title: 'OpenPay',
    statusBarStyle: 'default',
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'OpenPay',
    title: OG_TITLE,
    description: OG_DESCRIPTION,
    locale: 'ja_JP',
    alternateLocale: ['en_US'],
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'OpenPay — ウォレットアドレス 1 つで始める、店舗向けガスレス決済 QR',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: OG_TITLE,
    description: OG_DESCRIPTION,
    images: ['/og-image.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1e3a8a',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
