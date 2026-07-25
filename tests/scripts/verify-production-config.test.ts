import { describe, expect, it } from 'vitest';
import {
  assessReverifyRun,
  REVERIFY_MAX_AGE_MS,
} from '../../scripts/verify-production-config-helpers.mjs';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');

describe('assessReverifyRun', () => {
  it('直近3時間内・success・実 HTTP 200 出力だけを healthy とする', () => {
    const run = {
      databaseId: 123,
      conclusion: 'success',
      createdAt: new Date(NOW - REVERIFY_MAX_AGE_MS + 1).toISOString(),
    };
    expect(assessReverifyRun(run, 'Trigger endpoint\nHTTP 200\n', NOW)).toEqual({
      ok: true,
      detail: expect.stringContaining('run #123 HTTP 200'),
    });
  });

  it.each([
    [
      'secret 欠落等で failure',
      { databaseId: 1, conclusion: 'failure', createdAt: new Date(NOW).toISOString() },
      'HTTP 200',
    ],
    [
      '成功扱いでも HTTP 200 出力なし',
      { databaseId: 2, conclusion: 'success', createdAt: new Date(NOW).toISOString() },
      'HTTP 401',
    ],
    [
      '古い成功 run',
      {
        databaseId: 3,
        conclusion: 'success',
        createdAt: new Date(NOW - REVERIFY_MAX_AGE_MS - 1).toISOString(),
      },
      'HTTP 200',
    ],
  ])('%s は unhealthy', (_name, run, log) => {
    expect(assessReverifyRun(run, log, NOW).ok).toBe(false);
  });
});
