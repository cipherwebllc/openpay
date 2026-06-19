// 受注閲覧トークンの localStorage 永続 (店員端末で ?t=<token> を一度開けば、再訪でリンク無しでも保持)。
// storage 不可環境 (SNS 内ブラウザ / プライベート / sandboxed iframe) でも throw しないよう全アクセスを
// try/catch で包む (lib/soundPref と同方針)。サーバ側の認可は別途 feed route が検証する。

const KEY = 'openpay:order-token';

/** 保存済みトークン。未保存/storage 不可は null。 */
export function getStoredOrderToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** トークンを永続化 (店員端末で ?t= を開いた時)。失敗は黙って諦める (その session 内は state 保持)。 */
export function setStoredOrderToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    /* noop */
  }
}

/** 保存トークンを破棄 (失効時の手動クリア用)。 */
export function clearStoredOrderToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
