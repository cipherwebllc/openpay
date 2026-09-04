// JPYC Service Monitor (lib/directory/serviceMonitor.ts) の契約テスト。
// 柱: (1) snapshot/delta のモード切替と「変更なし = changes:[]」の明示、
// (2) changedSince は当日含む・日付昇順・決定的順序、(3) query 検証、
// (4) baseline (added) が data.ts から導出される。

import { describe, expect, it } from 'vitest';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  createServiceMonitorEnvelope,
  parseServiceMonitorQuery,
  scopedChangelog,
  serviceChangelog,
  takeDeltaByDateGroups,
  SERVICE_DIFF_FIELDS,
  SERVICE_MONITOR_MAX_LIMIT,
} from '@/lib/directory/serviceMonitor';
import { JPYC_SERVICES_RESOURCE } from '@/lib/directory/paidResources';

const NOW = '2026-08-27T01:00:00.000Z';

function params(qs: string): URLSearchParams {
  return new URL(`https://x.test/api?${qs}`).searchParams;
}

/** baseline (data.ts 由来の added) の日付。1 日に 19 件が集中する唯一のグループ。 */
function baselineAddedDate(): string {
  return scopedChangelog('jpyc-services').find(
    (e) => e.slug === 'jpyc' && e.changeType === 'added',
  )!.date;
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

  // E4: openapi/Bazaar は changedSince/limit の 2 引数だけを宣言する。宣言に無いキーを
  // 黙って無視すると「宣言と実装がずれても気づけない」ため未知キーは 400 にする。
  it('宣言 (changedSince/limit) 以外のキーは null (未知キーは黙って無視しない)', () => {
    expect(parseServiceMonitorQuery(params('since=2026-08-20'))).toBeNull();
    expect(parseServiceMonitorQuery(params('changedSince=2026-08-20&extra=1'))).toBeNull();
  });

  // E4: 2026-02-30 のような形式は正しいが実在しない日付を Date.UTC の round-trip で弾く。
  it('changedSince は暦上の実在日のみ受理する (2026-02-30 等は null)', () => {
    expect(parseServiceMonitorQuery(params('changedSince=2026-02-28'))?.changedSince).toBe(
      '2026-02-28',
    );
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31']) {
      expect(parseServiceMonitorQuery(params(`changedSince=${bad}`))).toBeNull();
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
      // 実装 (serviceChangelog) と同じ localeCompare で比較する。同日に slug (小文字) と
      // provider 表示名 (大文字始まり) が混在する日 (第 2 回週次の verified 群) では
      // バイト順 (<=) と localeCompare が食い違うため、比較器を揃える。
      expect(
        prev.date < cur.date ||
          (prev.date === cur.date && prevKey.localeCompare(curKey) <= 0),
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

  // E11 (2026-09-03 の日付訂正) 後: jpyc / jpyc-ex は発表日 2026-05-15 の 2 件に移った。
  // limit=1 でもこの日は分割されず 2 件返る (残りは次ページ = hasMore)。
  it('limit が changes を cap する (ただし日付境界で切り上げ)', () => {
    const env = createServiceMonitorEnvelope(
      { changedSince: '2026-05-15', limit: 1 },
      {},
      NOW,
    );
    expect(env.changes.length).toBe(2);
    expect(new Set(env.changes.map((e) => e.date))).toEqual(new Set(['2026-05-15']));
    expect(env.hasMore).toBe(true);
    expect(env.nextChangedSince > '2026-05-15').toBe(true);
  });

  // E3: limit で打ち切られた delta は「取りこぼしを永久ロス」しない。かつ **同一 date を
  // 分割しない**ので、次の changedSince は必ず前進する (同じ日を無限に返し続けない)。
  it('E3(a): 同一 date の件数が limit を超えてもその日を丸ごと返し、次は必ず後の日付になる', () => {
    // baseline 日 (2026-07-13) に 19 件が集中する。E11 の日付訂正でスコープ最古日は
    // baseline より前 (発表日 2026-05-15) になったので、jpyc の baseline added から取る。
    const baselineDate = baselineAddedDate();
    const capped = createServiceMonitorEnvelope(
      { changedSince: baselineDate, limit: 5 },
      {},
      NOW,
    );
    // 1 日が分割されないので limit=5 を超えて baseline 全件が返る。
    expect(capped.changes.length).toBeGreaterThan(5);
    expect(capped.changes.every((e) => e.date === baselineDate)).toBe(true);
    expect(capped.hasMore).toBe(true);
    // 次のカーソルは「最後に返した date」ではなく「最初の未返却イベントの date」= 厳密に後。
    expect(capped.nextChangedSince > baselineDate).toBe(true);
    // その日のイベントは 1 件も返していない = 次回に再配信は起きない。
    expect(capped.changes.some((e) => e.date === capped.nextChangedSince)).toBe(false);

    const uncapped = createServiceMonitorEnvelope(
      { changedSince: baselineDate, limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    expect(uncapped.hasMore).toBe(false);
    expect(uncapped.nextChangedSince).toBe(NOW.slice(0, 10));
  });

  it('E3(b): nextChangedSince を回し続けると前進する — 重複ゼロ・最後は hasMore:false', () => {
    const baselineDate = baselineAddedDate();
    const all = createServiceMonitorEnvelope(
      { changedSince: baselineDate, limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    ).changes;

    const key = (e: { slug?: string; date: string; changeType: string }) =>
      `${e.slug ?? ''}|${e.date}|${e.changeType}`;
    // 買い手の週次ジョブと同じ回し方: 応答の nextChangedSince をそのままエコーする。
    const pages: string[][] = [];
    let cursor = baselineDate;
    for (let i = 0; i < 20; i++) {
      const page = createServiceMonitorEnvelope({ changedSince: cursor, limit: 5 }, {}, NOW);
      expect(page.changes.length).toBeGreaterThan(0);
      pages.push(page.changes.map(key));
      if (!page.hasMore) break;
      expect(page.nextChangedSince > cursor).toBe(true); // 必ず前進 (同じ日を返し続けない)
      cursor = page.nextChangedSince;
    }
    expect(pages.length).toBeGreaterThan(1); // 実際にページングが起きている
    const seen = pages.flat();
    // 再配信ゼロ (inclusive 比較でも重複しない)・取りこぼしゼロ。
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(all.map(key).sort());
  });

  it('E3: snapshot の hasMore は「全イベント数 > limit」', () => {
    const total = serviceChangelog().length;
    const capped = createServiceMonitorEnvelope({ limit: 1 }, {}, NOW);
    expect(capped.hasMore).toBe(total > 1);
    // snapshot は打ち切られても nextChangedSince を generatedAt のまま維持する
    // (snapshot に changedSince の概念が無いため、changes の date に差し替える意味が無い)。
    expect(capped.nextChangedSince).toBe(NOW.slice(0, 10));

    const uncapped = createServiceMonitorEnvelope(
      { limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    expect(uncapped.hasMore).toBe(total > SERVICE_MONITOR_MAX_LIMIT);
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

// 日付境界の切り上げ規則そのもの (実データに依存しない性質を合成データで固定する)。
describe('takeDeltaByDateGroups (delta の切り出し規則)', () => {
  const ev = (date: string, id: number) => ({ date, id });

  it('日付グループを分割しない — 先頭グループが limit を超えても丸ごと返す', () => {
    const events = [ev('2026-01-01', 1), ev('2026-01-01', 2), ev('2026-01-01', 3), ev('2026-01-02', 4)];
    const page = takeDeltaByDateGroups(events, 2);
    expect(page.taken.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(page.hasMore).toBe(true);
    // 最初の未返却イベントの date = 返した最後の date より厳密に後 → 必ず前進する。
    expect(page.nextChangedSince).toBe('2026-01-02');
  });

  it('累計が limit 以下の間だけグループを足す', () => {
    const events = [ev('2026-01-01', 1), ev('2026-01-02', 2), ev('2026-01-02', 3), ev('2026-01-03', 4)];
    expect(takeDeltaByDateGroups(events, 2).taken.map((e) => e.id)).toEqual([1]);
    expect(takeDeltaByDateGroups(events, 3).taken.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(takeDeltaByDateGroups(events, 3).nextChangedSince).toBe('2026-01-03');
  });

  it('全件入るなら hasMore:false・nextChangedSince は null (呼び元が generatedAt を使う)', () => {
    const events = [ev('2026-01-01', 1), ev('2026-01-02', 2)];
    const page = takeDeltaByDateGroups(events, 200);
    expect(page.taken).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.nextChangedSince).toBeNull();
    const empty = takeDeltaByDateGroups([], 5);
    expect(empty).toEqual({ taken: [], hasMore: false, nextChangedSince: null });
  });
});

// N4: 公開している重複排除キー (slug + date + changeType) が jpyc-services スコープ内で
// 実データ上も一意でなければ、エージェントは正しい dedupe をしても取りこぼす。
describe('dedupe キーの一意性 (jpyc-services)', () => {
  it('slug+date+changeType は一意・全イベントに slug がある', () => {
    const events = scopedChangelog('jpyc-services');
    expect(events.length).toBeGreaterThan(0);
    const keys = events.map((e) => {
      expect(e.slug, `slug の無い jpyc-services イベント: ${JSON.stringify(e)}`).toBeTruthy();
      return `${e.slug}|${e.date}|${e.changeType}`;
    });
    expect(new Set(keys).size, `重複キー: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`).toBe(
      keys.length,
    );
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

  it('jpyc-ex 2026-05-15 は chains + limit の 2 差分・delta 出力に載る', () => {
    const env = createServiceMonitorEnvelope(
      { changedSince: '2026-05-15', limit: SERVICE_MONITOR_MAX_LIMIT },
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

// E11 (2026-09-03 裁定): date = 一次ソースの発表日・collectedAt = 記録日。両者を取り違えると
// 「発表から何日で追えたか」も「いつ何が起きたか」も答えられなくなるので、収集日で date を
// 埋めない (収集日は collectedAt に分離する)。
describe('ServiceChangeEvent.date / collectedAt (発表日と収集日の分離)', () => {
  it('collectedAt を持つイベントは date (発表日) 以上の収集日を持つ', () => {
    const collected = serviceChangelog().filter((e) => e.collectedAt);
    expect(collected.length).toBeGreaterThanOrEqual(4);
    for (const event of collected) {
      expect(event.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(event.collectedAt! >= event.date).toBe(true);
    }
  });

  it('JPYC / JPYC EX の Kaia 対応は PR TIMES の発表日 2026-05-15 に置く', () => {
    const kaia = serviceChangelog().filter(
      (e) => e.sourceUrl === 'https://prtimes.jp/main/html/rd/p/000000315.000054018.html',
    );
    expect(kaia.map((e) => e.slug).sort()).toEqual(['jpyc', 'jpyc-ex']);
    for (const event of kaia) {
      expect(event.date).toBe('2026-05-15');
      expect(event.collectedAt).toBe('2026-08-27');
    }
  });

  it('collectedAt は応答イベントにもそのまま載る (scopes だけ落とす)', () => {
    const env = createServiceMonitorEnvelope(
      { changedSince: '2026-05-15', limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    const jpyc = env.changes.find(
      (c) => c.slug === 'jpyc' && c.changeType === 'updated',
    )!;
    expect(jpyc.collectedAt).toBe('2026-08-27');
  });
});

// E26: SERVICE_MONITOR_OUTPUT (paidResources.ts の Bazaar/openapi 向け宣言) の
// changes.items.required は「実際のイベントに常に存在するキー」の部分集合でなければならない。
// slug はディレクトリエントリに紐づかない業界イベント (provider のみ) では欠落し得るので
// 必須にしてはいけない (serviceMonitor.ts:75-77 の slug?/provider?)。
describe('SERVICE_MONITOR_OUTPUT スキーマ (E26): required ⊆ 常に存在するキー', () => {
  const itemSchema = JPYC_SERVICES_RESOURCE.outputSchema.output as unknown as {
    properties: {
      changes: {
        items: { required: readonly string[]; properties: Record<string, unknown> };
      };
    };
  };
  const changeItemSchema = itemSchema.properties.changes.items;

  it('required に slug を含まない (provider-only イベントを許す)・provider が properties にある', () => {
    expect(changeItemSchema.required).not.toContain('slug');
    expect(changeItemSchema.properties).toHaveProperty('provider');
    expect(changeItemSchema.properties).toHaveProperty('slug');
  });

  it('required の全キーは実際の envelope イベント全件に常に存在する (snapshot で検証)', () => {
    const env = createServiceMonitorEnvelope({ limit: SERVICE_MONITOR_MAX_LIMIT }, {}, NOW);
    expect(env.changes.length).toBeGreaterThan(0);
    for (const event of env.changes) {
      for (const key of changeItemSchema.required) {
        expect(
          event,
          `${key} が欠けているイベントがある: ${JSON.stringify(event)}`,
        ).toHaveProperty(key);
      }
    }
  });
});
