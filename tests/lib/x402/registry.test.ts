import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAddress } from 'viem';

// kv を in-memory でモック (registry の保存/列挙ロジックを純粋に検証)。
const store = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  failEval: false, // true で kvEval(CAS) を fail させ storage エラー枝を検証
  failLrange: false, // true で kvLrange を fail させ count の KV エラー枝を検証
  failGet: false, // true で kvGet を fail させ record 単体取得失敗 → null 枝を検証
}));
vi.mock('@/lib/kv', () => ({
  kvGet: async (k: string) =>
    store.failGet
      ? ({ ok: false as const, reason: 'kv_error' })
      : ({ ok: true as const, value: store.kv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => {
    store.kv.set(k, v);
    return { ok: true as const, value: 'OK' as const };
  },
  kvLpush: async (k: string, v: string) => {
    const a = store.lists.get(k) ?? [];
    a.unshift(v);
    store.lists.set(k, a);
    return { ok: true as const, value: a.length };
  },
  kvLrange: async (k: string, start: number, stop: number) => {
    if (store.failLrange) return { ok: false as const, reason: 'kv_error' };
    const a = store.lists.get(k) ?? [];
    const end = stop < 0 ? a.length : stop + 1;
    return { ok: true as const, value: a.slice(start, end) };
  },
  // CAS_UPDATE / CAS_DEACTIVATE の Lua セマンティクスを in-memory で再現 (script で分岐)。
  kvEval: async (script: string, keys: string[], args: string[]) => {
    if (store.failEval) return { ok: false as const, reason: 'kv_error' };
    // CAS_CREATE: LLEN(merchant index) cap 判定 + SET(resource) + LPUSH(discovery/merchant index)。
    if (script.includes("redis.call('LLEN'")) {
      const cap = Number(args[2]);
      const merchantList = store.lists.get(keys[2]) ?? [];
      if (merchantList.length >= cap) return { ok: true as const, value: -2 };
      store.kv.set(keys[0], args[0]);
      const idx = store.lists.get(keys[1]) ?? [];
      idx.unshift(args[1]);
      store.lists.set(keys[1], idx);
      merchantList.unshift(args[1]);
      store.lists.set(keys[2], merchantList);
      return { ok: true as const, value: 1 };
    }
    const raw = store.kv.get(keys[0]);
    if (raw === undefined) return { ok: true as const, value: -1 };
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw);
    } catch {
      return { ok: true as const, value: -2 };
    }
    if (typeof o !== 'object' || o === null || typeof o.merchant !== 'string') {
      return { ok: true as const, value: -2 };
    }
    if ((o.merchant as string).toLowerCase() !== args[0].toLowerCase()) {
      return { ok: true as const, value: 0 };
    }
    if (script.includes('o.url=ARGV[2]')) {
      if (o.active === false) return { ok: true as const, value: -3 }; // 削除済は編集不可
      if (o.url !== args[1]) {
        delete o.verification;
        delete o.hidden;
      }
      o.url = args[1];
      o.description = args[2];
      o.priceJpyc = args[3];
      o.category = args[4];
      o.payTo = args[5];
      if (args[6]) o.docsUrl = args[6];
      else delete o.docsUrl;
      if (args[7]) o.license = args[7];
      else delete o.license;
      o.updatedAt = Number(args[8]);
      const enc = JSON.stringify(o);
      store.kv.set(keys[0], enc);
      return { ok: true as const, value: enc };
    }
    const removeFromDiscovery = () => {
      const id = args[1];
      const idx = store.lists.get(keys[1]) ?? [];
      store.lists.set(keys[1], idx.filter((x) => x !== id));
    };
    if (o.active === false) {
      removeFromDiscovery();
      return { ok: true as const, value: 2 };
    }
    o.active = false;
    store.kv.set(keys[0], JSON.stringify(o));
    removeFromDiscovery();
    return { ok: true as const, value: 1 };
  },
}));

