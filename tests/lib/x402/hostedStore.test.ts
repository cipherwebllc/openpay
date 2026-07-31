// hosted creator products ストアの検証 (クリエイター・ストア Phase 2)。
//
// 固定する契約 (いずれも計画レビューの指摘由来):
//   - external registry と **key 空間・index が完全に分離**していること
//     (global discovery index に触れない = 既存 discovery/reverify に影響しない)
//   - payTo が feeReceiver / forwarder なら**登録時に拒否** (H-2: 402 を出して署名させた後に
//     必ず失敗する商品を作らせない)
//   - saleActive と contentAvailable の分離 (H-5)
//   - content revision は不変・編集は新 revision で旧 revision を消さない (G)
//   - KV 障害を「商品なし」に潰さない ('storage' を返す)
//   - text sanitize は上限超過を切り捨てず拒否 (売り手の本文を黙って改変しない)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAddress } from 'viem';

const kvMocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  fail: false,
  evalCalls: [] as { keys: string[]; args: string[] }[],
}));

vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) =>
    kvMocks.fail
      ? { ok: false as const }
      : { ok: true as const, value: kvMocks.store.get(key) ?? null },
  ),
  kvSet: vi.fn(async (key: string, value: string) => {
    if (kvMocks.fail) return { ok: false as const };
    kvMocks.store.set(key, value);
    return { ok: true as const, value: 'OK' };
  }),
  kvDel: vi.fn(async (key: string) => {
    const existed = kvMocks.store.delete(key);
    return { ok: true as const, value: existed ? 1 : 0 };
  }),
  kvLrange: vi.fn(async (key: string) =>
    kvMocks.fail
      ? { ok: false as const }
      : { ok: true as const, value: kvMocks.lists.get(key) ?? [] },
  ),
  kvMget: vi.fn(async (keys: readonly string[]) =>
    kvMocks.fail
      ? { ok: false as const }
      : {
          ok: true as const,
          value: keys.map((key) => kvMocks.store.get(key) ?? null),
        },
  ),
  // Lua を JS で再現する (原子性は本番 Redis の保証・ここでは分岐の正しさを見る)。
  kvEval: vi.fn(async (script: string, keys: string[], args: string[]) => {
    if (kvMocks.fail) return { ok: false as const };
    kvMocks.evalCalls.push({ keys, args });
    if (script.includes("redis.call('LPUSH',KEYS[3],ARGV[3])")) {
      if (kvMocks.store.has(keys[0])) return { ok: true as const, value: -3 };
      const list = kvMocks.lists.get(keys[2]) ?? [];
      if (list.length >= Number(args[3])) return { ok: true as const, value: -2 };
      kvMocks.store.set(keys[0], args[0]);
      kvMocks.store.set(keys[1], args[1]);
      kvMocks.lists.set(keys[2], [args[2], ...list]);
      return { ok: true as const, value: 1 };
    }
    if (script.includes('if cur~=ARGV[2] then return -4 end')) {
      const cur = kvMocks.store.get(keys[0]);
      if (!cur) return { ok: true as const, value: 0 };
      const rec = JSON.parse(cur) as { owner: string };
      if (rec.owner.toLowerCase() !== args[0]) {
        return { ok: true as const, value: -1 };
      }
      if (cur !== args[1]) return { ok: true as const, value: -4 };
      if (args[2] === '1') {
        if (kvMocks.store.has(keys[1])) {
          return { ok: true as const, value: -4 };
        }
        kvMocks.store.set(keys[1], args[3]);
      }
      kvMocks.store.set(keys[0], args[4]);
      return { ok: true as const, value: 1 };
    }
    // UPDATE_HOSTED
    const cur = kvMocks.store.get(keys[0]);
    if (!cur) return { ok: true as const, value: 0 };
    const rec = JSON.parse(cur) as { owner: string };
    if (rec.owner.toLowerCase() !== args[0]) return { ok: true as const, value: -1 };
    kvMocks.store.set(keys[0], args[1]);
    return { ok: true as const, value: 1 };
  }),
}));

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const OTHER = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');

