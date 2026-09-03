// client へ渡す messages を namespace 単位で絞り込むためのサーバ側ヘルパ。
//
// next-intl の <NextIntlClientProvider> は messages を省略すると全量
// (messages/ja.json = 71 namespace) を RSC payload に載せ、そのまま HTML に inline する。
// 実際に client component が使うのはページごとに数 namespace なので、ここで pick する。
//
// 対応する namespace 一覧は i18n/clientNamespaces.ts が単一情報源。
import { getMessages } from 'next-intl/server';

type Messages = Record<string, unknown>;

/** messages から指定 namespace だけを取り出す (存在しないキーは無視する)。 */
export function pickNamespaces(
  messages: Messages,
  namespaces: readonly string[],
): Messages {
  const picked: Messages = {};
  for (const namespace of namespaces) {
    if (namespace in messages) picked[namespace] = messages[namespace];
  }
  return picked;
}

/** 現在の request locale の messages から指定 namespace だけを取り出す。 */
export async function clientMessagesFor(namespaces: readonly string[]) {
  const messages = (await getMessages()) as Messages;
  return pickNamespaces(messages, namespaces);
}
