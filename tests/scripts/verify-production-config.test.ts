import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessNodeRuntime,
  assessPimlicoRun,
  assessReceiptSigner,
  assessReverifyFreshness,
  assessReverifyRun,
  checkNodeRuntime,
  checkReverifyFreshness,
  latestCompletedRun,
  NODE_RUNTIME_MINIMUM,
  REVERIFY_CLOCK_SKEW_MS,
  REVERIFY_GITHUB_RUN_MAX_AGE_MS,
  REVERIFY_MAX_AGE_MS,
  REVERIFY_STATUS_READY_RETRY_MS,
  summarizeChecks,
} from '../../scripts/verify-production-config-helpers.mjs';
import { PIMLICO_BALANCE_HEADER } from '../../scripts/lib/pimlico-balance-output.mjs';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');

describe('assessReverifyRun (予備の GitHub トリガー)', () => {
  it('鮮度の基準は GitHub の schedule の実測 (2〜7 時間おき) に合わせた 8 時間', () => {
    // 3 時間では実測間隔の 76% で fail し、本当の停止・secret 不一致と区別できなかった (2026-09-28)。
    // 毎時かどうかは本番の最後の成功 (assessReverifyFreshness) で見るので、こちらは締めない。
    expect(REVERIFY_GITHUB_RUN_MAX_AGE_MS).toBe(8 * 60 * 60 * 1000);
  });

  it('基準の時間内・success・実 HTTP 200 出力だけを healthy とする', () => {
    const run = {
      databaseId: 123,
      conclusion: 'success',
      createdAt: new Date(NOW - REVERIFY_GITHUB_RUN_MAX_AGE_MS + 1).toISOString(),
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
        createdAt: new Date(NOW - REVERIFY_GITHUB_RUN_MAX_AGE_MS - 1).toISOString(),
      },
      'HTTP 200',
    ],
  ])('%s は unhealthy', (_name, run, log) => {
    expect(assessReverifyRun(run, log, NOW).ok).toBe(false);
  });
});

describe('assessReverifyFreshness (本番の最後の正常な batch)', () => {
  const at = (ms: number) => new Date(ms).toISOString();

  it('基準は毎時の run が 2 回続けて失敗するまで待つ 3 時間', () => {
    // 主トリガーが Vercel Cron (毎時 0 分・分単位で正確) になったので、GitHub の実測の遅れに合わせた 8 時間は要らない。
    expect(REVERIFY_MAX_AGE_MS).toBe(3 * 60 * 60 * 1000);
  });

  it('基準の時間内なら ok で、何分前かを出す', () => {
    expect(assessReverifyFreshness(200, { lastOkAt: at(NOW - REVERIFY_MAX_AGE_MS) }, NOW)).toEqual({
      ok: true,
      detail: expect.stringContaining('180 分前'),
    });
    expect(assessReverifyFreshness(200, { lastOkAt: at(NOW - 60 * 60 * 1000) }, NOW).ok).toBe(true);
  });

  it('基準を 1 ms でも超えたら error (warn にしない)', () => {
    const result = assessReverifyFreshness(200, { lastOkAt: at(NOW - REVERIFY_MAX_AGE_MS - 1) }, NOW);
    expect(result.ok).toBe(false);
    expect(result.severity).toBeUndefined();
    expect(result.detail).toContain('基準の 180 分を超えた');
  });

  it('記録がまだ無い (deploy 直後) のは warn', () => {
    expect(assessReverifyFreshness(200, { lastOkAt: null }, NOW)).toEqual({
      ok: false,
      severity: 'warn',
      detail: expect.stringContaining('記録がまだ無い'),
    });
  });

  it('時計のずれの幅までの未来は ok・それを超える未来や読めない日時は error', () => {
    expect(assessReverifyFreshness(200, { lastOkAt: at(NOW + REVERIFY_CLOCK_SKEW_MS) }, NOW).ok).toBe(true);
    for (const lastOkAt of [at(NOW + REVERIFY_CLOCK_SKEW_MS + 1), 'not-a-date', 123, undefined]) {
      const result = assessReverifyFreshness(200, { lastOkAt }, NOW);
      expect(result.ok).toBe(false);
      expect(result.severity).toBeUndefined();
      expect(result.detail).toContain('日時が不正');
    }
  });

  it('200 でない (401 = secret 不一致・503 = KV 障害・404 = route が無い) のは error', () => {
    for (const status of [401, 404, 503]) {
      const result = assessReverifyFreshness(status, { lastOkAt: at(NOW) }, NOW);
      expect(result).toEqual({ ok: false, detail: `HTTP ${status} (/api/cron/reverify-status が読めない)` });
    }
  });
});