async function mod() {
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.resetModules();
  return import('@/lib/x402/hostedStore');
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    owner: OWNER,
    title: 'AI プロンプト集',
    priceJpyc: '300',
    contentKind: 'text' as const,
    content: 'これが本文です',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  kvMocks.store.clear();
  kvMocks.lists.clear();
  kvMocks.evalCalls.length = 0;
  kvMocks.fail = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('hosted 入力検証', () => {
  it('payTo が feeReceiver / forwarder なら拒否する (署名後に必ず失敗する商品を作らせない)', async () => {
    const { parseHostedInput } = await mod();
    expect(parseHostedInput(baseInput({ payTo: FEE_RECEIVER })).ok).toBe(false);
    expect(parseHostedInput(baseInput({ payTo: FORWARDER })).ok).toBe(false);
    // 通常の受取先は通る (payTo 省略時は owner)
    expect(parseHostedInput(baseInput()).ok).toBe(true);
    expect(parseHostedInput(baseInput({ payTo: OTHER })).ok).toBe(true);
  });

  it('価格・題名・content の境界を server 権威で弾く', async () => {
    const { parseHostedInput, MAX_HOSTED_TEXT_CODE_POINTS } = await mod();
    expect(parseHostedInput(baseInput({ priceJpyc: '0' })).ok).toBe(false);
    expect(parseHostedInput(baseInput({ priceJpyc: '1000001' })).ok).toBe(false);
    expect(parseHostedInput(baseInput({ priceJpyc: 300 })).ok).toBe(false);
    expect(parseHostedInput(baseInput({ priceJpyc: '1' })).ok).toBe(true);
    expect(parseHostedInput(baseInput({ title: '   ' })).ok).toBe(false);
    expect(parseHostedInput(baseInput({ title: 'x'.repeat(61) })).ok).toBe(false);
    // text の上限は切り捨てず拒否
    expect(
      parseHostedInput(
        baseInput({ content: 'あ'.repeat(MAX_HOSTED_TEXT_CODE_POINTS + 1) }),
      ).ok,
    ).toBe(false);
    expect(
      parseHostedInput(
        baseInput({ content: 'あ'.repeat(MAX_HOSTED_TEXT_CODE_POINTS) }),
      ).ok,
    ).toBe(true);
  });

  it('url 商品は https のみ (http/javascript/data を拒否)', async () => {
    const { parseHostedInput } = await mod();
    const url = (u: unknown) =>
      parseHostedInput(baseInput({ contentKind: 'url', content: u })).ok;
    expect(url('https://r2.example.com/a.pdf')).toBe(true);
    expect(url('http://r2.example.com/a.pdf')).toBe(false);
    expect(url('javascript:alert(1)')).toBe(false);
    expect(url('data:text/plain,hi')).toBe(false);
    expect(url(`https://x.example.com/${'a'.repeat(600)}`)).toBe(false);
  });

  it('商品画像は任意で、trim 済み https URL のみ 512 文字まで受理する', async () => {
    const { parseHostedInput, MAX_HOSTED_URL_LEN } = await mod();
    for (const imageUrl of [undefined, null, '', '   ']) {
      const parsed = parseHostedInput(baseInput({ imageUrl }));
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.product).not.toHaveProperty('imageUrl');
    }

    const accepted = parseHostedInput(
      baseInput({ imageUrl: '  https://cdn.example.com/product.png  ' }),
    );
    expect(accepted.ok && accepted.product.imageUrl).toBe(
      'https://cdn.example.com/product.png',
    );

    const prefix = 'https://cdn.example.com/';
    const atLimit = `${prefix}${'a'.repeat(MAX_HOSTED_URL_LEN - prefix.length)}`;
    expect(atLimit).toHaveLength(MAX_HOSTED_URL_LEN);
    expect(parseHostedInput(baseInput({ imageUrl: atLimit })).ok).toBe(true);

    for (const imageUrl of [
      'http://cdn.example.com/product.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      42,
      `${atLimit}a`,
    ]) {
      expect(parseHostedInput(baseInput({ imageUrl }))).toEqual({
        ok: false,
        error: 'invalid imageUrl',
      });
    }
  });

  it('追加ギャラリー画像は最大 4 枚の trim 済み https URL のみ受理する', async () => {
    const {
      parseHostedInput,
      MAX_HOSTED_GALLERY_IMAGES,
      MAX_HOSTED_URL_LEN,
    } = await mod();
    expect(MAX_HOSTED_GALLERY_IMAGES).toBe(4);

    const empty = parseHostedInput(baseInput({ galleryUrls: [] }));
    expect(empty.ok).toBe(true);
    expect(empty.ok && empty.product).not.toHaveProperty('galleryUrls');

    const four = Array.from(
      { length: MAX_HOSTED_GALLERY_IMAGES },
      (_, index) => `  https://cdn.example.com/gallery-${index}.png  `,
    );
    const accepted = parseHostedInput(baseInput({ galleryUrls: four }));
    expect(accepted.ok && accepted.product.galleryUrls).toEqual(
      four.map((url) => url.trim()),
    );

    const five = Array.from(
      { length: MAX_HOSTED_GALLERY_IMAGES + 1 },
      (_, index) => `https://cdn.example.com/gallery-${index}.png`,
    );
    expect(parseHostedInput(baseInput({ galleryUrls: five }))).toEqual({
      ok: false,
      error: 'too many gallery images',
    });

    const prefix = 'https://cdn.example.com/';
    const atLimit = `${prefix}${'a'.repeat(MAX_HOSTED_URL_LEN - prefix.length)}`;
    expect(
      parseHostedInput(baseInput({ galleryUrls: [atLimit] })).ok,
    ).toBe(true);
    for (const galleryUrls of [
      null,
      'https://cdn.example.com/gallery.png',
      ['http://cdn.example.com/gallery.png'],
      [''],
      [42],
      [`${atLimit}a`],
    ]) {
      expect(parseHostedInput(baseInput({ galleryUrls }))).toEqual({
        ok: false,
        error: 'invalid gallery image',
      });
    }
  });

  it('label 既定は kind から決まり、不正 label は既定へ倒す', async () => {
    const { parseHostedInput } = await mod();
    const textDefault = parseHostedInput(baseInput());
    const urlDefault = parseHostedInput(
      baseInput({ contentKind: 'url', content: 'https://e.example.com/a.zip' }),
    );
    expect(textDefault.ok && textDefault.product.label).toBe('prompt');
    expect(urlDefault.ok && urlDefault.product.label).toBe('download');
    const bogus = parseHostedInput(baseInput({ label: 'nope' }));
    expect(bogus.ok && bogus.product.label).toBe('prompt');
  });
});

