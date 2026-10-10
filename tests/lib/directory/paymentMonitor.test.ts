// Japan Stablecoin Payment Monitor (lib/directory/paymentMonitor.ts) の契約テスト。
// 柱: (1) 決済スコープの backfill が載る、(2) provider/assets/chains の導出 (entry 紐づけ有無)、
// (3) スコープ分離 — JPYC Service Monitor に決済専用イベントが混ざらない (逆も)、
// (4) delta と「変更なし = changes:[]」。

import { describe, expect, it } from 'vitest';
import { MANUAL_CHANGELOG } from '@/lib/directory/changelogData';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { JPYC_PAYMENTS_RESOURCE } from '@/lib/directory/paidResources';
import { createPaymentMonitorEnvelope } from '@/lib/directory/paymentMonitor';
import { USDC_PAYMENT_MONITOR } from '@/lib/directory/usdcResource';
import {
  JPYC_DIRECTORY_MONITOR_OPENAPI_PATHS,
  VANILLA_DIRECTORY_OPENAPI_PATHS,
} from '@/lib/openapi/monitor';
import {
  createServiceMonitorEnvelope,
  SERVICE_MONITOR_MAX_LIMIT,
} from '@/lib/directory/serviceMonitor';

const NOW = '2026-08-27T02:00:00.000Z';
const Q = { limit: SERVICE_MONITOR_MAX_LIMIT };