import {
  parseResourceInput,
  createResource,
  getResource,
  listResourcesForMerchant,
  countMerchantResources,
  listActiveResources,
  updateResource,
  deactivateResource,
  recordSettlement,
  resourceKey,
  merchantResourcesKey,
  RESOURCES_INDEX,
  MAX_RESOURCES_PER_MERCHANT,
  type X402Resource,
  type X402ResourceInput,
} from '@/lib/x402/registry';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const STRANGER = getAddress('0x9999999999999999999999999999999999999999');

function resource(id: string, owner = OWNER): X402Resource {
  return {
    id,
    merchant: owner,
    url: `https://a.jp/${id}`,
    description: 'd',
    priceJpyc: '1',
    category: 'api',
    payTo: owner,
    network: 'eip155:80002',
    active: true,
    createdAt: 1,
  };
}

// 編集入力 (parseResourceInput 済の形)。owner=merchant・payTo は呼び側で差し替え可。
function input(over: Partial<X402ResourceInput> = {}): X402ResourceInput {
  return {
    merchant: OWNER,
    url: 'https://a.jp/x',
    description: 'd',
    priceJpyc: '100',
    category: 'api',
    payTo: OWNER,
    ...over,
  };
}

beforeEach(() => {
  store.kv.clear();
  store.lists.clear();
  store.failEval = false;
  store.failLrange = false;
  store.failGet = false;
});