describe('hosted 作成と分離', () => {
  it('作成は product/content/owner index を 1 EVAL で書き、**global discovery index に触れない**', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput(baseInput());
    if (!parsed.ok) throw new Error('setup');
    const created = await m.createHostedProduct(parsed, 1000);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // id は prefix 付きで external resource id と名前空間が分かれる
    expect(created.product.id.startsWith('h_')).toBe(true);
    expect(m.isHostedId(created.product.id)).toBe(true);

    // 触れたキーは hosted 名前空間のみ (x402:resources:index を含まない)
    const touched = kvMocks.evalCalls.flatMap((c) => c.keys);
    expect(touched).toEqual([
      `x402:hosted:${created.product.id}`,
      `x402:hosted:${created.product.id}:content:1`,
      `x402:hosted:owner:${OWNER.toLowerCase()}`,
    ]);
    expect(touched.some((k) => k.includes('x402:resources:index'))).toBe(false);
    expect(touched.some((k) => k === 'x402:resource')).toBe(false);
  });

  it('商品画像は購入時 snapshot に含めない (表示専用の不変 fence)', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput(
      baseInput({
        imageUrl: 'https://cdn.example.com/product.png',
        galleryUrls: [
          'https://cdn.example.com/gallery-1.png',
          'https://cdn.example.com/gallery-2.png',
        ],
      }),
    );
    if (!parsed.ok) throw new Error('setup');
    const created = await m.createHostedProduct(parsed, 1000);
    if (!created.ok) throw new Error('setup');

    expect(m.hostedPurchaseMetadata(created.product)).toEqual({
      owner: OWNER,
      payTo: OWNER,
      title: 'AI プロンプト集',
      priceJpyc: '300',
      contentKind: 'text',
      label: 'prompt',
    });
  });

  it('owner あたり上限を超えたら too_many (cap は Lua 内で判定)', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput(baseInput());
    if (!parsed.ok) throw new Error('setup');
    for (let i = 0; i < m.MAX_HOSTED_PER_OWNER; i += 1) {
      const r = await m.createHostedProduct(parsed, 1000 + i);
      expect(r.ok).toBe(true);
    }
    const over = await m.createHostedProduct(parsed, 9999);
    expect(over).toEqual({ ok: false, reason: 'too_many' });
  });

  it('KV 障害は storage として返し「商品なし」に潰さない', async () => {
    const m = await mod();
    kvMocks.fail = true;
    expect(await m.getHostedProduct('h_' + '0'.repeat(32))).toBe('storage');
    expect(await m.getHostedContent('h_' + '0'.repeat(32), 1)).toBe('storage');
    const parsed = m.parseHostedInput(baseInput());
    if (!parsed.ok) throw new Error('setup');
    expect(await m.createHostedProduct(parsed)).toEqual({
      ok: false,
      reason: 'storage',
    });
  });
});

