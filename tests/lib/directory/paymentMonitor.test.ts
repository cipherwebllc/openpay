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
    const launch = env.changes.find((c) => c.changeCategory === 'service_launch')!;
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

  it('スコープ分離 (逆): 決済専用イベントは JPYC Service Monitor に載らない — 第 1 回の delta は 4 件のまま', () => {
    const jpyc = createServiceMonitorEnvelope(
      { changedSince: '2026-08-01', limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    // backfill (8/10 DG SPS launch) が混ざると 5 件になる — 4 件がスコープ分離の証明。
    expect(jpyc.changes).toHaveLength(4);
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
    // 8/10 DG SPS launch + 8/26 大阪府採択 3 件 (当日含む・以前の backfill 3 件は含まない)
    expect(delta.changes).toHaveLength(4);
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

  // E3: limit で打ち切られた delta は打ち切り分を永久に取りこぼさない — nextChangedSince を
  // generatedAt でなく最後に返したイベントの date にし、hasMore で「続きがある」を明示する。
  it('E3: limit で打ち切られた delta は hasMore:true・nextChangedSince=最後に返したイベントの date', () => {
    // 2026-08-10 (dg-sps launch) + 2026-08-26 (大阪府 3 件) = 4 件を limit=2 で切る。
    const capped = createPaymentMonitorEnvelope(
      { changedSince: '2026-08-10', limit: 2 },
      NOW,
    );
    expect(capped.changes).toHaveLength(2);
    expect(capped.hasMore).toBe(true);
    expect(capped.nextChangedSince).toBe(capped.changes[1].date);
    expect(capped.nextChangedSince).not.toBe(NOW.slice(0, 10));

    const uncapped = createPaymentMonitorEnvelope(
      { changedSince: '2026-08-10', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    expect(uncapped.hasMore).toBe(false);
    expect(uncapped.nextChangedSince).toBe(NOW.slice(0, 10));
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
    expect(delta.changes).toHaveLength(3); // 大阪府 3 件
    expect(delta.providers.map((p) => p.region)).toEqual(['Osaka', 'Osaka', 'Osaka']);
    expect(delta.totalProviders).toBe(PAYMENT_PROVIDERS.length);
    const empty = createPaymentMonitorEnvelope(
      { changedSince: '9999-12-31', limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    expect(empty.providers).toEqual([]);
    expect(empty.totalProviders).toBe(PAYMENT_PROVIDERS.length);
  });
});
