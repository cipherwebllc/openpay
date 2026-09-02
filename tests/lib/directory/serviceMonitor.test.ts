// JPYC Service Monitor (lib/directory/serviceMonitor.ts) の契約テスト。
// 柱: (1) snapshot/delta のモード切替と「変更なし = changes:[]」の明示、
// (2) changedSince は当日含む・日付昇順・決定的順序、(3) query 検証、
// (4) baseline (added) が data.ts から導出される。

import { describe, expect, it } from 'vitest';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  createServiceMonitorEnvelope,
  parseServiceMonitorQuery,
  serviceChangelog,
  SERVICE_DIFF_FIELDS,
  SERVICE_MONITOR_MAX_LIMIT,
} from '@/lib/directory/serviceMonitor';

const NOW = '2026-08-27T01:00:00.000Z';

function params(qs: string): URLSearchParams {
  return new URL(`https://x.test/api?${qs}`).searchParams;
}

describe('parseServiceMonitorQuery', () => {
  it('省略時は snapshot 用の既定 (limit=max)', () => {
    expect(parseServiceMonitorQuery(params(''))).toEqual({
      limit: SERVICE_MONITOR_MAX_LIMIT,
    });
  });

  it('changedSince は YYYY-MM-DD のみ受理', () => {
    expect(parseServiceMonitorQuery(params('changedSince=2026-08-20'))).toEqual({
      changedSince: '2026-08-20',
      limit: SERVICE_MONITOR_MAX_LIMIT,
    });
    for (const bad of ['2026-8-20', '2026-08-20T00:00:00Z', 'yesterday', '20260820']) {
      expect(parseServiceMonitorQuery(params(`changedSince=${bad}`))).toBeNull();
    }
  });

  it('limit は 1..200 のみ受理', () => {
    expect(parseServiceMonitorQuery(params('limit=1'))?.limit).toBe(1);
    expect(parseServiceMonitorQuery(params('limit=200'))?.limit).toBe(200);
    for (const bad of ['0', '201', '-1', '1.5', 'abc']) {
      expect(parseServiceMonitorQuery(params(`limit=${bad}`))).toBeNull();
    }
  });
});

describe('serviceChangelog', () => {
  it('baseline: published 全エントリの added イベントが data.ts から導出される (jpyc-services スコープ)', () => {
    const changelog = serviceChangelog();
    // 決済スコープ専用の added (実証・提携等の backfill) は数えない — ディレクトリの
    // 追加イベントは jpyc-services スコープに 1 エントリ 1 件。
    const added = changelog.filter(
      (e) => e.changeType === 'added' && e.scopes.includes('jpyc-services'),
    );
    const published = DIRECTORY_ENTRIES.filter((e) => e.status === 'published');
    expect(added.length).toBe(published.length);
    for (const event of added) {
      expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(event.sourceUrl).toBeTruthy();
      expect(event.summary).toContain('added');
    }
  });

  it('日付昇順・同日内は slug 順の決定的順序', () => {
    const changelog = serviceChangelog();
    for (let i = 1; i < changelog.length; i++) {
      const prev = changelog[i - 1];
      const cur = changelog[i];
      const prevKey = prev.slug ?? prev.provider ?? '';
      const curKey = cur.slug ?? cur.provider ?? '';
      expect(
        prev.date < cur.date || (prev.date === cur.date && prevKey <= curKey),
      ).toBe(true);
    }
  });
});