describe('hosted 更新・revision・moderation', () => {
  async function seed(over: Record<string, unknown> = {}) {
    const m = await mod();
    const parsed = m.parseHostedInput(baseInput(over));
    if (!parsed.ok) throw new Error('setup');
    const created = await m.createHostedProduct(parsed, 1000);
    if (!created.ok) throw new Error('setup');
    return { m, id: created.product.id };
  }

  it('owner 以外の更新は forbidden', async () => {
    const { m, id } = await seed();
    expect(
      await m.updateHostedProduct({
        id,
        owner: OTHER,
        patch: { saleActive: false },
      }),
    ).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('販売停止 (saleActive=false) でも content は配信可のまま (恒久 entitlement の前提)', async () => {
    const { m, id } = await seed();
    const updated = await m.updateHostedProduct({
      id,
      owner: OWNER,
      patch: { saleActive: false },
      now: 2000,
    });
    expect(updated.ok && updated.product.saleActive).toBe(false);
    expect(updated.ok && updated.product.contentAvailable).toBe(true);
    expect(await m.getHostedContent(id, 1)).toEqual({
      kind: 'text',
      value: 'これが本文です',
    });
  });

  it('content 編集は新 revision を作り、旧 revision を消さない', async () => {
    const { m, id } = await seed();
    const res = await m.putHostedContentRevision({
      id,
      owner: OWNER,
      content: { kind: 'text', value: '第 2 版' },
      now: 3000,
    });
    expect(res.ok && res.product.contentRevision).toBe(2);
    // 旧 revision (既購入者が指す) が残っている
    expect(await m.getHostedContent(id, 1)).toEqual({
      kind: 'text',
      value: 'これが本文です',
    });
    expect(await m.getHostedContent(id, 2)).toEqual({
      kind: 'text',
      value: '第 2 版',
    });
  });

  it('運営の強制抹消は contentAvailable=false + 全 revision 削除・レコードは残す', async () => {
    const { m, id } = await seed();
    await m.putHostedContentRevision({
      id,
      owner: OWNER,
      content: { kind: 'text', value: '第 2 版' },
    });
    expect(await m.purgeHostedContent(id)).toBe(true);
    const after = await m.getHostedProduct(id);
    expect(after !== 'storage' && after?.contentAvailable).toBe(false);
    expect(after !== 'storage' && after?.saleActive).toBe(false);
    // レコードは残る (購入者に「提供終了」を返せる = 黙って 404 にしない)
    expect(after).not.toBeNull();
    expect(await m.getHostedContent(id, 1)).toBeNull();
    expect(await m.getHostedContent(id, 2)).toBeNull();
  });

  it('owner 一覧は他人のレコードを混ぜない', async () => {
    const { m, id } = await seed();
    // 他人の id を owner index に混入させても除外される
    kvMocks.lists.set(`x402:hosted:owner:${OWNER.toLowerCase()}`, [
      id,
      'h_' + 'f'.repeat(32),
    ]);
    kvMocks.store.set(
      `x402:hosted:h_${'f'.repeat(32)}`,
      JSON.stringify({
        id: 'h_' + 'f'.repeat(32),
        owner: OTHER,
        payTo: OTHER,
        title: '他人の商品',
        priceJpyc: '100',
        contentKind: 'text',
        contentRevision: 1,
        saleActive: true,
        contentAvailable: true,
        createdAt: 1,
      }),
    );
    const list = await m.listHostedForOwner(OWNER);
    expect(list?.map((p) => p.id)).toEqual([id]);
  });

  it('公開 snapshot は販売中かつ配信可能だけを MGET で返し、本文 key を読まない', async () => {
    const { m, id } = await seed();
    const inactiveId = 'h_' + 'e'.repeat(32);
    const unavailableId = 'h_' + 'd'.repeat(32);
    const base = await m.getHostedProduct(id);
    if (!base || base === 'storage') throw new Error('setup');
    kvMocks.store.set(
      `x402:hosted:${id}`,
      JSON.stringify({
        ...base,
        imageUrl: 'https://cdn.example.com/product.png',
        galleryUrls: [
          'https://cdn.example.com/gallery-1.png',
          'https://cdn.example.com/gallery-2.png',
        ],
      }),
    );
    kvMocks.lists.set(`x402:hosted:owner:${OWNER.toLowerCase()}`, [
      id,
      inactiveId,
      unavailableId,
    ]);
    kvMocks.store.set(
      `x402:hosted:${inactiveId}`,
      JSON.stringify({ ...base, id: inactiveId, saleActive: false }),
    );
    kvMocks.store.set(
      `x402:hosted:${unavailableId}`,
      JSON.stringify({
        ...base,
        id: unavailableId,
        contentAvailable: false,
      }),
    );

    const products = await m.listAvailableHostedForOwner(OWNER);

    expect(products?.map((product) => product.id)).toEqual([id]);
    expect(products?.[0]?.imageUrl).toBe(
      'https://cdn.example.com/product.png',
    );
    expect(products?.[0]?.galleryUrls).toEqual([
      'https://cdn.example.com/gallery-1.png',
      'https://cdn.example.com/gallery-2.png',
    ]);
    const { kvMget } = await import('@/lib/kv');
    expect(kvMget).toHaveBeenCalledWith([
      `x402:hosted:${id}`,
      `x402:hosted:${inactiveId}`,
      `x402:hosted:${unavailableId}`,
    ]);
    const mgetKeys = vi.mocked(kvMget).mock.calls.flatMap(([keys]) => keys);
    expect(mgetKeys.every((key) => !key.includes(':content:'))).toBe(true);
  });

  it('公開 snapshot は owner index が空なら空配列を返し、空 MGET を発行しない', async () => {
    const m = await mod();
    const products = await m.listAvailableHostedForOwner(OWNER);
    const { kvMget } = await import('@/lib/kv');

    expect(products).toEqual([]);
    expect(kvMget).not.toHaveBeenCalled();
  });

  it('seller full edit は公開メタと新 revision を 1 EVAL で確定し、旧 revision を残す', async () => {
    const { m, id } = await seed();
    const snapshot = await m.getHostedProductUpdateSnapshot(id);
    if (!snapshot || snapshot === 'storage') throw new Error('setup');
    const updated = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: {
        title: '更新後',
        desc: '説明',
        emoji: '🧠',
        imageUrl: 'https://cdn.example.com/product.png',
        galleryUrls: [
          'https://cdn.example.com/gallery-1.png',
          'https://cdn.example.com/gallery-2.png',
        ],
        priceJpyc: '500',
        label: 'api',
        saleActive: false,
      },
      content: { kind: 'text', value: '第 2 版' },
      now: 3000,
    });
    expect(updated.ok && updated.product).toMatchObject({
      title: '更新後',
      desc: '説明',
      emoji: '🧠',
      imageUrl: 'https://cdn.example.com/product.png',
      galleryUrls: [
        'https://cdn.example.com/gallery-1.png',
        'https://cdn.example.com/gallery-2.png',
      ],
      priceJpyc: '500',
      label: 'api',
      saleActive: false,
      contentRevision: 2,
    });
    expect(await m.getHostedContent(id, 1)).toEqual({
      kind: 'text',
      value: 'これが本文です',
    });
    expect(await m.getHostedContent(id, 2)).toEqual({
      kind: 'text',
      value: '第 2 版',
    });
    const atomicCall = kvMocks.evalCalls.at(-1);
    expect(atomicCall?.keys).toEqual([
      `x402:hosted:${id}`,
      `x402:hosted:${id}:content:2`,
    ]);
  });

  it('seller full edit は空の追加ギャラリーで既存画像を削除する', async () => {
    const { m, id } = await seed({
      galleryUrls: ['https://cdn.example.com/gallery.png'],
    });
    const snapshot = await m.getHostedProductUpdateSnapshot(id);
    if (!snapshot || snapshot === 'storage') throw new Error('setup');

    const updated = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: {
        title: snapshot.product.title,
        galleryUrls: [],
        priceJpyc: snapshot.product.priceJpyc,
        label: snapshot.product.label,
        saleActive: snapshot.product.saleActive,
      },
      now: 3000,
    });

    expect(updated.ok).toBe(true);
    expect(updated.ok && updated.product).not.toHaveProperty('galleryUrls');
    const stored = await m.getHostedProduct(id);
    expect(stored).not.toBe('storage');
    expect(stored).not.toHaveProperty('galleryUrls');
  });

  it('stale seller snapshot は 409 用 conflict にし、新 revision を上書きしない', async () => {
    const { m, id } = await seed();
    const snapshot = await m.getHostedProductUpdateSnapshot(id);
    if (!snapshot || snapshot === 'storage') throw new Error('setup');
    await m.updateHostedProduct({
      owner: OWNER,
      id,
      patch: { saleActive: false },
      now: 2000,
    });
    const result = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: {
        title: 'stale',
        priceJpyc: '500',
        label: 'api',
        saleActive: true,
      },
      content: { kind: 'text', value: '上書きしてはいけない' },
    });
    expect(result).toEqual({ ok: false, reason: 'conflict' });
    expect(await m.getHostedContent(id, 2)).toBeNull();
  });

  it('孤児の next revision key が既にあれば上書きせず conflict にする', async () => {
    const { m, id } = await seed();
    const snapshot = await m.getHostedProductUpdateSnapshot(id);
    if (!snapshot || snapshot === 'storage') throw new Error('setup');
    kvMocks.store.set(
      m.hostedContentKey(id, 2),
      JSON.stringify({ kind: 'text', value: '既存の孤児 revision' }),
    );

    const result = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: {
        title: '更新後',
        priceJpyc: '500',
        label: 'prompt',
        saleActive: false,
      },
      content: { kind: 'text', value: '上書きしてはいけない' },
    });

    expect(result).toEqual({ ok: false, reason: 'conflict' });
    expect(await m.getHostedContent(id, 2)).toEqual({
      kind: 'text',
      value: '既存の孤児 revision',
    });
    const product = await m.getHostedProduct(id);
    expect(product !== 'storage' && product?.contentRevision).toBe(1);
  });
});

