import type { Metadata, Viewport } from 'next';
import './globals.css';

// Root layout は <html lang> を [locale]/layout に委譲する。ここでは
// メタデータと viewport だけ持ち、html/body は子で render させる。
export const metadata: Metadata = {
  title: 'OpenPay — Gasless QR Payment & Tip Widget',
  description:
    'Gasless (ERC-4337 + Pimlico) JPYC / USDC payments and tip widgets, open source.',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
  appleWebApp: {
    capable: true,
    title: 'OpenPay',
    statusBarStyle: 'default',
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