/** dg-sps (ディレクトリ掲載・決済スコープのイベントを持つ) の表示名だけを変えたディレクトリ。 */
function renamedDg() {
  return DIRECTORY_ENTRIES.map((entry) =>
    entry.slug === 'dg-sps' ? { ...entry, name: 'DG Stablecoin Payment Service (renamed)' } : entry,
  );
}

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

  it('entry 紐づけイベント (dg-sps) は記録時の provider を持ち、イベント固有の assets/chains を優先', () => {
    const env = createPaymentMonitorEnvelope(Q, NOW);
    // service_launch は NetStars (7/13 backfill) もあるので発表日で dg-sps の行を選ぶ。
    const launch = env.changes.find(
      (c) => c.changeCategory === 'service_launch' && c.date === '2026-08-10',
    )!;
    expect(launch.provider).toBe('DG Stablecoin Payment Service'); // changelog に固定した記録時の表示名
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

  it('スコープ分離: JPYC 専用イベント (JPYC EX の Kaia 対応等) は決済ビューに載らない', () => {
    const env = createPaymentMonitorEnvelope(Q, NOW);
    // 2026-09-11 以降は決済スコープにも Kaia 絡み (NetStars × Kaia MOU) があるので、
    // JPYC EX の Kaia 対応イベント (jpyc-services 専用) の文言で判定する。
    expect(env.changes.some((c) => /added Kaia support/.test(c.summary))).toBe(false);
    expect(env.changes.some((c) => /^(Kaia|JPYC EX)$/.test(c.provider))).toBe(false);
    expect(env.changes.some((c) => c.provider === 'Aegis')).toBe(false);
  });

  it('スコープ分離 (逆): 決済専用イベントは JPYC Service Monitor に載らない — 8/01 以降の delta は 18 件', () => {
    const jpyc = createServiceMonitorEnvelope(
      { changedSince: '2026-08-01', limit: SERVICE_MONITOR_MAX_LIMIT },
      {},
      NOW,
    );
    // E11 (2026-09-03 の日付訂正) 後、jpyc-services スコープで 8/01 以降に残るのは
    // dg-sps 追加 (発表日 8/10)・aegis (8/27)・coincheck 登録 (8/27・第 2 回週次)・
    // 9/04 の verified 4 件 (sbi-vc-trade/jpyc/jpyc-ex/aegis)・9/11 kaia MOU・9/16 jpyc (Circle StableFX)・9/17 jpyc (Upbit 取引支援)・
    // 9/17 jpyc-ex (発行予約の一時停止と復旧)・9/18 jpyc (累計発行 100 億円・第 5 回)・9/23 coincheck verified (第 5 回) の 13 件
    // + 実効日で照合するため、5/15 発表・8/27 記録の backfill 2 件 (jpyc / jpyc-ex の Kaia 追加) も入る = 15 件
    // + 第 6 回 (9/29) の 3 件 (9/22 kaia × DOZN MOU・9/25 jpyc-ex UPBOND Wallet・9/29 jpyc Upbit 出金) = 18 件
    // + 第 7 回 (10/08) の 3 件 (9/30 jpyc αU wallet・10/06 jpyc-ex マイナウォレット・10/08 jpyc × RatioFX MOU) = 21 件。
    // 決済スコープ専用の 8/10 DG SPS launch・8/26 大阪府採択 3 件・8/31 Mi&T・9/04 verified 2 件・
    // 9/11 の 4 件 (NetStars 更新 + verified 3)・9/18 verified 4 件・9/23 verified 4 件・
    // 第 6 回で 9/29 に記録した backfill 3 件が混ざれば 40 件になる = スコープ分離の証明。
    expect(jpyc.changes).toHaveLength(21);
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
    // + 9/11 NetStars × Kaia MOU + 9/11 verified 3 件 + 9/18 verified 4 件 + 9/23 verified 4 件 = 19 件
    // + 実効日で照合するため、7/13 発表・9/04 記録の backfill (NetStars Stablecoin Pay added) も入る = 20 件
    // + 第 6 回で 9/29 に記録した backfill 3 件 (1/28 HashPort Wallet for Biz・7/07 MisePay・8/03 ローソン) = 23 件
    // + 第 7 回 (10/08 記録) の 3 件 (7/13 HashPort Wallet for Biz 更新の backfill・9/03 NetStars × imToken MOU の backfill・
    //   9/30 αU wallet 追加) = 26 件
    // (以前の backfill 3 件 = TIS/DG 実証/JCB は collectedAt が無く date < 8/10 なので含まない)
    expect(delta.changes).toHaveLength(26);
    expect(delta.changes[0].date).toBe('2026-08-10');
    // 並びは実効日順なので、date が cursor より古い backfill が混ざる (collectedAt は必ず cursor 以降)。
    expect(delta.changes.every((c) => (c.collectedAt ?? c.date) >= '2026-08-10')).toBe(true);

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
    // 次の未返却グループは実効日 9/04 (8/31 Mi&T と 7/13 NetStars は 9/04 に記録した backfill)。
    expect(env.hasMore).toBe(true);
    expect(env.nextChangedSince).toBe('2026-09-04');
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

  // N4: 公開している重複排除キー (slug (無いときは provider) + date + changeCategory) が実データ上も
  // 一意でなければ、エージェントは正しく dedupe しても取りこぼす。
  it('dedupe キー slug(無いときは provider)+date+changeCategory は snapshot 全件で一意', () => {
    const rows = createPaymentMonitorEnvelope(Q, NOW).changes;
    expect(rows.length).toBeGreaterThan(0);
    const keys = rows.map((c) => `${c.slug ?? c.provider}|${c.date}|${c.changeCategory ?? ''}`);
    expect(new Set(keys).size, `重複キー: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`).toBe(
      keys.length,
    );
  });

  it('E3: snapshot の hasMore は「全イベント数 > limit」・打ち切りが無ければ nextChangedSince は generatedAt', () => {
    const full = createPaymentMonitorEnvelope(Q, NOW);
    const total = full.totalEvents;
    if (!full.hasMore) expect(full.nextChangedSince).toBe(NOW.slice(0, 10));
    const capped = createPaymentMonitorEnvelope({ limit: 1 }, NOW);
    expect(capped.hasMore).toBe(total > 1);
  });

  // 第 7 回レビュー E17 の follow-up (Codex 1〜3 回目): 行の provider は `event.provider ?? entry.name` で、
  // changelog に provider の無いイベントはディレクトリの改名に追随して変わっていた。snapshot の続きで再配信された
  // 同じイベントが別の provider 名で届くと、provider を含む鍵では二重登録になる。決済スコープの全イベントに
  // provider を明示して固定し (記録時の表示名・改名に追随しない)、行には不変の slug も載せる。
  it('E17 follow-up: 決済スコープの changelog イベントは全て provider を明示している (改名に追随させない)', () => {
    const payment = MANUAL_CHANGELOG.filter((event) => event.scopes.includes('stablecoin-payments'));
    expect(payment.length).toBeGreaterThan(0);
    const missing = payment.filter((event) => !event.provider || event.provider.trim() === '');
    expect(missing.map((e) => `${e.slug ?? '?'}|${e.date}|${e.changeCategory ?? ''}`)).toEqual([]);
  });

  it('E17 follow-up: snapshot → 表示名の変更 → delta でも、既存イベントの provider と dedupe キーは変わらない', () => {
    const key = (c: { slug?: string; provider: string; date: string; changeCategory?: string }) =>
      `${c.slug ?? c.provider}|${c.date}|${c.changeCategory ?? ''}`;
    const total = createPaymentMonitorEnvelope(Q, NOW).totalEvents;
    const snapshot = createPaymentMonitorEnvelope({ limit: total - 1 }, NOW);
    expect(snapshot.hasMore).toBe(true);
    // ディレクトリ掲載の事業者 (改名され得る) のイベントが snapshot に入っている前提を確かめる。
    const dgBefore = snapshot.changes.find((c) => c.slug === 'dg-sps');
    expect(dgBefore?.provider).toBe('DG Stablecoin Payment Service');

    const delta = createPaymentMonitorEnvelope(
      { changedSince: snapshot.nextChangedSince, limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
      renamedDg(),
    );
    expect(delta.hasMore).toBe(false);
    const dgAfter = delta.changes.find((c) => c.slug === 'dg-sps');
    expect(dgAfter).toBeDefined(); // 同じイベントが再配信される
    expect(dgAfter!.provider).toBe(dgBefore!.provider); // 改名しても記録時の provider のまま
    expect(key(dgAfter!)).toBe(key(dgBefore!));

    // snapshot と delta の和集合を dedupe すると、ちょうど全イベント数になる (二重登録も取りこぼしも無い)。
    const seen = new Set([...snapshot.changes, ...delta.changes].map(key));
    expect(seen.size).toBe(total);
  });

  // Codex 3 回目の反例: slug を足す前の版で snapshot を保存 → DG を改名 → 新しい版の delta。
  // provider が改名に追随すると「同じ行の provider で組んだ旧い鍵」が保存時の名前と一致せず 30 件になっていた。
  it('E17 follow-up: 旧い版の保存 → 改名 → 新しい版の delta でも、同じ行の provider で読み替えるとちょうど全件', () => {
    const oldKey = (c: { provider: string; date: string; changeCategory?: string }) =>
      `${c.provider}|${c.date}|${c.changeCategory ?? ''}`;
    const newKey = (c: { slug?: string; provider: string; date: string; changeCategory?: string }) =>
      `${c.slug ?? c.provider}|${c.date}|${c.changeCategory ?? ''}`;
    const total = createPaymentMonitorEnvelope(Q, NOW).totalEvents;
    const oldSnapshot = createPaymentMonitorEnvelope({ limit: total - 1 }, NOW);
    const stored = oldSnapshot.changes.map(({ slug: _slug, ...row }) => row); // slug の無い旧い版の行
    const delta = createPaymentMonitorEnvelope(
      { changedSince: oldSnapshot.nextChangedSince, limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
      renamedDg(),
    );
    const slugged = delta.changes.filter((c) => c.slug !== undefined);
    expect(slugged.length).toBeGreaterThan(0);
    const rekey = new Map(slugged.map((c) => [oldKey(c), newKey(c)]));
    const migrated = new Set([
      ...stored.map((o) => rekey.get(oldKey(o)) ?? oldKey(o)),
      ...delta.changes.map(newKey),
    ]);
    expect(migrated.size).toBe(total);
  });

  // 同 follow-up (Codex 2 回目 P2): slug を足す前の版で保存したイベントは provider + date + changeCategory の
  // 鍵で残っている。新しい版の delta で同じイベントが slug つきで再配信されると鍵が変わり、29 件が 30 件に
  // なる。移行の手順は「slug つきの行は、同じ行の provider で組んだ旧い鍵とも照合する」(同じ行に provider と
  // slug の両方が載る)。旧い応答 → 新しい応答をまたいでも、この読み替えで全件が一致すること。
  it('E17 follow-up: slug を足す前の応答 → 足した後の応答をまたいでも、同じ行の provider で旧い鍵を読み替えると全件一致', () => {
    const oldKey = (c: { provider: string; date: string; changeCategory?: string }) =>
      `${c.provider}|${c.date}|${c.changeCategory ?? ''}`;
    const newKey = (c: { slug?: string; provider: string; date: string; changeCategory?: string }) =>
      `${c.slug ?? c.provider}|${c.date}|${c.changeCategory ?? ''}`;
    const total = createPaymentMonitorEnvelope(Q, NOW).totalEvents;
    // 旧い版の snapshot = slug の無い行 (provider で保存されている)。
    const oldSnapshot = createPaymentMonitorEnvelope({ limit: total - 1 }, NOW);
    expect(oldSnapshot.hasMore).toBe(true);
    const stored = oldSnapshot.changes.map(({ slug: _slug, ...row }) => row);
    const delta = createPaymentMonitorEnvelope(
      { changedSince: oldSnapshot.nextChangedSince, limit: SERVICE_MONITOR_MAX_LIMIT },
      NOW,
    );
    expect(delta.hasMore).toBe(false);
    const slugged = delta.changes.filter((c) => c.slug !== undefined);
    expect(slugged.length).toBeGreaterThan(0); // 実際に slug つきの行が再配信される前提

    // 読み替えなし: 旧い鍵と新しい鍵が混ざり、同じイベントを二重に数える (この回帰の再現)。
    const naive = new Set([...stored.map(oldKey), ...delta.changes.map(newKey)]);
    expect(naive.size).toBeGreaterThan(total);

    // 読み替えあり: slug つきの行は同じ行の provider で旧い鍵を組めるので、保存済みの旧い鍵を新しい鍵へ移す。
    const rekey = new Map(slugged.map((c) => [oldKey(c), newKey(c)]));
    const migrated = new Set([
      ...stored.map((o) => rekey.get(oldKey(o)) ?? oldKey(o)),
      ...delta.changes.map(newKey),
    ]);
    expect(migrated.size).toBe(total);
  });

  it('E17 follow-up: 移行の手順 (slug つきの行は同じ行の provider で組んだ旧い鍵とも照合) を schema と OpenAPI に書いている', () => {
    const changes = JPYC_PAYMENTS_RESOURCE.outputSchema.output.properties.changes as {
      items: { properties: { slug: { description: string } } };
    };
    const texts = [
      changes.items.properties.slug.description,
      VANILLA_DIRECTORY_OPENAPI_PATHS[USDC_PAYMENT_MONITOR.path].get['x-agent-usage'],
      JPYC_DIRECTORY_MONITOR_OPENAPI_PATHS['/api/paid/stablecoin-payments'].get['x-agent-usage'],
    ];
    for (const text of texts) {
      expect(text).toContain('dedupe by slug+date+changeCategory');
      expect(text).toContain('stored before slug was added');
      expect(text).toContain('provider on the same row');
      // provider はイベントごとに固定 (Codex 3 回目)。「改名で変わる」と書くと移行手順が成り立たない。
      expect(text).not.toContain('can change on rename');
    }
    const provider = (changes.items.properties as unknown as { provider: { description: string } }).provider;
    expect(provider.description).toContain('fixed per event');
    expect(provider.description).not.toContain('follows the current directory name');
  });

  // E17 (第 7 回レビュー): Service Monitor と同じ。打ち切った snapshot の nextChangedSince を
  // changedSince に渡して delta をたどれば、返さなかったイベントを全部取れる。
  it('E17: 打ち切った snapshot の nextChangedSince から delta をたどると取りこぼしゼロ', () => {
    const key = (c: { provider: string; date: string; changeCategory?: string }) =>
      `${c.provider}|${c.date}|${c.changeCategory ?? ''}`;
    const all = new Set(createPaymentMonitorEnvelope(Q, NOW).changes.map(key));
    const limit = 3;
    expect(all.size).toBeGreaterThan(limit); // 実際に打ち切りが起きる前提

    const snapshot = createPaymentMonitorEnvelope({ limit }, NOW);
    expect(snapshot.hasMore).toBe(true);
    const seen = new Set(snapshot.changes.map(key));
    let cursor = snapshot.nextChangedSince;
    let pages = 0;
    for (; pages < 50; pages++) {
      const page = createPaymentMonitorEnvelope({ changedSince: cursor, limit }, NOW);
      for (const change of page.changes) seen.add(key(change));
      if (!page.hasMore) break;
      expect(page.nextChangedSince > cursor).toBe(true);
      cursor = page.nextChangedSince;
    }
    expect(pages).toBeLessThan(50);
    expect([...seen].sort()).toEqual([...all].sort());
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
    // 大阪府 3 件 + 8/31 Mi&T 手数料開示 + 9/04 verified 2 件 + 9/11 NetStars 更新 + 9/11 verified 3 件
    // + 9/18 verified 4 件 + 9/23 verified 4 件 + 9/04 記録の backfill (7/13 NetStars added) = 19 イベント・
    // + 第 6 回で 9/29 に記録した backfill 3 件 = 22 イベント + 第 7 回 (10/08 記録) の 3 件 (HashPort Wallet for Biz 7/13 更新・
    // NetStars × imToken 9/03・αU wallet 9/30 追加) = 25 イベント。現況行は大阪 3 社 + NetStars + 第 6 回の 3 社
    // (HashPort Wallet for Biz・MisePay・ローソン) + 第 7 回の αU wallet の 8 社分
    expect(delta.changes).toHaveLength(25);
    expect(delta.providers.map((p) => p.region).sort()).toEqual(['Japan', 'Japan', 'Japan', 'Japan', 'Japan', 'Osaka', 'Osaka', 'Osaka']);
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
