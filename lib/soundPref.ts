// 決済完了音の ON/OFF 設定 (localStorage 永続・既定 ON)。
// storage 不可環境 (SNS アプリ内ブラウザ / プライベート設定 / sandboxed iframe) でも
// throw しないよう全アクセスを try/catch で包む (lib/wagmi の guardedLocalStorage と同方針)。

const KEY = 'openpay:success-sound';

/** 完了音が有効か。既定 ON ('0' が明示保存されている時のみ OFF)。 */
export function isSuccessSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/** 完了音の ON/OFF を永続化。失敗 (storage 不可) は黙って諦める。 */
export function setSuccessSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(KEY, enabled ? '1' : '0');
  } catch {
    /* noop: 永続化を諦める (その session 内は state 保持) */
  }
}