describe('lib/x402/registry parseResourceInput', () => {
  it('valid (payTo 省略 → owner)', () => {
    const r = parseResourceInput(
      { url: 'https://a.jp/x', description: 'd', priceJpyc: '100', category: 'api' },
      OWNER,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.payTo).toBe(OWNER);
      expect(r.input.merchant).toBe(OWNER);
    }
  });

  it('valid (payTo 指定 → checksum)', () => {
    const pt = '0x2222222222222222222222222222222222222222';
    const r = parseResourceInput(
      { url: 'https://a.jp/x', description: 'd', priceJpyc: '100', category: 'api', payTo: pt },
      OWNER,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.payTo).toBe(getAddress(pt));
  });

  it.each([
    'https://open-pay.jp/api/paid/demo',
    'https://OPEN-PAY.JP:443/api/paid/stores',
    'https://open-pay.jp./api/paid/demo',
    'https://open-pay.jp/api/another-resource',
  ])('canonical OpenPay origin は first-party 専用のため拒否する: %s', (url) => {
    expect(
      parseResourceInput(
        { url, description: 'd', priceJpyc: '100', category: 'api' },
        OWNER,
      ),
    ).toEqual({ ok: false, reason: 'invalid_url' });
  });

  it('OpenPay の subdomain は canonical origin ではないため受理する', () => {
    expect(
      parseResourceInput(
        {
          url: 'https://merchant.open-pay.jp/paid',
          description: 'd',
          priceJpyc: '100',
          category: 'api',
        },
        OWNER,
      ).ok,
    ).toBe(true);
  });

  it('docsUrl は HTTPS のみ受理し、license は制御文字除去後 60 文字に収める', () => {
    const r = parseResourceInput(
      {
        url: 'https://a.jp/x',
        description: 'd',
        priceJpyc: '100',
        category: 'api',
        docsUrl: '  https://docs.example.jp/openapi.json  ',
        license: `  reuse\u0000${'a'.repeat(80)}  `,
      },
      OWNER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.docsUrl).toBe('https://docs.example.jp/openapi.json');
    expect(r.input.license).not.toContain('\u0000');
    expect(r.input.license).toHaveLength(60);

    expect(
      parseResourceInput(
        {
          url: 'https://a.jp/x',
          description: 'd',
          priceJpyc: '100',
          category: 'api',
          docsUrl: 'http://docs.example.jp/openapi.json',
        },
        OWNER,
      ),
    ).toEqual({ ok: false, reason: 'invalid_docs_url' });
    expect(
      parseResourceInput(
        {
          url: 'https://a.jp/x',
          description: 'd',
          priceJpyc: '100',
          category: 'api',
          docsUrl: `https://docs.example.jp/${'a'.repeat(512)}`,
        },
        OWNER,
      ),
    ).toEqual({ ok: false, reason: 'invalid_docs_url' });
  });

  it.each([
    ['invalid_url', { url: 'ftp://x', description: 'd', priceJpyc: '1', category: 'c' }],
    ['invalid_description', { url: 'https://a', description: '', priceJpyc: '1', category: 'c' }],
    ['invalid_price', { url: 'https://a', description: 'd', priceJpyc: '0', category: 'c' }],
    ['invalid_price', { url: 'https://a', description: 'd', priceJpyc: '1.5', category: 'c' }],
    ['invalid_category', { url: 'https://a', description: 'd', priceJpyc: '1', category: '' }],
    ['invalid_pay_to', { url: 'https://a', description: 'd', priceJpyc: '1', category: 'c', payTo: '0xzzz' }],
    // SSRF ガード: private / loopback / link-local 宛は invalid_url。
    ['invalid_url', { url: 'https://localhost/x', description: 'd', priceJpyc: '1', category: 'c' }],
    ['invalid_url', { url: 'http://127.0.0.1/x', description: 'd', priceJpyc: '1', category: 'c' }],
    ['invalid_url', { url: 'http://10.0.0.5/x', description: 'd', priceJpyc: '1', category: 'c' }],
    ['invalid_url', { url: 'http://169.254.169.254/latest', description: 'd', priceJpyc: '1', category: 'c' }],
    ['invalid_url', { url: 'http://192.168.1.1/x', description: 'd', priceJpyc: '1', category: 'c' }],
  ])('reject %s', (reason, body) => {
    expect(parseResourceInput(body, OWNER)).toEqual({ ok: false, reason });
  });

  it('requireAttestation: attested 無しは attestation_required', () => {
    const body = { url: 'https://a.jp/x', description: 'd', priceJpyc: '1', category: 'api' };
    expect(parseResourceInput(body, OWNER, { requireAttestation: true })).toEqual({
      ok: false,
      reason: 'attestation_required',
    });
    // attested:true なら通る。
    const ok = parseResourceInput({ ...body, attested: true }, OWNER, {
      requireAttestation: true,
    });
    expect(ok.ok).toBe(true);
  });

  it('requireAttestation 未指定 (編集) は attested 不要', () => {
    const body = { url: 'https://a.jp/x', description: 'd', priceJpyc: '1', category: 'api' };
    expect(parseResourceInput(body, OWNER).ok).toBe(true);
  });
});

