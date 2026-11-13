import jaMessages from '../../messages/ja.json';
import enMessages from '../../messages/en.json';

// Circle の経路 (USDC ガスレス) の error を、3 つのフォーム (PaymentForm・CheckoutForm・TipForm) がどう出すかの test で
// 共通に使う (第 10 回レビュー PR-39c)。フォームは error の `circleCode` (場面の符号) だけを見て、messages の
// CircleErrors の文を出す。class は見ないので、ここでは符号を付けただけの Error を使う (本物の class が符号を持つことは
// tests/lib/circleErrorKey.test.ts と tests/lib/smartAccount/circleSend.test.ts)。

/** [場面の符号, messages の CircleErrors の key] */
export const CIRCLE_ERROR_CASES = [
  ['unconfirmed', 'unconfirmed'],
  ['busy_elsewhere', 'busyElsewhere'],
  ['attempt_ended', 'attemptEnded'],
  ['send_rejected', 'sendRejected'],
  ['unconfirmed_earlier', 'unconfirmedEarlier'],
  ['mapping_unavailable', 'mappingUnavailable'],
] as const;

export const CIRCLE_ERRORS_JA = jaMessages.CircleErrors;
export const CIRCLE_ERRORS_EN = enMessages.CircleErrors;

/** 画面に出てはいけない方の文 (符号があるとき、message は出さない)。 */
export const RAW_ERROR_MESSAGE = 'raw-message-of-the-error';

export function codedError(circleCode: string, message: string = RAW_ERROR_MESSAGE): Error {
  return Object.assign(new Error(message), { circleCode });
}
