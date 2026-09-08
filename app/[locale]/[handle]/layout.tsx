// このルート配下の client component が使う messages だけを inline する
// (namespace 一覧は i18n/clientNamespaces.ts が単一情報源)。
// setRequestLocale は入れ子 layout でも必須。省略すると getMessages() が headers()
// 経由になり、このルートが静的プリレンダリングから外れて毎リクエスト SSR になる。
import { setRequestLocale } from 'next-intl/server';
import { RouteMessages } from '@/i18n/RouteMessages';

// 公開プロフィールはリクエスト時に KV を読む。page の export は画面・metadata のみにする。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <RouteMessages route="[handle]">{children}</RouteMessages>;
}