describe('lib/x402/registry store', () => {
  it('createResource は parseResourceInput を迂回しても canonical OpenPay origin を保存しない', async () => {
    const res = await createResource(
      input({ url: 'https://open-pay.jp/api/paid/demo' }),
      'spoof',
      1000,
    );
    expect(res).toEqual({ ok: false, reason: 'invalid_url' });
    expect(store.kv.size).toBe(0);
    expect(store.lists.size).toBe(0);
  });

  it('createResource → getResource 往復 + 一覧 (owner / discovery) に出る', async () => {
    const res = await createResource(
      { merchant: OWNER, url: 'https://a.jp/x', description: 'd', priceJpyc: '100', category: 'api', payTo: OWNER },
      'id1',
      1000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resource.network).toBe('eip155:80002'); // testnet → Amoy CAIP-2
    expect(res.resource.active).toBe(true);
    expect(res.resource.updatedAt).toBe(1000);
    expect(await getResource('id1')).toEqual(res.resource);
    expect((await listResourcesForMerchant(OWNER))!.map((r) => r.id)).toContain('id1');
    expect((await listActiveResources())!.map((r) => r.id)).toContain('id1');
  });

  it('createResource: cap 到達なら too_many (原子的 cap・並列でも擦り抜けない)', async () => {
    // merchant index を cap (100) ぶん埋める → CAS_CREATE の LLEN 判定で -2 (作成しない)。
    store.lists.set(merchantResourcesKey(OWNER), Array(MAX_RESOURCES_PER_MERCHANT).fill('x'));
    const r = await createResource(input(), 'over', 1);
    expect(r).toEqual({ ok: false, reason: 'too_many' });
    expect(await getResource('over')).toBeNull(); // 保存もされない (原子的)
  });

  it('createResource: cap-1 件なら作成できる (境界)', async () => {
    store.lists.set(merchantResourcesKey(OWNER), Array(MAX_RESOURCES_PER_MERCHANT - 1).fill('x'));
    const r = await createResource(input(), 'last', 1);
    expect(r.ok).toBe(true);
  });

  it('createResource: KV エラー → storage (route は 503)', async () => {
    store.failEval = true;
    expect(await createResource(input(), 'x', 1)).toEqual({ ok: false, reason: 'storage' });
  });

  it('listActiveResources は inactive を除外', async () => {
    await createResource(
      { merchant: OWNER, url: 'https://a', description: 'd', priceJpyc: '1', category: 'c', payTo: OWNER },
      'act',
      1,
    );
    const inactive: X402Resource = {
      id: 'ina',
      merchant: OWNER,
      url: 'https://b',
      description: 'd',
      priceJpyc: '1',
      category: 'c',
      payTo: OWNER,
      network: 'eip155:80002',
      active: false,
      createdAt: 1,
    };
    store.kv.set(resourceKey('ina'), JSON.stringify(inactive));
    store.lists.set(RESOURCES_INDEX, ['ina', 'act']);
    const ids = (await listActiveResources())!.map((r) => r.id);
    expect(ids).toContain('act');
    expect(ids).not.toContain('ina');
  });

  it('hidden は index と owner 一覧に残し、公開 listActiveResources だけから除外', async () => {
    await createResource(input(), 'hidden', 1);
    const current = (await getResource('hidden'))!;
    store.kv.set(resourceKey('hidden'), JSON.stringify({ ...current, hidden: true }));

    expect(store.lists.get(RESOURCES_INDEX)).toContain('hidden');
    expect((await listActiveResources())!.map((r) => r.id)).not.toContain('hidden');
    expect((await listResourcesForMerchant(OWNER))!.map((r) => r.id)).toContain('hidden');
  });

  it('recordSettlement 保存 (会計記録)', async () => {
    const ok = await recordSettlement({
      id: 's1',
      payer: OWNER,
      payTo: OWNER,
      amount: '1000',
      fee: '10',
      txHash: `0x${'a'.repeat(64)}`,
      network: 'eip155:80002',
      createdAt: 1,
    });
    expect(ok).toBe(true);
    expect(store.kv.has('x402:settlement:s1')).toBe(true);
  });
});

