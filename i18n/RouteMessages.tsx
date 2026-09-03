// ルートごとの <NextIntlClientProvider>。各 route segment の layout.tsx から
// `<RouteMessages route="create">` の形で使う (route key = app/[locale] からの相対ディレクトリ)。
//
// nested な IntlProvider は messages を **マージせず置き換える** (use-intl の実装) ため、
// locale layout が配る SHARED_CLIENT_NAMESPACES もここで合わせて渡す。
import { NextIntlClientProvider } from 'next-intl';
import { clientMessagesFor } from './clientMessages';
import {
  ROUTE_CLIENT_NAMESPACES,
  SHARED_CLIENT_NAMESPACES,
  type ClientRoute,
} from './clientNamespaces';

export async function RouteMessages({
  route,
  children,
}: {
  route: ClientRoute;
  children: React.ReactNode;
}) {
  const messages = await clientMessagesFor([
    ...SHARED_CLIENT_NAMESPACES,
    ...ROUTE_CLIENT_NAMESPACES[route],
  ]);
  return (
    <NextIntlClientProvider messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
