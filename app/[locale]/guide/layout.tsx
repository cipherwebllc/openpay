// このルート配下の client component が使う messages だけを inline する
// (namespace 一覧は i18n/clientNamespaces.ts が単一情報源)。
// /guide (ハブ) のための layout。/guide/* 10 本の親にもなるが、子の layout が自分の RouteMessages で
// 置き換えるので見た目・client JS は変わらない (入れ子の provider の HTML 増は約 0.4 KB・前例は store と order)。
// setRequestLocale は入れ子 layout でも必須。省略すると getMessages() が headers()
// 経由になり、このルートが静的プリレンダリングから外れて毎リクエスト SSR になる。
import { setRequestLocale } from 'next-intl/server';
import { RouteMessages } from '@/i18n/RouteMessages';

export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <RouteMessages route="guide">{children}</RouteMessages>;
}
