// 払う側の通常決済の送金に会計の印を付ける「その端末だけの試しのスイッチ」(K4b・2026-11-18 運営者の裁定)。
// 印を付けるのは、このスイッチが ON のブラウザ (端末) だけ。既定は OFF で、OFF の支払いは今までと 1 byte も変わらない
// (ウォレットへ送る calldata・保存する intent・登録簿)。実機で試して問題がなければ、全員に付ける別の変更でこのスイッチを外す。
//
// 入れ方: マイページを `?stdmark=on` で開くと ON・`?stdmark=off` で OFF。書くのは components/StdBillMarkTrialSwitch.tsx だけ
// (書く関数をここに置かない = 支払いの画面の bundle に載せない)。読むのは、支払いの画面の印の準備 (hooks/useStdBillMark.ts) と、
// マイページの 1 行の表示。
//
// 保存は localStorage の key 1 つ ('1' のときだけ ON)。読み書きは try-catch で包む (lib/soundPref.ts と同じ形・掟 13):
// 保存の使えないブラウザ (アプリ内ブラウザ・プライベート設定・sandbox の iframe) でも throw せず、読めなければ OFF。
// 断つ波及: ブラウザの保存の失敗で、支払いの画面とマイページが止まること。

export const STD_BILL_MARK_TRIAL_KEY = 'openpay:std-bill-mark-trial:v1';

/** この端末で試しのスイッチが ON か。既定 OFF ('1' が保存されているときだけ ON・読めなければ OFF)。 */
export function isStdBillMarkTrialOn(): boolean {
  try {
    return window.localStorage.getItem(STD_BILL_MARK_TRIAL_KEY) === '1';
  } catch {
    return false;
  }
}