describe('KV 読込の untrusted 検証', () => {
  it('壊れた行・不正 id・不正 price は null に落ちる', async () => {
    const { parseStoredHostedProduct } = await mod();
    expect(parseStoredHostedProduct('not json')).toBeNull();
    expect(parseStoredHostedProduct(JSON.stringify({ id: 'nope' }))).toBeNull();
    const valid = {
      id: 'h_' + '0'.repeat(32),
      owner: OWNER,
      payTo: OWNER,
      title: 'ok',
      priceJpyc: '100',
      contentKind: 'text',
      contentRevision: 1,
      saleActive: true,
      contentAvailable: true,
      createdAt: 1,
    };
    const legacy = parseStoredHostedProduct(JSON.stringify(valid));
    expect(legacy?.title).toBe('ok');
    expect(legacy).not.toHaveProperty('imageUrl');
    expect(legacy).not.toHaveProperty('galleryUrls');
    expect(
      parseStoredHostedProduct(
        JSON.stringify({
          ...valid,
          imageUrl: ' https://cdn.example.com/product.png ',
        }),
      )?.imageUrl,
    ).toBe('https://cdn.example.com/product.png');
    expect(
      parseStoredHostedProduct(
        JSON.stringify({
          ...valid,
          galleryUrls: [
            ' https://cdn.example.com/gallery-1.png ',
            'https://cdn.example.com/gallery-2.png',
          ],
        }),
      )?.galleryUrls,
    ).toEqual([
      'https://cdn.example.com/gallery-1.png',
      'https://cdn.example.com/gallery-2.png',
    ]);
    const invalidGallery = parseStoredHostedProduct(
      JSON.stringify({ ...valid, galleryUrls: 'https://cdn.example.com/a.png' }),
    );
    expect(invalidGallery?.title).toBe('ok');
    expect(invalidGallery).not.toHaveProperty('galleryUrls');
    expect(
      parseStoredHostedProduct(JSON.stringify({ ...valid, priceJpyc: '01' })),
    ).toBeNull();
    expect(
      parseStoredHostedProduct(JSON.stringify({ ...valid, contentRevision: 0 })),
    ).toBeNull();
    // saleActive が壊れている行は「販売停止」に倒す (誤って売らない側)
    expect(
      parseStoredHostedProduct(JSON.stringify({ ...valid, saleActive: 'yes' }))
        ?.saleActive,
    ).toBe(false);
  });
});

