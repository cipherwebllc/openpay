// Japan Stablecoin Payment Monitor (lib/directory/paymentMonitor.ts) の契約テスト。
// 柱: (1) 決済スコープの backfill が載る、(2) provider/assets/chains の導出 (entry 紐づけ有無)、
// (3) スコープ分離 — JPYC Service Monitor に決済専用イベントが混ざらない (逆も)、
// (4) delta と「変更なし = changes:[]」。

import { describe, expect, it } from 'vitest';
import { createPaymentMonitorEnvelope } from '@/lib/directory/paymentMonitor';
import {
  createServiceMonitorEnvelope,
  SERVICE_MONITOR_MAX_LIMIT,
} from '@/lib/directory/serviceMonitor';

const NOW = '2026-08-27T02:00:00.000Z';
const Q = { limit: SERVICE_MONITOR_MAX_LIMIT };

describe('createPaymentMonitorEnvelope', () => {
  it('snapshot: 決済スコープの backfill (TIS/実証/JCB MOU/DG SPS) が日付昇順で載る', () => {
    const env = createPaymentMonitorEnvelope(Q, NOW);
    expect(env.mode).toBe('snapshot');
    expect(env.totalEvents).toBeGreaterThanOrEqual(4);
    const dates = env.changes.map((c) => c.date);
    expect([...dates].sort()).toEqual(dates); // 日付昇順
    const providers = env.changes.map((c) => c.provider);
    expect(providers).toContain('TIS / JPYC');
    expect(providers).toContain('Digital Garage / JCB / Resona HD');
    expect(providers).toContain('JCB / Circle');
    // 全行が必須フィールドを満たす (sourceUrl 必須級)。
    for (const row of env.changes) {
      expect(row.sourceUrl).toMatch(/^https:\/\//);
      expect(row.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(row.assets)).toBe(true);
      expect(Array.isArray(row.chains)).toBe(true);
    }
  });

  it('entry 紐づけイベント (dg-sps) は provider をエントリ名から導出し、イベント固有の assets/chains を優先', () => {
    const env = createPaymentMonitorEnvelope(Q, NOW);
    // service_launch は NetStars (7/13 backfill) もあるので発表日で dg-sps の行を選ぶ。
    const launch = env.changes.find(
      (c) => c.changeCategory === 'service_launch' && c.date === '2026-08-10',
    )!;
    expect(launch.provider).toBe('DG Stablecoin Payment Service'); // entry.name 由来
    expect(launch.assets).toEqual(['USDC']);
    expect(launch.chains).toEqual(['base']);
    expect(launch.date).toBe('2026-08-10'); // 発表日 (ディレクトリ追加日 8/27 ではない)
    // 値レベルの差分 (status: null → commercial) が決済ビューの行にも載る。
    expect(launch.diffs).toEqual([
      { field: 'status', previousValue: null, currentValue: 'commercial' },
    ]);
    // 前後の値が一次ソースに無い提携イベントには diffs キー自体が無い。
    const mou = env.changes.find((c) => c.provider === 'JCB / Circle')!;
    expect('diffs' in mou).toBe(false);
  });

  it('スコープ分離: JPYC 専用イベント (Kaia 対応等) は決済ビューに載らない', () => {
    const env = createPaymentMonitorEnvelope(Q, NOW);
    expect(env.changes.some((c) => /Kaia/.test(c.summary))).toBe(false);
    expect(env.changes.some((c) => c.provider === 'Aegis')).toBe(false);
  });

  it('スコープ分離 (逆): 決済専用イベントは JPYC Service Monitor に載らない — 8/01 以降の delta は 7 件', () => {
    const jpyc = createServiceMonitorEnvelope(
      { changedSince: '2026-08-01', limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    // E11 (2026-09-03 の日付訂正) 後、jpyc-services スコープで 8/01 以降に残るのは
    // dg-sps 追加 (発表日 8/10)・aegis (8/27)・coincheck 登録 (8/27・第 2 回週次)・
    // 9/04 の verified 4 件 (sbi-vc-trade/jpyc/jpyc-ex/aegis) の 7 件。決済スコープ専用の
    // 8/10 DG SPS launch・8/26 大阪府採択 3 件・8/31 Mi&T・9/04 verified 2 件が混ざれば
    // 14 件になる = スコープ分離の証明。
    expect(jpyc.changes).toHaveLength(7);
    expect(jpyc.changes.every((c) => c.slug !== undefined)).toBe(true);
    // 応答に内部ルーティング用 scopes を漏らさない。
    expect(jpyc.changes[0]).not.toHaveProperty('scopes');
  });

  it('delta: changedSince は当日含む・未来日は changes:[] を明示', () => {
    const delta = createPaymentMonitorEnvelope(
      { changedSince: '2026-08-10', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    expect(delta.mode).toBe('delta');
    // 8/10 DG SPS launch + 8/26 大阪府採択 3 件 + 8/31 Mi&T 手数料開示 + 9/04 verified 2 件
    // (当日含む・以前の backfill 4 件 = TIS/DG 実証/NetStars/JCB は含まない)
    expect(delta.changes).toHaveLength(7);
    expect(delta.changes[0].date).toBe('2026-08-10');
    expect(delta.changes.every((c) => c.date >= '2026-08-10')).toBe(true);

    const empty = createPaymentMonitorEnvelope(
      { changedSince: '9999-12-31', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    expect(empty.changes).toEqual([]);
    expect(empty.totalEvents).toBeGreaterThan(0); // 母数は開示
  });

  it('limit が changes を cap する', () => {
    const env = createPaymentMonitorEnvelope({ limit: 2 }, NOW);
    expect(env.changes).toHaveLength(2);
  });

  it('nextChangedSince = generatedAt の UTC 日付 (空 delta でも付く)', () => {
    expect(createPaymentMonitorEnvelope(Q, NOW).nextChangedSince).toBe('2026-08-27');
    const empty = createPaymentMonitorEnvelope(
      { changedSince: '9999-12-31', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    expect(empty.nextChangedSince).toBe('2026-08-27');
  });

  // E3: limit で打ち切られた delta は打ち切り分を永久に取りこぼさない。かつ **同一 date を
  // 分割しない**ので次の changedSince は必ず前進する (同じ日を無限に返し続けない)。
  it('E3: 打ち切られた delta は hasMore:true・nextChangedSince=最初の未返却イベントの date', () => {
    // 2026-08-10 (dg-sps launch) + 2026-08-26 (大阪府 3 件)。limit=2 では 8/26 の 3 件が
    // 入り切らないので、日付境界で切って 8/10 の 1 件だけを返す。
    const capped = createPaymentMonitorEnvelope(
      { changedSince: '2026-08-10', limit: 2 },
      NOW,
    );
    expect(capped.changes.map((c) => c.date)).toEqual(['2026-08-10']);
    expect(capped.hasMore).toBe(true);
    expect(capped.nextChangedSince).toBe('2026-08-26');
    expect(capped.nextChangedSince > capped.changes[0].date).toBe(true);
    expect(capped.nextChangedSince).not.toBe(NOW.slice(0, 10));

    const uncapped = createPaymentMonitorEnvelope(
      { changedSince: '2026-08-10', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    expect(uncapped.hasMore).toBe(false);
    expect(uncapped.nextChangedSince).toBe(NOW.slice(0, 10));
  });

  it('E3(a): 同一 date の件数が limit を超えてもその日を分割しない (limit は日付境界に切り上げ)', () => {
    // 2026-08-26 は 3 件 (大阪府採択)。limit=1 でも 3 件まとめて返す。
    const env = createPaymentMonitorEnvelope({ changedSince: '2026-08-26', limit: 1 }, NOW);
    expect(env.changes).toHaveLength(3);
    expect(env.changes.every((c) => c.date === '2026-08-26')).toBe(true);
    // その日より後にもイベント (8/31 Mi&T) があるので続きがあり、カーソルは次の未返却日。
    expect(env.hasMore).toBe(true);
    expect(env.nextChangedSince).toBe('2026-08-31');
  });

  it('E3(b): nextChangedSince を回し続けると前進する — 重複ゼロ・最後は hasMore:false', () => {
    const all = createPaymentMonitorEnvelope(
      { changedSince: '2026-08-10', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    ).changes;

    const key = (c: { provider: string; date: string; changeCategory?: string }) =>
      `${c.provider}|${c.date}|${c.changeCategory ?? ''}`;
    // 買い手の週次ジョブと同じ回し方: 応答の nextChangedSince をそのままエコーする。
    const pages: string[][] = [];
    let cursor = '2026-08-10';
    for (let i = 0; i < 10; i++) {
      const page = createPaymentMonitorEnvelope({ changedSince: cursor, limit: 2 }, NOW);
      expect(page.changes.length).toBeGreaterThan(0);
      pages.push(page.changes.map(key));
      if (!page.hasMore) break;
      expect(page.nextChangedSince > cursor).toBe(true); // 必ず前進 (同じ日を返し続けない)
      cursor = page.nextChangedSince;
    }
    expect(pages.length).toBeGreaterThan(1); // 実際にページングが起きている
    const seen = pages.flat();
    expect(new Set(seen).size).toBe(seen.length); // 重複ゼロ
    expect([...seen].sort()).toEqual(all.map(key).sort()); // 取りこぼしゼロ
  });

  // N4: 公開している重複排除キー (provider + date + changeCategory) が実データ上も一意
  // でなければ、エージェントは正しく dedupe しても取りこぼす。
  it('dedupe キー provider+date+changeCategory は snapshot 全件で一意', () => {
    const rows = createPaymentMonitorEnvelope(Q, NOW).changes;
    expect(rows.length).toBeGreaterThan(0);
    const keys = rows.map((c) => `${c.provider}|${c.date}|${c.changeCategory ?? ''}`);
    expect(new Set(keys).size, `重複キー: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`).toBe(
      keys.length,
    );
  });

  it('E3: snapshot の hasMore は「全イベント数 > limit」・nextChangedSince は常に generatedAt', () => {
    const total = createPaymentMonitorEnvelope(Q, NOW).totalEvents;
    const capped = createPaymentMonitorEnvelope({ limit: 1 }, NOW);
    expect(capped.hasMore).toBe(total > 1);
    expect(capped.nextChangedSince).toBe(NOW.slice(0, 10));
  });
});

// 事業者の現況行 providers (2026-09-02 裁定 2/2): 固定項目・null = 確認したが公表なし・
// provider 名は changelog と双方向に一致・delta は変更のあった社のみ・lastEventDate は導出。
import { PAYMENT_PROVIDERS, PAYMENT_INTEGRATIONS, PAYMENT_PROVIDER_STAGES } from '@/lib/directory/paymentProviders';

describe('createPaymentMonitorEnvelope.providers (事業者の現況行)', () => {
  it('snapshot: 全社が固定項目つきで載り、母数 totalProviders と一致', () => {
    const env = createPaymentMonitorEnvelope(Q, NOW);
    expect(env.providers).toHaveLength(PAYMENT_PROVIDERS.length);
    expect(env.totalProviders).toBe(PAYMENT_PROVIDERS.length);
    for (const p of env.providers) {
      expect(PAYMENT_PROVIDER_STAGES).toContain(p.stage);
      for (const i of p.integrations) expect(PAYMENT_INTEGRATIONS).toContain(i);
      expect(p.sourceUrl).toMatch(/^https:\/\//);
      expect(p.announcedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.lastEventDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // 固定項目は「無い」を null で明示 (undefined で欠落させない)。
      for (const key of ['settlementCurrency', 'merchantFee', 'posIntegration', 'region', 'startedAt', 'plannedPeriod'] as const) {
        expect(p).toHaveProperty(key);
      }
    }
  });

  it('provider 名は changelog の provider と双方向に一致 (行の結合キー)', () => {
    const env = createPaymentMonitorEnvelope(Q, NOW);
    const inChanges = new Set(env.changes.map((c) => c.provider));
    const inProviders = new Set(env.providers.map((p) => p.provider));
    expect([...inProviders].sort()).toEqual([...inChanges].sort());
  });

  it('lastEventDate は同名 provider の最新イベント日・一次ソースが開始を明示した社だけ startedAt', () => {
    const env = createPaymentMonitorEnvelope(Q, NOW);
    const dg = env.providers.find((p) => p.slug === 'dg-sps')!;
    expect(dg.stage).toBe('commercial');
    expect(dg.startedAt).toBe('2026-08-10');
    expect(dg.lastEventDate).toBe('2026-08-10');
    const hashport = env.providers.find((p) => p.provider.startsWith('HashPort'))!;
    expect(hashport.settlementCurrency).toBe('JPY'); // 一次ソースが「日本円で清算」と明示
    expect(hashport.startedAt).toBeNull(); // 予定のみ
    expect(hashport.plannedPeriod).toBe('2027-01..2027-03');
    expect(hashport.merchantFee).toBeNull(); // 非公表 = null
  });

  it('delta: 変更のあった社の現況行だけ・空 delta は providers:[] だが母数は開示', () => {
    const delta = createPaymentMonitorEnvelope(
      { changedSince: '2026-08-26', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    // 大阪府 3 件 + 8/31 Mi&T 手数料開示 + 9/04 verified 2 件 = 6 イベント・現況行は 3 社分
    expect(delta.changes).toHaveLength(6);
    expect(delta.providers.map((p) => p.region)).toEqual(['Osaka', 'Osaka', 'Osaka']);
    // 第 2 回週次更新: 現況が変わった社は changelog の diffs と行の値が一致する (同一 PR の掟)。
    const mit = delta.providers.find((p) => p.provider.startsWith('Mi&T'))!;
    expect(mit.merchantFee).toBe('1.0%');
    expect(mit.plannedPeriod).toBe('2026-11..2027-03');
    const mitFee = delta.changes.find(
      (c) => c.provider.startsWith('Mi&T') && c.changeCategory === 'fee_change',
    )!;
    expect(mitFee.date).toBe('2026-08-31');
    expect(mitFee.diffs).toEqual([{ field: 'fee', previousValue: null, currentValue: '1.0%' }]);
    expect(delta.totalProviders).toBe(PAYMENT_PROVIDERS.length);
    const empty = createPaymentMonitorEnvelope(
      { changedSince: '9999-12-31', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    expect(empty.providers).toEqual([]);
    expect(empty.totalProviders).toBe(PAYMENT_PROVIDERS.length);
  });
});