describe('checkReverifyFreshness', () => {
  const SECRET = 'cron-secret-value';

  it('CRON_SECRET が無ければ通信せずに NG', async () => {
    const fetchImpl = vi.fn();
    expect(await checkReverifyFreshness('https://open-pay.jp', undefined, { fetchImpl })).toEqual({
      ok: false,
      detail: 'CRON_SECRET 未設定 — 確認できない',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Bearer で /api/cron/reverify-status を読み、鮮度を判定する', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ lastOkAt: new Date(NOW - 30 * 60 * 1000).toISOString() }));
    expect(await checkReverifyFreshness('https://open-pay.jp', SECRET, { fetchImpl, nowMs: NOW })).toEqual({
      ok: true,
      detail: expect.stringContaining('30 分前'),
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://open-pay.jp/api/cron/reverify-status', expect.objectContaining({
      headers: { authorization: `Bearer ${SECRET}` },
      signal: expect.any(AbortSignal),
    }));
  });

  it('通信の例外は固定の文言にし、例外の中身 (秘密) を出さない', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed Bearer ${SECRET}`);
    });
    expect(await checkReverifyFreshness('https://open-pay.jp', SECRET, { fetchImpl, nowMs: NOW })).toEqual({
      ok: false,
      detail: '/api/cron/reverify-status に接続できない',
    });
  });

  it('JSON でない応答は日時不正の NG', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 200 }));
    const result = await checkReverifyFreshness('https://open-pay.jp', SECRET, { fetchImpl, nowMs: NOW });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('日時が不正');
  });

  // main への push の 5 分後の検証では、新しい route を含む版の配信がまだのことがある (旧版が 404 を返す)。
  // 404 だけは間隔を広げて数回読み直し、ずっと 404 なら route の無い版として error のまま。
  describe('404 (配信待ち) の読み直し', () => {
    const fresh = () => Response.json({ lastOkAt: new Date(NOW - 10 * 60 * 1000).toISOString() });
    const notFound = () => new Response('Not Found', { status: 404 });

    it('読み直しの待ちは 20 秒・40 秒・60 秒 (合計 2 分で post-deploy-verify の job の 10 分に収まる)', () => {
      expect(REVERIFY_STATUS_READY_RETRY_MS).toEqual([20_000, 40_000, 60_000]);
    });

    it('404 の後に 200 が返れば、その応答で判定して ok', async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(notFound()).mockResolvedValueOnce(notFound()).mockResolvedValue(fresh());
      const sleep = vi.fn(async () => {});
      expect(await checkReverifyFreshness('https://open-pay.jp', SECRET, { fetchImpl, sleep, nowMs: NOW })).toEqual({
        ok: true,
        detail: expect.stringContaining('10 分前'),
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[20_000], [40_000]]);
    });

    it('待っても 404 のままなら error (warn に下げない)', async () => {
      const fetchImpl = vi.fn(async () => notFound());
      const sleep = vi.fn(async () => {});
      expect(await checkReverifyFreshness('https://open-pay.jp', SECRET, { fetchImpl, sleep, nowMs: NOW })).toEqual({
        ok: false,
        detail: 'HTTP 404 (/api/cron/reverify-status が読めない)',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1 + REVERIFY_STATUS_READY_RETRY_MS.length);
      expect(sleep.mock.calls).toEqual(REVERIFY_STATUS_READY_RETRY_MS.map((ms) => [ms]));
    });

    it('404 以外の失敗 (503・401・通信の例外) は読み直さない', async () => {
      for (const make of [
        () => Response.json({ error: 'storage_unavailable' }, { status: 503 }),
        () => Response.json({ error: 'unauthorized' }, { status: 401 }),
        () => {
          throw new Error('connect failed');
        },
      ]) {
        const fetchImpl = vi.fn(async () => make());
        const sleep = vi.fn(async () => {});
        expect((await checkReverifyFreshness('https://open-pay.jp', SECRET, { fetchImpl, sleep, nowMs: NOW })).ok).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      }
    });
  });
});

describe('latestCompletedRun', () => {
  it('実行中の run (ログがまだ無い) を飛ばし、完了した最新の run を選ぶ', () => {
    const runs = [
      { databaseId: 3, status: 'in_progress' },
      { databaseId: 2, status: 'completed' },
      { databaseId: 1, status: 'completed' },
    ];
    expect(latestCompletedRun(runs)).toMatchObject({ databaseId: 2 });
  });
  it('完了した run が無い・配列でないときは undefined', () => {
    expect(latestCompletedRun([{ databaseId: 1, status: 'queued' }])).toBeUndefined();
    expect(latestCompletedRun(null)).toBeUndefined();
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

describe('assessReceiptSigner', () => {
  it('200 で receiptSigner がアドレスなら ok', () => {
    const signer = '0x2b6F88e71eA4D05469B40853e1E475240D4B59b3';
    expect(assessReceiptSigner(200, { receiptSigner: signer })).toEqual({
      ok: true,
      detail: `receiptSigner ${signer}`,
    });
  });

  it.each([
    ['null (鍵が無い・不正)', 200, { receiptSigner: null }],
    ['欄が無い', 200, {}],
    ['アドレスでない', 200, { receiptSigner: '0x1234' }],
    ['本文が JSON でない', 200, null],
    ['route が 404', 404, { receiptSigner: '0x2b6F88e71eA4D05469B40853e1E475240D4B59b3' }],
  ])('%s なら fail', (_label, status, body) => {
    expect(assessReceiptSigner(status, body).ok).toBe(false);
  });
});

describe('assessNodeRuntime', () => {
  it('最小の版は Node の 2026-10 のセキュリティ修正 (22.23.4 / 24.22.1 / 26.12.1)', () => {
    expect(NODE_RUNTIME_MINIMUM).toEqual({ 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] });
  });

  it.each([
    ['v24.22.1'],
    ['24.22.1'],
    ['v24.22.9'],
    ['v24.23.0'],
    ['v22.23.4'],
    ['v22.24.0'],
    ['v26.12.1'],
    ['v26.13.0'],
  ])('%s は修正の入った版以上', (node) => {
    expect(assessNodeRuntime(200, { node })).toEqual({ ok: true, detail: expect.stringContaining('以上') });
  });

  it.each([
    ['v24.22.0'],
    ['v24.21.9'],
    ['v22.23.3'],
    ['v26.12.0'],
  ])('%s は修正前', (node) => {
    expect(assessNodeRuntime(200, { node })).toEqual({ ok: false, detail: expect.stringContaining('古い') });
  });

  it.each([
    ['major に最小の版が無い (Node 20 は修正版が出ない)', 200, { node: 'v20.19.0' }],
    ['pre-release 表記', 200, { node: 'v24.22.1-rc.1' }],
    ['版が無い', 200, {}],
    ['body が JSON でない', 200, null],
    ['認証が通らない', 401, { error: 'unauthorized' }],
    ['route が無い (未 deploy)', 404, null],
  ])('%s なら NG', (_label, status, body) => {
    expect(assessNodeRuntime(status, body).ok).toBe(false);
  });

  it('公開ログに出るので、detail に正確な版を書かない', () => {
    for (const node of ['v24.22.1', 'v24.22.0', 'v24.21.9', 'v20.19.0', 'v24.22.1-rc.1']) {
      const { detail } = assessNodeRuntime(200, { node });
      expect(detail).not.toContain(node.replace(/^v/, ''));
      expect(detail).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });
});

describe('summarizeChecks', () => {
  const ok = { name: 'Sentry DSN', ok: true, detail: 'found' };
  const runtimeNg = { name: 'Production Node runtime (security minimum)', ok: false, detail: 'major 24: 古い', severity: 'warn' as const };
  const configNg = { name: 'x402 receipt signer', ok: false, detail: 'receiptSigner が null' };

  it('すべて active なら exit 0 で、警告の行は出さない', () => {
    const { lines, exitCode } = summarizeChecks([ok]);
    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toBe('✅ 1/1 件 active');
    expect(lines.some((line) => line.startsWith('::warning'))).toBe(false);
  });

  it('warn の失敗だけなら exit 0 のまま ::warning:: を出す (配布待ちで赤にしない)', () => {
    const { lines, exitCode } = summarizeChecks([ok, runtimeNg]);
    expect(exitCode).toBe(0);
    expect(lines).toContain('::warning title=Production Node runtime (security minimum)::major 24: 古い');
    expect(lines.at(-1)).toBe('✅ 1/2 件 active (警告 1 件)');
  });

  it('通常の失敗があれば、warn と一緒でも exit 1', () => {
    const { lines, exitCode } = summarizeChecks([ok, runtimeNg, configNg]);
    expect(exitCode).toBe(1);
    expect(lines.at(-1)).toBe('⚠ 1/3 件 inactive — 上記詳細を確認');
  });
});

describe('checkNodeRuntime', () => {
  const SECRET = 'cron-secret-value';
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server ? server.close(resolve) : resolve(undefined));
    server = undefined;
  });

  // 実際の fetch で期限を確かめるため、手元に止まるサーバを立てる (応答の頭の前か、本文の途中で止める)。
  async function stallingServer(stage: 'headers' | 'body'): Promise<string> {
    server = createServer((_req, res) => {
      if (stage === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"node":"v24.2');
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('CRON_SECRET が無ければ通信せずに NG', async () => {
    const fetchImpl = vi.fn();
    expect(await checkNodeRuntime('https://open-pay.jp', undefined, { fetchImpl })).toEqual({
      ok: false,
      detail: 'CRON_SECRET 未設定 — 確認できない',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Bearer で /api/cron/runtime を読み、版を判定する', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ node: 'v24.22.1' }));
    expect(await checkNodeRuntime('https://open-pay.jp', SECRET, { fetchImpl })).toEqual({
      ok: true,
      detail: expect.stringContaining('major 24'),
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://open-pay.jp/api/cron/runtime', expect.objectContaining({
      headers: { authorization: `Bearer ${SECRET}` },
      signal: expect.any(AbortSignal),
    }));
  });

  it('通信の例外は固定の文言にし、例外の中身 (秘密・版) を出さない', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed Bearer ${SECRET} v24.22.0`);
    });
    const { ok, detail } = await checkNodeRuntime('https://open-pay.jp', SECRET, { fetchImpl });
    expect(ok).toBe(false);
    expect(detail).toBe('/api/cron/runtime に接続できない');
  });

  // detail で止まった段階を確かめる: 頭の前なら fetch 自体が中断 (接続できない)、本文の途中なら頭は届いて
  // 本文の読み取りが中断 (版を読み取れない)。期限は遅い CI でも頭が届く余裕を持たせて 1 秒。
  it.each([
    ['headers' as const, '/api/cron/runtime に接続できない'],
    ['body' as const, '版を読み取れない'],
  ])('応答が止まっても (%s) 期限で NG にして先へ進む', async (stage, expected) => {
    const base = await stallingServer(stage);
    const started = Date.now();
    expect(await checkNodeRuntime(base, SECRET, { timeoutMs: 1_000 })).toEqual({ ok: false, detail: expected });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
