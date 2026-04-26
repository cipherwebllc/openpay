import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'OpenPay — Gasless QR Payment',
  description:
    '小規模店舗向け、ガス代ゼロ (ERC-4337 + Pimlico) で JPYC / USDC を受け取れる オープンソース決済 QR ジェネレーター。',
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
  return (
    <html lang="ja">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
