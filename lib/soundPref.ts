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

// ── 受注フルフィルメント (厨房/ホール) の「新着注文」アラート音設定 ──────────────
// 決済完了音 (既定 ON) と違い **既定 OFF (明示オプトイン)**。理由: ブラウザの自動再生
// ポリシー上、ユーザー操作なしでは鳴らせない → 店員がボタンで明示 ON にした瞬間
// (= user gesture) に AudioContext を解錠する設計が確実。'1' のときだけ ON。
const ORDER_ALERT_KEY = 'openpay:order-alert-sound';

/** 新着注文アラート音が有効か。既定 OFF ('1' が明示保存されている時のみ ON)。 */
export function isOrderAlertSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ORDER_ALERT_KEY) === '1';
  } catch {
    return false;
  }
}

/** 新着注文アラート音の ON/OFF を永続化。失敗 (storage 不可) は黙って諦める。 */
export function setOrderAlertSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(ORDER_ALERT_KEY, enabled ? '1' : '0');
  } catch {
    /* noop: 永続化を諦める (その session 内は state 保持) */
  }
}
