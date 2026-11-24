// lib/sentryServerIgnoreErrors.ts の一覧が、Next.js が実際に投げる「読めない router state header」の文言だけに当たり、
// 同じ所のほかの error (複数・大きすぎ) や似た文言には当たらないことを固定する (Next.js を更新して文言が変わったら気づく)。

import { describe, expect, it } from 'vitest';
import { parseAndValidateFlightRouterState } from 'next/dist/server/app-render/parse-and-validate-flight-router-state';
import { SENTRY_SERVER_IGNORE_ERRORS } from '@/lib/sentryServerIgnoreErrors';

// Sentry は例外の value と「type: value」の両方で照合する (@sentry/core の getPossibleEventMessages)。
const ignored = (message: string) =>
  [message, `Error: ${message}`].some((m) => SENTRY_SERVER_IGNORE_ERRORS.some((p) => p.test(m)));

function nextErrorMessage(header: string | string[]): string {
  try {
    parseAndValidateFlightRouterState(header as string);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected Next.js to reject the header');
}

describe('SENTRY_SERVER_IGNORE_ERRORS', () => {
  it('Next.js が壊れた router state header を読めないときの error には当たる', () => {
    const message = nextErrorMessage('not-json');
    expect(message).toBe('The router state header was sent but could not be parsed.');
    expect(ignored(message)).toBe(true);
  });

  it('同じ所のほかの error (複数・大きすぎ) には当たらない', () => {
    expect(ignored(nextErrorMessage(['a', 'b']))).toBe(false);
    expect(ignored(nextErrorMessage('x'.repeat(40_001)))).toBe(false);
  });

  it('似た文言・ほかの error には当たらない', () => {
    expect(ignored('The router state header was sent but could not be parsed. (extra)')).toBe(false);
    // 末尾の . は文字どおり (正規表現の任意の 1 文字にしない)。
    expect(ignored('The router state header was sent but could not be parsed!')).toBe(false);
    expect(ignored('Prefix: The router state header was sent but could not be parsed.')).toBe(false);
    expect(ignored('Failed to fetch')).toBe(false);
  });
});