describe('createServiceMonitorEnvelope', () => {
  it('snapshot: 全 published の監視ビュー + 直近イベント', () => {
    const env = createServiceMonitorEnvelope(
      { limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    expect(env.mode).toBe('snapshot');
    expect(env.services.length).toBe(env.totalServices);
    expect(env.services.length).toBeGreaterThan(0);
    expect(env.changes.length).toBeGreaterThan(0);
    // 監視ビュー行は editorial 全文を含めない (詳細は directory 本体商品の領分)。
    expect(env.services[0]).not.toHaveProperty('editorial');
    expect(env.services[0]).toMatchObject({
      slug: expect.any(String),
      supportsJpyc: expect.any(Boolean),
      verifiedAt: expect.any(String),
      sourceCheckedAt: null, // snapshot 未検証時
      sourceOk: null,
    });
    expect(env.notice.code).toBe('sourced-facts-only');
    expect(env.attribution.length).toBeGreaterThan(0);
  });

  it('nextChangedSince = generatedAt の UTC 日付 (エージェントは次回そのままエコーする)', () => {
    const env = createServiceMonitorEnvelope(
      { limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    expect(env.nextChangedSince).toBe('2026-08-27');
    expect(env.generatedAt.startsWith(env.nextChangedSince)).toBe(true);
    // delta (変更なし) でも必ず付く — 空応答でも次回のカーソルが途切れない。
    const empty = createServiceMonitorEnvelope(
      { changedSince: '9999-12-31', limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    expect(empty.nextChangedSince).toBe('2026-08-27');
  });

  it('delta: baseline より後の日付なら changes:[] を明示 (「変更なし」の契約)', () => {
    const env = createServiceMonitorEnvelope(
      { changedSince: '9999-12-31', limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    expect(env.mode).toBe('delta');
    expect(env.changes).toEqual([]);
    expect(env.services).toEqual([]);
    expect(env.totalServices).toBeGreaterThan(0); // 母数は変わらず開示
  });

  it('delta: changedSince は当日を含む (baseline 日を渡すと全 added が返る)', () => {
    const baselineDate = serviceChangelog()[0].date;
    const env = createServiceMonitorEnvelope(
      { changedSince: baselineDate, limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    expect(env.changes.length).toBeGreaterThan(0);
    expect(env.changes.every((e) => e.date >= baselineDate)).toBe(true);
    // 変更のあった slug の現況行が付く。
    const changedSlugs = new Set(env.changes.map((e) => e.slug));
    expect(env.services.length).toBe(changedSlugs.size);
  });

  it('limit が changes を cap する', () => {
    const baselineDate = serviceChangelog()[0].date;
    const env = createServiceMonitorEnvelope(
      { changedSince: baselineDate, limit: 3 },
      {},
      NOW,
    );
    expect(env.changes.length).toBe(3);
  });

  it('検証スナップショットの sourceCheckedAt/sourceOk が行に載る (URL 一致時のみ)', () => {
    const entry = DIRECTORY_ENTRIES.find((e) => e.status === 'published')!;
    const env = createServiceMonitorEnvelope(
      { limit: SERVICE_MONITOR_MAX_LIMIT },
      {
        [entry.slug]: {
          checkedAt: '2026-08-26T00:00:00.000Z',
          ok: true,
          sourceUrl: entry.sourceUrl,
        },
        // URL 不一致 (旧 URL の結果) は載せない
      },
      NOW,
    );
    const row = env.services.find((r) => r.slug === entry.slug)!;
    expect(row.sourceCheckedAt).toBe('2026-08-26T00:00:00.000Z');
    expect(row.sourceOk).toBe(true);
  });
});

// 構造化差分 (変更台帳化・2026-09-02): 一次ソースが前後の値を明示する変更だけ diffs を持ち、
// field は固定語彙・previousValue≠currentValue・effectiveAt は日付形式。出力にもそのまま載る。
describe('ServiceChangeEvent.diffs (値レベルの差分)', () => {
  it('全 diffs が契約を満たす (固定語彙・前後の値が異なる・日付形式)', () => {
    const withDiffs = serviceChangelog().filter((e) => e.diffs && e.diffs.length > 0);
    expect(withDiffs.length).toBeGreaterThanOrEqual(4); // backfill: jpyc / jpyc-ex / aegis / dg-sps
    for (const event of withDiffs) {
      for (const d of event.diffs!) {
        expect(SERVICE_DIFF_FIELDS).toContain(d.field);
        expect(JSON.stringify(d.previousValue)).not.toBe(JSON.stringify(d.currentValue));
        expect(Array.isArray(d.currentValue) ? d.currentValue.length : d.currentValue.length).toBeGreaterThan(0);
        if (d.effectiveAt !== undefined) expect(d.effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('jpyc-ex 2026-08-27 は chains + limit の 2 差分・delta 出力に載る', () => {
    const env = createServiceMonitorEnvelope(
      { changedSince: '2026-08-27', limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    const ex = env.changes.find((c) => c.slug === 'jpyc-ex' && c.changeType === 'updated')!;
    expect(ex.diffs?.map((d) => d.field)).toEqual(['chains', 'limit']);
    expect(ex.diffs?.[0].currentValue).toContain('kaia');
    // diffs を持たないイベントは省略 (null や空配列を出さない)。
    const base = serviceChangelog().find((e) => e.changeType === 'added' && !e.diffs)!;
    expect(base).toBeDefined();
    expect('diffs' in base).toBe(false);
  });
});
