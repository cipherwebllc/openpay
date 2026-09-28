import { describe, expect, it } from 'vitest';
import {
  assessPimlicoRun,
  assessReverifyRun,
  REVERIFY_MAX_AGE_MS,
} from '../../scripts/verify-production-config-helpers.mjs';
import { PIMLICO_BALANCE_HEADER } from '../../scripts/lib/pimlico-balance-output.mjs';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');

describe('assessReverifyRun', () => {
  it('鮮度の基準は GitHub の schedule の実測 (2〜7 時間おき) に合わせた 8 時間', () => {
    // 3 時間では実測間隔の 76% で fail し、本当の停止・secret 不一致と区別できなかった (2026-09-28)。
    expect(REVERIFY_MAX_AGE_MS).toBe(8 * 60 * 60 * 1000);
  });

  it('基準の時間内・success・実 HTTP 200 出力だけを healthy とする', () => {
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

describe('assessPimlicoRun', () => {
  it('残高チェックの見出し (check-pimlico-balance.mjs と共有の定数) があれば実行済み', () => {
    const log = `2026-09-28T02:36:00Z Run node scripts/check-pimlico-balance.mjs\n${PIMLICO_BALANCE_HEADER}\n- Polygon (EntryPoint 0.7): 6077 POL\n`;
    expect(assessPimlicoRun(log)).toMatchObject({ ok: true });
  });
  it('secret 未設定の graceful skip は、GitHub がレンダした warning 行で見分ける (shell の source 行には反応しない)', () => {
    expect(assessPimlicoRun('##[warning]Secrets 未設定 — skip')).toMatchObject({ ok: false, detail: expect.stringContaining('graceful skip') });
    expect(assessPimlicoRun('echo "::warning::Secrets 未設定 — skip"')).toMatchObject({ ok: false, detail: expect.stringContaining('balance output 不在') });
  });
  it('古い見出し (#599 より前) だけでは実行済みにしない', () => {
    expect(assessPimlicoRun('Pimlico Sponsorship Paymaster 残高:')).toMatchObject({ ok: false });
  });
});