describe('出品者の販売者情報 (特商法対応)', () => {
  it('name/contact 必須・上限・disclosure の任意記載', async () => {
    const { parseSellerDisclosureInput } = await mod();
    expect(parseSellerDisclosureInput({ name: '', contact: 'a@b.c' }).ok).toBe(false);
    expect(parseSellerDisclosureInput({ name: '山田太郎', contact: '' }).ok).toBe(false);
    expect(
      parseSellerDisclosureInput({ name: 'x'.repeat(61), contact: 'a@b.c' }).ok,
    ).toBe(false);
    const ok = parseSellerDisclosureInput({
      name: '山田太郎',
      contact: 'seller@example.com',
      disclosure: '住所: 東京都…\n電話: 03-xxxx-xxxx',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.disclosure).toContain('住所');
      // 改行は保持される (法定事項の列挙に必要)
      expect(ok.value.disclosure).toContain('\n');
    }
    expect(
      parseSellerDisclosureInput({
        name: 'a',
        contact: 'a@b.c',
        disclosure: 'x'.repeat(1001),
      }).ok,
    ).toBe(false);
  });

  it('put→get round-trip・未登録は null・KV 障害は storage (黙って許可しない)', async () => {
    const m = await mod();
    expect(await m.sellerDisclosureComplete(OWNER)).toBe(false);
    expect(
      await m.putSellerDisclosure(
        OWNER,
        { name: '山田太郎', contact: 'seller@example.com' },
        123,
      ),
    ).toBe(true);
    const got = await m.getSellerDisclosure(OWNER);
    expect(got !== 'storage' && got !== null && got.name).toBe('山田太郎');
    expect(await m.sellerDisclosureComplete(OWNER)).toBe(true);
    kvMocks.fail = true;
    expect(await m.sellerDisclosureComplete(OWNER)).toBe('storage');
  });
});