describe('lib/x402/registry updateResource (owner 編集)', () => {
  beforeEach(async () => {
    await createResource(input(), 'id1', 1000);
  });

  it('owner が編集可能フィールドを更新 (id/merchant/network/createdAt/active は不変)', async () => {
    const newPayTo = getAddress('0x2222222222222222222222222222222222222222');
    const r = await updateResource(
      'id1',
      OWNER,
      input({
        url: 'https://a.jp/y',
        description: 'd2',
        priceJpyc: '200',
        category: 'data',
        payTo: newPayTo,
        docsUrl: 'https://docs.example.jp/openapi.json',
        license: 'Commercial reuse with attribution.',
      }),
      2000,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resource.url).toBe('https://a.jp/y');
    expect(r.resource.description).toBe('d2');
    expect(r.resource.priceJpyc).toBe('200');
    expect(r.resource.category).toBe('data');
    expect(r.resource.payTo).toBe(newPayTo);
    expect(r.resource.docsUrl).toBe('https://docs.example.jp/openapi.json');
    expect(r.resource.license).toBe('Commercial reuse with attribution.');
    expect(r.resource.updatedAt).toBe(2000);
    // 不変フィールド
    expect(r.resource.id).toBe('id1');
    expect(r.resource.merchant).toBe(OWNER);
    expect(r.resource.network).toBe('eip155:80002');
    expect(r.resource.createdAt).toBe(1000);
    expect(r.resource.active).toBe(true);
    // KV に永続化されている (再読込で同値)
    expect(await getResource('id1')).toEqual(r.resource);
  });

  it('更新は公開カタログ・owner 一覧に反映される', async () => {
    await updateResource('id1', OWNER, input({ priceJpyc: '777' }));
    expect((await listActiveResources())![0].priceJpyc).toBe('777');
    expect((await listResourcesForMerchant(OWNER))![0].priceJpyc).toBe('777');
  });

  it('URL 変更時だけ verification/hidden をリセットする', async () => {
    const current = (await getResource('id1'))!;
    store.kv.set(
      resourceKey('id1'),
      JSON.stringify({
        ...current,
        hidden: true,
        verification: {
          lastCheckedAt: '2026-07-14T00:00:00.000Z',
          failures: 3,
          lastRunId: '2026071400',
          probedUrl: current.url,
        },
      }),
    );
    await updateResource('id1', OWNER, input({ priceJpyc: '2' }));
    expect(await getResource('id1')).toMatchObject({
      hidden: true,
      verification: { failures: 3 },
    });

    await updateResource(
      'id1',
      OWNER,
      input({ url: 'https://a.jp/new-paid', priceJpyc: '3' }),
    );
    const changed = await getResource('id1');
    expect(changed).not.toHaveProperty('hidden');
    expect(changed).not.toHaveProperty('verification');
  });

  it('他人 (merchant !== owner) → forbidden で更新させない', async () => {
    const r = await updateResource('id1', STRANGER, input({ merchant: STRANGER, payTo: STRANGER }));
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
    // 元のまま (書き換わっていない)
    expect((await getResource('id1'))!.payTo).toBe(OWNER);
  });

  it('存在しない id → not_found', async () => {
    expect(await updateResource('nope', OWNER, input())).toEqual({ ok: false, reason: 'not_found' });
  });

  it('KV エラー → storage (not_found と区別)', async () => {
    store.failEval = true;
    const r = await updateResource('id1', OWNER, input({ priceJpyc: '5' }));
    expect(r).toEqual({ ok: false, reason: 'storage' });
  });

  it('破損 JSON (malformed) → storage (throw せず)', async () => {
    store.kv.set(resourceKey('id1'), '{not json');
    expect(await updateResource('id1', OWNER, input())).toEqual({ ok: false, reason: 'storage' });
  });

  it('soft-delete 済の編集は拒否 (監査データ保護・フィールド不変)', async () => {
    await deactivateResource('id1', OWNER);
    const before = await getResource('id1');
    const r = await updateResource('id1', OWNER, input({ priceJpyc: '9999', payTo: STRANGER }));
    expect(r).toEqual({ ok: false, reason: 'not_found' });
    expect(await getResource('id1')).toEqual(before); // 削除済 record は書き換わらない
  });
});

