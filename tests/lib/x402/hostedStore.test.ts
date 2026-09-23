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
    throw new Error('Unexpected hosted script');
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
  it('details は code points 上限・改行保持・CRLF 正規化・制御文字除去を適用する', async () => {
    const { parseHostedInput, MAX_HOSTED_DETAILS_LEN } = await mod();
    expect(MAX_HOSTED_DETAILS_LEN).toBe(2000);
    const details = '😀'.repeat(MAX_HOSTED_DETAILS_LEN);
    const atLimit = parseHostedInput(baseInput({ details }));
    expect(atLimit.ok && atLimit.product.details).toBe(details);
    for (const invalid of [details + 'a', 42, {}, []]) {
      expect(parseHostedInput(baseInput({ details: invalid }))).toEqual({ ok: false, error: 'invalid details' });
    }
    const cleaned = parseHostedInput(baseInput({ details: ' \u0000A\r\nB\nC\t\r\u007f\u200b\ud800 ' }));
    expect(cleaned.ok && cleaned.product.details).toBe('A\nB\nC');
  });

  it('specs は各 code point 上限と 8 行を許可し、不正行を拒否する', async () => {
    const { parseHostedInput, MAX_HOSTED_SPECS, MAX_HOSTED_SPEC_LABEL_LEN, MAX_HOSTED_SPEC_VALUE_LEN } = await mod();
    expect([MAX_HOSTED_SPECS, MAX_HOSTED_SPEC_LABEL_LEN, MAX_HOSTED_SPEC_VALUE_LEN]).toEqual([8, 24, 80]);
    const row = { label: '😀'.repeat(24), value: '😀'.repeat(80) };
    const specs = Array.from({ length: 8 }, () => row);
    const atLimit = parseHostedInput(baseInput({ specs }));
    expect(atLimit.ok && atLimit.product.specs).toEqual(specs);
    for (const invalid of [
      [...specs, row], [{ ...row, label: row.label + 'a' }], [{ ...row, value: row.value + 'a' }],
      [{ label: ' \t ', value: 'GLB' }], [{ label: '形式', value: '\u0000' }],
      [{ label: 1, value: 'GLB' }], [{ label: '形式' }], [null], [[]], '形式: GLB', {},
    ]) {
      expect(parseHostedInput(baseInput({ specs: invalid }))).toEqual({ ok: false, error: 'invalid specs' });
    }
    const cleaned = parseHostedInput(baseInput({ specs: [{ label: ' \u0000形\n式\u200b ', value: ' GL\tB\r\n\u007f ' }] }));
    expect(cleaned.ok && cleaned.product.specs).toEqual([{ label: '形式', value: 'GLB' }]);
  });

  it('demoUrl は imageUrl と同じ https・長さ・trim 規則で検証する', async () => {
    const { parseHostedInput, MAX_HOSTED_URL_LEN } = await mod();
    const atLimit = 'https://example.com/' + 'x'.repeat(MAX_HOSTED_URL_LEN - 20);
    expect(atLimit.length).toBe(MAX_HOSTED_URL_LEN);
    for (const value of [atLimit, atLimit + 'x', ' https://example.com/demo ', 'http://example.com', 'javascript:alert(1)', 'data:text/plain,demo', '/demo', 42]) {
      const demo = parseHostedInput(baseInput({ demoUrl: value }));
      const image = parseHostedInput(baseInput({ imageUrl: value }));
      expect(demo.ok).toBe(image.ok);
      if (image.ok && demo.ok) expect(demo.product.demoUrl).toBe(image.product.imageUrl);
      else expect(demo).toEqual({ ok: false, error: 'invalid demoUrl' });
    }
  });

  it('表示詳細の省略・null・空欄は未設定にする', async () => {
    const { parseHostedInput } = await mod();
    for (const input of [{}, { details: null, specs: null, demoUrl: null }, { details: '', specs: [], demoUrl: '' }, { details: ' \r\n\t\u0000 ', demoUrl: '  ' }]) {
      const parsed = parseHostedInput(baseInput(input));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error);
      for (const key of ['details', 'specs', 'demoUrl']) expect(parsed.product).not.toHaveProperty(key);
    }
  });

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
  it('usdcEnabled は保存値 true だけが ON で create/read/list/full-replace を伝播する', async () => {
    const m = await mod();
    expect(m.parseHostedInput(baseInput()).ok).toBe(true);
    const off = m.parseHostedInput(baseInput({ usdcEnabled: false }));
    expect(off.ok && off.product).not.toHaveProperty('usdcEnabled');
    expect(m.parseHostedInput(baseInput({ usdcEnabled: 'true' }))).toEqual({
      ok: false,
      error: 'invalid usdcEnabled',
    });

    const parsed = m.parseHostedInput(baseInput({ usdcEnabled: true }));
    if (!parsed.ok) throw new Error('setup');
    const created = await m.createHostedProduct(parsed, 1000);
    if (!created.ok) throw new Error('setup');
    expect(created.product.usdcEnabled).toBe(true);
    expect((await m.getHostedProduct(created.product.id))).toMatchObject({
      usdcEnabled: true,
    });
    expect(await m.listHostedForOwner(OWNER)).toEqual([
      expect.objectContaining({ usdcEnabled: true }),
    ]);
    expect(await m.listAvailableHostedForOwner(OWNER)).toEqual([
      expect.objectContaining({ usdcEnabled: true }),
    ]);

    const raw = JSON.parse(
      kvMocks.store.get(`x402:hosted:${created.product.id}`) ?? '{}',
    ) as Record<string, unknown>;
    raw.usdcEnabled = false;
    expect(m.parseStoredHostedProduct(JSON.stringify(raw))).not.toHaveProperty(
      'usdcEnabled',
    );
    delete raw.usdcEnabled;
    expect(m.parseStoredHostedProduct(JSON.stringify(raw))).not.toHaveProperty(
      'usdcEnabled',
    );

    const snapshot = await m.getHostedProductUpdateSnapshot(created.product.id);
    if (!snapshot || snapshot === 'storage') throw new Error('setup');
    const replaced = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: {
        title: created.product.title,
        priceJpyc: created.product.priceJpyc,
        label: created.product.label,
        usdcEnabled: true,
        saleActive: false,
      },
      now: 2000,
    });
    expect(replaced.ok && replaced.product.usdcEnabled).toBe(true);
  });

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

  it('商品画像/カテゴリ/タグは購入時 snapshot に含めない (表示専用の不変 fence)', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput(
      baseInput({
        details: '内容物\n使い方',
        specs: [{ label: '形式', value: 'GLB' }],
        demoUrl: 'https://example.com/demo',
        imageUrl: 'https://cdn.example.com/product.png',
        galleryUrls: [
          'https://cdn.example.com/gallery-1.png',
          'https://cdn.example.com/gallery-2.png',
        ],
        // P1 (Store 統合): 表示メタも snapshot 非対象であることを同じ fence で固定する
        category: 'ai',
        tags: ['prompt', '画像生成'],
        handle: 'alice',
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

  it('category/tags: 正常系は保存され、寛容系は落ち、違反は明示エラー (P1)', async () => {
    const m = await mod();
    // 正常: enum カテゴリ + タグ (trim/dedupe)
    const okParsed = m.parseHostedInput(
      baseInput({ category: '3d-game', tags: [' vrm ', 'vrm', 'unity'] }),
    );
    if (!okParsed.ok) throw new Error(okParsed.error);
    expect(okParsed.product.category).toBe('3d-game');
    expect(okParsed.product.tags).toEqual(['vrm', 'unity']);

    // 未指定/空文字は undefined (後方互換)
    const noneParsed = m.parseHostedInput(baseInput({ category: '' }));
    if (!noneParsed.ok) throw new Error(noneParsed.error);
    expect(noneParsed.product.category).toBeUndefined();
    expect(noneParsed.product.tags).toBeUndefined();

    // 違反は明示エラー
    expect(m.parseHostedInput(baseInput({ category: 'not-a-category' }))).toEqual({
      ok: false,
      error: 'invalid category',
    });
    expect(
      m.parseHostedInput(baseInput({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] })),
    ).toEqual({ ok: false, error: 'too many tags' });
    expect(
      m.parseHostedInput(baseInput({ tags: ['x'.repeat(25)] })),
    ).toEqual({ ok: false, error: 'tag too long' });
  });

  it('stored 読込: 不正な category/tags は落として商品自体は残す (寛容読込)', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput(baseInput({ category: 'ai', tags: ['ok'] }));
    if (!parsed.ok) throw new Error('setup');
    const created = await m.createHostedProduct(parsed, 1000);
    if (!created.ok) throw new Error('setup');
    const raw = JSON.parse(JSON.stringify(created.product)) as Record<string, unknown>;
    raw.category = 'bogus';
    raw.tags = ['ok', 42];
    const reread = m.parseStoredHostedProduct(JSON.stringify(raw));
    expect(reread).not.toBeNull();
    expect(reread?.category).toBeUndefined();
    expect(reread?.tags).toBeUndefined();
    // 正常値はそのまま読める
    const clean = m.parseStoredHostedProduct(JSON.stringify(created.product));
    expect(clean?.category).toBe('ai');
    expect(clean?.tags).toEqual(['ok']);
  });

  it('selectProfileProducts: featured が 1 つでもあればそれだけ・無ければ全件 (厳選ショーケース)', async () => {
    const m = await mod();
    const a = { id: 'a', featured: true };
    const b: { id: string; featured?: boolean } = { id: 'b' };
    const c = { id: 'c', featured: false };
    expect(m.selectProfileProducts([a, b, c])).toEqual({
      shown: [a],
      hiddenCount: 2,
    });
    expect(m.selectProfileProducts([b, c])).toEqual({
      shown: [b, c],
      hiddenCount: 0,
    });
    expect(m.selectProfileProducts([])).toEqual({ shown: [], hiddenCount: 0 });
  });

  it('handle (掲載先): 形式検証・寛容読込・replace 引継ぎ (誤帰属修正 2026-08-04)', async () => {
    const m = await mod();
    const okParsed = m.parseHostedInput(baseInput({ handle: 'Alice' }));
    if (!okParsed.ok) throw new Error(okParsed.error);
    expect(okParsed.product.handle).toBe('alice'); // normalize
    expect(m.parseHostedInput(baseInput({ handle: 'a' }))).toEqual({
      ok: false,
      error: 'invalid handle',
    });
    const noneParsed = m.parseHostedInput(baseInput({ handle: '' }));
    if (!noneParsed.ok) throw new Error(noneParsed.error);
    expect(noneParsed.product.handle).toBeUndefined();

    const created = await m.createHostedProduct(okParsed, 1000);
    if (!created.ok) throw new Error('setup');
    const raw = JSON.parse(JSON.stringify(created.product)) as Record<string, unknown>;
    raw.handle = '!bad!';
    expect(m.parseStoredHostedProduct(JSON.stringify(raw))?.handle).toBeUndefined();
    expect(
      m.parseStoredHostedProduct(JSON.stringify(created.product))?.handle,
    ).toBe('alice');
    const snapshot = await m.getHostedProductUpdateSnapshot(created.product.id);
    if (!snapshot || snapshot === 'storage') throw new Error('setup');
    const replaced = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: {
        title: created.product.title,
        priceJpyc: created.product.priceJpyc,
        label: created.product.label,
        handle: created.product.handle,
        saleActive: false,
      },
      now: 2000,
    });
    if (!replaced.ok) throw new Error(replaced.reason);
    expect(replaced.product.handle).toBe('alice');
  });

  it('replaceHostedSellerProduct: category/tags を metadata で引き継げる (編集/toggle で消えない)', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput(baseInput({ category: 'ai', tags: ['prompt'] }));
    if (!parsed.ok) throw new Error('setup');
    const created = await m.createHostedProduct(parsed, 1000);
    if (!created.ok) throw new Error('setup');
    const snapshot = await m.getHostedProductUpdateSnapshot(created.product.id);
    if (!snapshot || snapshot === 'storage') throw new Error('setup');
    const replaced = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: {
        title: created.product.title,
        priceJpyc: created.product.priceJpyc,
        label: created.product.label,
        category: created.product.category,
        tags: created.product.tags,
        saleActive: false,
      },
      now: 2000,
    });
    if (!replaced.ok) throw new Error(replaced.reason);
    expect(replaced.product.category).toBe('ai');
    expect(replaced.product.tags).toEqual(['prompt']);
    expect(replaced.product.saleActive).toBe(false);
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
    const snapshot = await m.getHostedProductUpdateSnapshot(created.product.id);
    if (!snapshot || snapshot === 'storage') throw new Error('setup');
    return { m, id: created.product.id, snapshot };
  }

  it('owner 以外の更新は forbidden', async () => {
    const { m, snapshot } = await seed();
    expect(
      await m.replaceHostedSellerProduct({
        snapshot,
        owner: OTHER,
        metadata: { ...snapshot.product, saleActive: false },
      }),
    ).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('販売停止 (saleActive=false) でも content は配信可のまま (恒久 entitlement の前提)', async () => {
    const { m, id, snapshot } = await seed();
    const updated = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: { ...snapshot.product, saleActive: false },
      now: 2000,
    });
    expect(updated.ok && updated.product.saleActive).toBe(false);
    expect(updated.ok && updated.product.contentAvailable).toBe(true);
    expect(await m.getHostedContent(id, 1)).toEqual({
      kind: 'text',
      value: 'これが本文です',
    });
  });

  // D2: 書込時に https 検証済みでも、読出側で scheme を再検証する。KV 改竄や旧レコードの
  // javascript:/data: が購入者の遷移先として配信されるのを配信直前で断つ (imageUrl と同じ方針)。
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['http://r2.example.com/a.pdf'],
  ])('url content の読出で非 https (%s) は null に倒す', async (value) => {
    const { m, id } = await seed({
      contentKind: 'url',
      content: 'https://r2.example.com/a.pdf',
    });
    // 書込経路を迂回して KV の生値を差し替える (改竄 / 旧レコードの再現)。
    kvMocks.store.set(m.hostedContentKey(id, 1), JSON.stringify({ kind: 'url', value }));
    expect(await m.getHostedContent(id, 1)).toBeNull();
  });

  it('url content の読出は https ならそのまま返す', async () => {
    const { m, id } = await seed({
      contentKind: 'url',
      content: 'https://r2.example.com/a.pdf',
    });
    expect(await m.getHostedContent(id, 1)).toEqual({
      kind: 'url',
      value: 'https://r2.example.com/a.pdf',
    });
  });

  it('content 編集は新 revision を作り、旧 revision を消さない', async () => {
    const { m, id, snapshot } = await seed();
    const res = await m.replaceHostedSellerProduct({
      snapshot,
      owner: OWNER,
      metadata: snapshot.product,
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
    await m.replaceHostedSellerProduct({
      owner: OWNER,
      snapshot,
      metadata: { ...snapshot.product, saleActive: false },
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


describe('商品詳細メタ: レビュー指摘の固定', () => {
  it('details: 単独 CR も改行・3 連続以上の改行は 2 つに畳む (改行だけで縦に伸びる表示破綻を断つ)', async () => {
    const { parseHostedInput } = await mod();
    const lone = parseHostedInput(baseInput({ details: 'A\rB' }));
    expect(lone.ok && lone.product.details).toBe('A\nB');
    const tall = parseHostedInput(baseInput({ details: `a${'\n'.repeat(1998)}b` }));
    expect(tall.ok && tall.product.details).toBe('a\n\nb');
  });

  it('specs: ラベルのコロンは拒否 (「ラベル: 値」編集の往復で化けるため)・値のコロンは可', async () => {
    const { parseHostedInput, parseStoredHostedProduct } = await mod();
    for (const label of ['Ratio 16:9', '比率：横']) {
      expect(parseHostedInput(baseInput({ specs: [{ label, value: 'yes' }] }))).toEqual({ ok: false, error: 'invalid specs' });
    }
    const ok = parseHostedInput(baseInput({ specs: [{ label: '比率', value: '16:9' }] }));
    expect(ok.ok && ok.product.specs).toEqual([{ label: '比率', value: '16:9' }]);
    // 保存済みに混ざっていても商品は読め、その行だけ落ちる
    if (!ok.ok) throw new Error('setup');
    const created = await (await mod()).createHostedProduct(ok, 1000);
    if (!created.ok) throw new Error('setup');
    const stored = { ...JSON.parse(JSON.stringify(created.product)), specs: [{ label: 'a:b', value: 'x' }, { label: '形式', value: 'GLB' }] };
    expect(parseStoredHostedProduct(JSON.stringify(stored))?.specs).toEqual([{ label: '形式', value: 'GLB' }]);
  });

  it('保存済みの demoUrl が javascript: / data: / http: でも描画前に落とす (読出再検証 = 唯一の防波堤)', async () => {
    const m = await mod();
    const { parseHostedInput, parseStoredHostedProduct } = m;
    const ok = parseHostedInput(baseInput({}));
    if (!ok.ok) throw new Error('setup');
    const created = await m.createHostedProduct(ok, 1000);
    if (!created.ok) throw new Error('setup');
    for (const demoUrl of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'http://example.com', '//example.com/x']) {
      const reread = parseStoredHostedProduct(JSON.stringify({ ...JSON.parse(JSON.stringify(created.product)), demoUrl }));
      expect(reread).not.toBeNull();
      expect(reread).not.toHaveProperty('demoUrl');
    }
  });

  it('購入 snapshot のキー集合は表示メタを足しても完全に不変 (4 つ目の表示項目を足す人への柵)', async () => {
    const { parseHostedInput, hostedPurchaseMetadata } = await mod();
    const plain = parseHostedInput(baseInput({}));
    const rich = parseHostedInput(baseInput({
      details: '内容物', specs: [{ label: '形式', value: 'GLB' }], demoUrl: 'https://example.com/demo',
      imageUrl: 'https://example.com/a.png', galleryUrls: ['https://example.com/b.png'], tags: ['3d'], category: '3d-game',
    }));
    if (!plain.ok || !rich.ok) throw new Error('setup');
    const a = hostedPurchaseMetadata({ ...plain.product, id: 'p1', createdAt: 1 });
    const b = hostedPurchaseMetadata({ ...rich.product, id: 'p1', createdAt: 1 });
    expect(b).toEqual(a);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  });
});

describe('商品詳細メタの保存と寛容読込', () => {
  it('作成・公開読込・編集・クリアを通じて保存し、購入 snapshot は不変', async () => {
    const m = await mod();
    const details = { details: '内容物\n使い方', specs: [{ label: '形式', value: 'GLB' }], demoUrl: 'https://example.com/demo' };
    const parsed = m.parseHostedInput(baseInput(details));
    if (!parsed.ok) throw new Error(parsed.error);
    const created = await m.createHostedProduct(parsed);
    if (!created.ok) throw new Error('setup');
    expect(await m.getHostedProduct(created.product.id)).toMatchObject(details);
    expect(await m.listAvailableHostedForOwner(OWNER)).toEqual([expect.objectContaining(details)]);
    const purchase = m.hostedPurchaseMetadata(created.product);
    for (const key of Object.keys(details)) expect(purchase).not.toHaveProperty(key);
    for (const metadata of [{ ...details, details: '更新後', specs: [{ label: 'サイズ', value: '12 MB' }], demoUrl: 'https://example.com/v2' }, {}]) {
      const snapshot = await m.getHostedProductUpdateSnapshot(created.product.id);
      if (!snapshot || snapshot === 'storage') throw new Error('setup');
      const updated = await m.replaceHostedSellerProduct({ snapshot, owner: OWNER, metadata: {
        title: snapshot.product.title, priceJpyc: snapshot.product.priceJpyc, label: snapshot.product.label, saleActive: true, ...metadata,
      } });
      expect(updated.ok).toBe(true);
      const stored = await m.getHostedProduct(created.product.id);
      if (!stored || stored === 'storage') throw new Error('setup');
      expect(stored.contentRevision).toBe(1);
      expect(m.hostedPurchaseMetadata(stored)).toEqual(purchase);
      if ('details' in metadata) expect(stored).toMatchObject(metadata);
      else for (const key of Object.keys(details)) expect(stored).not.toHaveProperty(key);
    }
  });

  it('不正な詳細・URL・仕様行だけを落とし、正常な仕様は最大 8 行残す', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput(baseInput());
    if (!parsed.ok) throw new Error(parsed.error);
    const valid = { ...parsed.product, id: 'h_' + 'a'.repeat(32), createdAt: 1 };
    for (const bad of [
      { details: {}, specs: 'bad', demoUrl: false },
      { details: 'a'.repeat(2001), specs: [{ label: '', value: 'GLB' }], demoUrl: 'http://example.com' },
    ]) {
      const product = m.parseStoredHostedProduct(JSON.stringify({ ...valid, ...bad }));
      expect(product?.title).toBe(valid.title);
      for (const key of Object.keys(bad)) expect(product).not.toHaveProperty(key);
    }
    const row = { label: ' 形\t式 ', value: ' GLB ' };
    const product = m.parseStoredHostedProduct(JSON.stringify({ ...valid,
      details: ' A\r\nB\u0000 ', demoUrl: ' https://example.com/demo ',
      specs: [null, { label: '', value: 'bad' }, ...Array.from({ length: 9 }, () => row)],
    }));
    expect(product).toMatchObject({ details: 'A\nB', demoUrl: 'https://example.com/demo', specs: Array.from({ length: 8 }, () => ({ label: '形式', value: 'GLB' })) });
  });
});
