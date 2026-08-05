import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = 'https://open-pay.jp';
// フォールバック用 (locale 配下は app/[locale]/layout.tsx の generateMetadata が
// messages Meta namespace から上書きする)。文言は messages/ja.json Meta と同期。
const OG_TITLE = 'OpenPay｜JPYC店舗決済・モバイルオーダー（手数料0〜1%）';
const OG_DESCRIPTION =
  'OpenPayは、日本円ステーブルコインJPYC・USDC対応の店舗向け決済インフラ。QR決済からモバイルオーダー・受注・電子レシート・会計、AIエージェント決済まで手数料0〜1%。売上はウォレットへ直接着金（ノンカストディ）。導入費0円・契約不要・オープンソース。';

// Root layout は <html lang> を [locale]/layout に委譲する。ここでは
// メタデータと viewport だけ持ち、html/body は子で render させる。
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: OG_TITLE,
  description: OG_DESCRIPTION,
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
        // 総合版 OG (2026-08-05)。旧 og-image.png (店頭決済) は /guide/qr 等が使い続ける。
        url: '/og-home.webp',
        width: 1200,
        height: 630,
        alt: 'OpenPay — スマホひとつで、JPYCを支払いにも販売にも。QR決済・モバイルオーダー・デジタル商品販売',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: OG_TITLE,
    description: OG_DESCRIPTION,
    images: ['/og-home.webp'],
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