describe('lib/x402/registry deactivateResource (owner soft-delete)', () => {
  beforeEach(async () => {
    await createResource(input(), 'id1', 1000);
  });

  it('owner が無効化 → active:false・公開カタログと owner 一覧から消える (KV には残る)', async () => {
    const r = await deactivateResource('id1', OWNER);
    expect(r).toEqual({ ok: true });
    expect((await getResource('id1'))!.active).toBe(false); // データは残る (監査)
    expect(store.lists.get(RESOURCES_INDEX)).not.toContain('id1');
    expect((await listActiveResources())!.map((x) => x.id)).not.toContain('id1');
    expect((await listResourcesForMerchant(OWNER))!.map((x) => x.id)).not.toContain('id1');
  });

  it('無効化 id を discovery index から除去し、500 件 cap の奥にいた active を復帰させる', async () => {
    const fillerIds = Array.from({ length: 499 }, (_, i) => `f${i}`);
    const ids = ['gone', ...fillerIds, 'edge'];
    for (const id of ids) {
      store.kv.set(resourceKey(id), JSON.stringify(resource(id)));
    }
    store.lists.set(RESOURCES_INDEX, ids);

    expect((await listActiveResources())!.map((x) => x.id)).not.toContain('edge');
    expect(await deactivateResource('gone', OWNER)).toEqual({ ok: true });

    const index = store.lists.get(RESOURCES_INDEX) ?? [];
    expect(index).not.toContain('gone');
    expect(index).toHaveLength(500);
    expect((await listActiveResources())!.map((x) => x.id)).toContain('edge');
  });

  it('既に無効 → 冪等に ok', async () => {
    await deactivateResource('id1', OWNER);
    expect(await deactivateResource('id1', OWNER)).toEqual({ ok: true });
  });

  it('他人 → forbidden で無効化させない', async () => {
    expect(await deactivateResource('id1', STRANGER)).toEqual({ ok: false, reason: 'forbidden' });
    expect((await getResource('id1'))!.active).toBe(true);
  });

  it('存在しない id → not_found', async () => {
    expect(await deactivateResource('nope', OWNER)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('KV エラー → storage (not_found と区別)', async () => {
    store.failEval = true;
    expect(await deactivateResource('id1', OWNER)).toEqual({ ok: false, reason: 'storage' });
  });

  it('破損 JSON (malformed) → storage (throw せず)', async () => {
    store.kv.set(resourceKey('id1'), '{not json');
    expect(await deactivateResource('id1', OWNER)).toEqual({ ok: false, reason: 'storage' });
  });
});

describe('lib/x402/registry listResourcesForMerchant (active のみ)', () => {
  it('無効化済は owner 一覧から除外・有効分は残す', async () => {
    await createResource(input(), 'keep', 1);
    await createResource(input({ url: 'https://a.jp/gone' }), 'gone', 2);
    await deactivateResource('gone', OWNER);
    const ids = (await listResourcesForMerchant(OWNER))!.map((r) => r.id);
    expect(ids).toContain('keep');
    expect(ids).not.toContain('gone');
  });

  it('KV エラー (index 読取) → null ([] と誤認させない・outage 中の誤表示防止)', async () => {
    store.failLrange = true;
    expect(await listResourcesForMerchant(OWNER)).toBeNull();
  });

  it('KV エラー (record 単体取得) → null (有界並列でも 1 件でも失敗で null)', async () => {
    await createResource(input(), 'r1', 1);
    await createResource(input({ url: 'https://a.jp/b' }), 'r2', 2);
    store.failGet = true; // index は引けるが各 record の取得が失敗
    expect(await listResourcesForMerchant(OWNER)).toBeNull();
  });
});

describe('lib/x402/registry countMerchantResources (上限判定・soft-delete 込み)', () => {
  it('soft-delete 済も数える (create→delete 反復の濫用を上限が捕捉)', async () => {
    await createResource(input(), 'a', 1);
    await createResource(input({ url: 'https://a.jp/b' }), 'b', 2);
    await deactivateResource('b', OWNER);
    // owner 一覧 (active) は 1、cap 判定の総数は 2。
    expect((await listResourcesForMerchant(OWNER))!.length).toBe(1);
    expect(await countMerchantResources(OWNER)).toBe(2);
  });

  it('KV エラー → null (0 件と誤認して上限 bypass させない)', async () => {
    store.failLrange = true;
    expect(await countMerchantResources(OWNER)).toBeNull();
  });
});
