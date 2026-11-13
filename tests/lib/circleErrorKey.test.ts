import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import jaMessages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';
import { circleErrorKey, type CircleErrorCode, type CircleErrorKey } from '@/lib/circleErrorKey';
import { CirclePendingError, CircleSendRejectedError } from '@/lib/smartAccount/circleSend';

// Circle の経路 (USDC ガスレス) の error の「場面の符号」→ 案内の文 (messages の CircleErrors) (第 10 回レビュー PR-39c)。
// 3 つのフォームは、error の class も name も見ず、own property `circleCode` だけからこの key を引く
// (class は遅延 import の chunk にあり、フォームは First Load に入る)。
// (c) AttemptEndedError は class を export していないので、本物の instance での確認は
// tests/lib/smartAccount/circleSend.test.ts (「記録が abandoned になっていた」) にある。

const HASH = `0x${'ab'.repeat(32)}` as const;
const JAPANESE = /[ぁ-んァ-ヶ一-龠々〜]/;

const KEYS: Record<CircleErrorCode, CircleErrorKey> = {
  unconfirmed: 'unconfirmed',
  busy_elsewhere: 'busyElsewhere',
  attempt_ended: 'attemptEnded',
  send_rejected: 'sendRejected',
};
const CODES = Object.keys(KEYS) as CircleErrorCode[];

// user が承認した文 (2026-11-13)。一字も変えない。
const APPROVED_JA: Record<CircleErrorKey, string> = {
  unconfirmed:
    'USDC ガスレスの支払いを送信しましたが、結果をまだ確認できていません。このタブで同じ内容のままもう一度押すと、まず同じ支払いの結果を確かめ直します。確かめられるまで、ほかの方法で払い直さないでください。',
  busyElsewhere:
    '同じ内容の支払いが、別のタブまたは画面で進行中のため、ここでは始めていません。そちらで支払いを終えた場合は、ここでは押さないでください。そちらを閉じた場合は、数分後にここから支払えます。',
  attemptEnded:
    'この支払いの試みは既に終了しています。この試みでは送金していません。もう一度押すと、新しい支払いとして始めます。',
  sendRejected:
    'USDC ガスレスの支払いは、送信の受付で断られました。この支払いは送金されていません。残高が足りないなどの理由が考えられます。もう一度お試しください (署名からやり直します)。',
};

describe('circleErrorKey', () => {
  it.each(CODES)('符号 %s → その場面の key', (code) => {
    expect(circleErrorKey(Object.assign(new Error('x'), { circleCode: code }))).toBe(KEYS[code]);
  });

  it('本物の class の instance: 確認待ちの既定は (a)・理由つきは (b)・送信の受付の拒否は (d)', () => {
    expect(circleErrorKey(new CirclePendingError(HASH))).toBe('unconfirmed');
    expect(circleErrorKey(new CirclePendingError())).toBe('unconfirmed');
    expect(circleErrorKey(new CirclePendingError(HASH, 'busy_elsewhere'))).toBe('busyElsewhere');
    expect(circleErrorKey(new CircleSendRejectedError(HASH))).toBe('sendRejected');
  });

  it('class の name を見ない (name が同じでも、符号が無ければ null)', () => {
    const named = new Error('x');
    named.name = 'CirclePendingError';
    expect(circleErrorKey(named)).toBeNull();
  });

  it.each([
    ['符号なしの Error', new Error("AA21 didn't pay prefund")],
    ['知らない符号', Object.assign(new Error('x'), { circleCode: 'something_else' })],
    ['継承した名前と同じ符号 (toString)', Object.assign(new Error('x'), { circleCode: 'toString' })],
    ['継承した名前と同じ符号 (constructor)', Object.assign(new Error('x'), { circleCode: 'constructor' })],
    ['key の名前そのもの (符号ではない)', Object.assign(new Error('x'), { circleCode: 'busyElsewhere' })],
    ['文字列でない符号', Object.assign(new Error('x'), { circleCode: 1 })],
    ['null', null],
    ['undefined', undefined],
    ['文字列', 'unconfirmed'],
    ['Error でない object', { circleCode: 'unconfirmed', message: 'x' }],
  ])('%s → null', (_name, value) => {
    expect(circleErrorKey(value)).toBeNull();
  });
});

describe('Circle の経路の案内の文 (CircleErrors)', () => {
  const ja = createTranslator({ locale: 'ja', messages: jaMessages, namespace: 'CircleErrors' });
  const en = createTranslator({ locale: 'en', messages: enMessages, namespace: 'CircleErrors' });
  const ALL_KEYS = Object.values(KEYS);

  it('ja と en に 4 つの場面の文があり、余分な鍵が無い', () => {
    expect(Object.keys(jaMessages.CircleErrors).sort()).toEqual([...ALL_KEYS].sort());
    expect(Object.keys(enMessages.CircleErrors).sort()).toEqual([...ALL_KEYS].sort());
  });

  it.each(ALL_KEYS)('%s: ja は承認済みの文と完全に同じ', (key) => {
    expect(ja(key)).toBe(APPROVED_JA[key]);
  });

  it.each(ALL_KEYS)('%s: en の文に日本語が混ざらない', (key) => {
    expect(en(key)).not.toMatch(JAPANESE);
    expect(en(key).length).toBeGreaterThan(0);
  });

  // error の message (i18n を通らない出口 = 履歴・payment log・Sentry に出る) と ja の文は、2 か所に同じ文がある。
  // ずれたらここで止める。
  it('error の class の message は、ja の同じ場面の文と完全に同じ', () => {
    expect(new CirclePendingError(HASH).message).toBe(ja('unconfirmed'));
    expect(new CirclePendingError(HASH, 'busy_elsewhere').message).toBe(ja('busyElsewhere'));
    expect(new CircleSendRejectedError(HASH).message).toBe(ja('sendRejected'));
  });

  it('「再読み込みしても二重決済にならない」と約束しない (30 分より前の支払いでは成り立たない場合がある)', () => {
    for (const key of ALL_KEYS) expect(ja(key)).not.toMatch(/二重決済/);
  });
});
