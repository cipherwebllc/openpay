// @vitest-environment node
// hostedStore 分割 (Phase 6 R15a) の固定。facade (lib/x402/hostedStore) の公開名・KV に送る
// Lua の bytes と KEYS/ARGV の順序・保存 JSON の bytes (プロパティ順を含む)・読込の key を、
// 分割前のコードで採取した期待値に固定する。値はすべて分割前 (origin/main 7fe944c3) で
// 採取・通過を確認したもの。ここが変わるなら KV の互換性 (既存レコード・Lua の原子性) を
// 壊している疑いがある。
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

type KvCall = [string, ...unknown[]];

const h = vi.hoisted(() => ({
  calls: [] as KvCall[],
  scripts: [] as string[],
  store: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  evalResults: [] as ({ ok: false } | { ok: true; value: number })[],
  failRead: false,
  licenseCreate: vi.fn(),
}));

vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) => {
    h.calls.push(['kvGet', key]);
    return h.failRead ? { ok: false } : { ok: true, value: h.store.get(key) ?? null };
  }),
  kvSet: vi.fn(async (key: string, value: string) => {
    h.calls.push(['kvSet', key, value]);
    h.store.set(key, value);
    return { ok: true, value: 'OK' };
  }),
  kvLrange: vi.fn(async (key: string, start: number, stop: number) => {
    h.calls.push(['kvLrange', key, start, stop]);
    return { ok: true, value: h.lists.get(key) ?? [] };
  }),
  kvMget: vi.fn(async (keys: readonly string[]) => {
    h.calls.push(['kvMget', [...keys]]);
    return { ok: true, value: keys.map((key) => h.store.get(key) ?? null) };
  }),
  kvEval: vi.fn(async (script: string, keys: string[], args: string[]) => {
    h.scripts.push(script);
    h.calls.push(['kvEval', sha(script), [...keys], [...args]]);
    return h.evalResults.shift() ?? { ok: true, value: 1 };
  }),
}));
vi.mock('@/lib/license/product', () => ({ createLicenseProduct: h.licenseCreate }));

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const PAY_TO = getAddress('0x4444444444444444444444444444444444444444');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const ID = 'h_' + 'ab'.repeat(16);
const NOW = 1_700_000_000_000;

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(value: string): { sha256: string; bytes: string } {
  return { sha256: sha(value), bytes: value };
}

async function mod() {
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
  vi.resetModules();
  return import('@/lib/x402/hostedStore');
}

const MAX_INPUT = {
  owner: OWNER,
  payTo: PAY_TO,
  title: '  Full product\r\n title ',
  desc: 'desc line',
  emoji: '🧠',
  imageUrl: ' https://cdn.example.com/p.png ',
  deliveryUrl: 'https://files.example.com/dl/p.zip',
  galleryUrls: ['https://cdn.example.com/g1.png', ' https://cdn.example.com/g2.png'],
  details: 'line1\r\nline2\n\n\n\nline3',
  specs: [{ label: 'Format', value: 'GLB 2.0' }, { label: '件数', value: '12' }],
  demoUrl: 'https://demo.example.com/',
  priceJpyc: '300',
  contentKind: 'text',
  label: 'api',
  category: 'ai',
  tags: ['prompt', 'AI'],
  handle: 'Alice_Shop',
  featured: true,
  usdcEnabled: true,
  content: '本文\r\n2 行目\u200b',
};

beforeEach(() => {
  h.calls.length = 0;
  h.scripts.length = 0;
  h.store.clear();
  h.lists.clear();
  h.evalResults.length = 0;
  h.failRead = false;
  h.licenseCreate.mockReset();
  h.licenseCreate.mockResolvedValue({ ok: true, product: 'license-created' });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xab);
    return array;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('R15a facade: public names', () => {
  it('exports the same runtime names', async () => {
    const m = await mod();
    expect(Object.keys(m).sort()).toEqual([
      'MAX_HOSTED_DESC_LEN',
      'MAX_HOSTED_DETAILS_LEN',
      'MAX_HOSTED_GALLERY_IMAGES',
      'MAX_HOSTED_PER_OWNER',
      'MAX_HOSTED_PRICE_JPYC',
      'MAX_HOSTED_SPECS',
      'MAX_HOSTED_SPEC_LABEL_LEN',
      'MAX_HOSTED_SPEC_VALUE_LEN',
      'MAX_HOSTED_TEXT_CODE_POINTS',
      'MAX_HOSTED_TITLE_LEN',
      'MAX_HOSTED_URL_LEN',
      'MAX_SELLER_CONTACT_LEN',
      'MAX_SELLER_DISCLOSURE_LEN',
      'MAX_SELLER_NAME_LEN',
      'MIN_HOSTED_PRICE_JPYC',
      'createHostedProduct',
      'getHostedContent',
      'getHostedProduct',
      'getHostedProductUpdateSnapshot',
      'getHostedProductsByIds',
      'getSellerDisclosure',
      'hostedContentKey',
      'hostedOwnerIndexKey',
      'hostedProductKey',
      'hostedPurchaseMetadata',
      'isHostedId',
      'isHostedLabel',
      'listAvailableHostedForOwner',
      'listHostedForOwner',
      'newHostedId',
      'parseHostedInput',
      'parseSellerDisclosureInput',
      'parseStoredHostedProduct',
      'purgeHostedContent',
      'putSellerDisclosure',
      'replaceHostedSellerProduct',
      'sanitizeHostedText',
      'selectProfileProducts',
      'sellerDisclosureComplete',
      'sellerDisclosureKey',
    ]);
    expect([
      m.hostedProductKey(ID),
      m.hostedOwnerIndexKey(OWNER),
      m.hostedContentKey(ID, 7),
      m.sellerDisclosureKey(OWNER),
      m.newHostedId(),
      String(m.MAX_HOSTED_PER_OWNER),
      String(m.MIN_HOSTED_PRICE_JPYC),
      String(m.MAX_HOSTED_PRICE_JPYC),
    ]).toEqual(EXPECTED.keys);
  });
});

describe('R15a create: Lua bytes, KEYS/ARGV order and stored JSON', () => {
  it('pins the maximal text product write', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput(MAX_INPUT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(bytes(JSON.stringify(parsed))).toEqual(EXPECTED.parsedMaximal);
    const created = await m.createHostedProduct(parsed, 1000);
    expect(bytes(JSON.stringify(created))).toEqual(EXPECTED.createdMaximal);
    expect(h.calls).toEqual(EXPECTED.createMaximalCalls);
    expect(bytes(h.scripts[0])).toEqual(EXPECTED.createScript);
  });

  it('pins the minimal url product write and the result mapping', async () => {
    const m = await mod();
    const parsed = m.parseHostedInput({
      owner: OWNER,
      title: 'Download',
      priceJpyc: '1',
      contentKind: 'url',
      content: ' https://files.example.com/a.zip ',
    });
    if (!parsed.ok) throw new Error('setup');
    h.evalResults.push({ ok: true, value: 1 }, { ok: true, value: -2 }, { ok: true, value: -3 }, { ok: false });
    const results = [];
    for (let index = 0; index < 4; index += 1) results.push(await m.createHostedProduct(parsed));
    expect(bytes(JSON.stringify(results))).toEqual(EXPECTED.createMinimalResults);
    expect(h.calls[0]).toEqual(EXPECTED.createMinimalCall);
  });

  it('delegates a license product to createLicenseProduct without a hosted EVAL', async () => {
    const m = await mod();
    const content = { kind: 'text' as const, value: '案内' };
    const licenseInput = { supply: 5, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1' };
    const result = await m.createHostedProduct({
      ok: true,
      product: {
        owner: OWNER,
        payTo: OWNER,
        title: 'License',
        priceJpyc: '1000',
        contentKind: 'text',
        label: 'prompt',
        contentRevision: 1,
        productKind: 'license',
        registration: { status: 'pending', attempts: 0 },
        saleActive: false,
        contentAvailable: true,
      },
      content,
      licenseInput,
    }, 2000);
    expect(result).toEqual({ ok: true, product: 'license-created' });
    expect(h.calls).toEqual([]);
    expect(bytes(JSON.stringify(h.licenseCreate.mock.calls))).toEqual(EXPECTED.licenseDelegation);
  });
});

describe('R15a stored record parsing', () => {
  it('pins the projection and property order of a maximal stored record', async () => {
    const m = await mod();
    const raw = JSON.stringify({
      futureField: { keep: 'ignored by parser' },
      updatedAt: 5000,
      createdAt: 4000,
      contentAvailable: true,
      saleActive: true,
      contentRevision: 3,
      featured: true,
      usdcEnabled: true,
      handle: 'Alice_Shop',
      tags: ['b', 'a'],
      category: 'ai',
      label: 'zip',
      contentKind: 'url',
      priceJpyc: '42',
      demoUrl: 'https://demo.example.com/',
      specs: [{ label: 'x', value: 'y' }, { label: 'bad:label', value: 'z' }],
      details: 'd\n\n\n\nd',
      galleryUrls: ['https://cdn.example.com/1.png', 'http://bad.example.com/2.png'],
      deliveryUrl: 'https://files.example.com/x.zip',
      imageUrl: 'https://cdn.example.com/i.png',
      emoji: '🎁',
      desc: 'desc',
      title: 'Stored',
      payTo: PAY_TO.toLowerCase(),
      owner: OWNER.toLowerCase(),
      id: ID,
    });
    expect(bytes(JSON.stringify(m.parseStoredHostedProduct(raw)))).toEqual(EXPECTED.storedMaximal);
    expect(bytes(JSON.stringify(m.hostedPurchaseMetadata(m.parseStoredHostedProduct(raw)!)))).toEqual(EXPECTED.purchaseMetadata);
  });

  it('pins a stored license record and its purchase metadata', async () => {
    const m = await mod();
    const { createLicenseDefinition } = await import('@/lib/license/definition');
    const license = createLicenseDefinition(ID, { supply: 10, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1' }, 80002, '0x3333333333333333333333333333333333333333');
    const raw = JSON.stringify({
      id: ID, productKind: 'license', license, registration: { status: 'registered', attempts: 1, txHash: `0x${'e'.repeat(64)}` },
      owner: OWNER, payTo: OWNER, title: 'License', priceJpyc: '1000', contentKind: 'text', label: 'prompt',
      contentRevision: 1, saleActive: true, contentAvailable: true, createdAt: 10,
    });
    const product = m.parseStoredHostedProduct(raw);
    expect(bytes(JSON.stringify(product))).toEqual(EXPECTED.storedLicense);
    expect(bytes(JSON.stringify(product && m.hostedPurchaseMetadata(product)))).toEqual(EXPECTED.licenseMetadata);
  });
});

describe('R15a read paths: KV keys and call order', () => {
  it('pins product, snapshot, content and list reads', async () => {
    const m = await mod();
    const stored = JSON.stringify({
      id: ID, owner: OWNER, payTo: OWNER, title: 'P', priceJpyc: '5', contentKind: 'text', label: 'prompt',
      contentRevision: 2, saleActive: true, contentAvailable: true, createdAt: 1,
    });
    const other = 'h_' + 'cd'.repeat(16);
    h.store.set(m.hostedProductKey(ID), stored);
    h.store.set(m.hostedContentKey(ID, 2), JSON.stringify({ kind: 'text', value: 'secret' }));
    h.lists.set(m.hostedOwnerIndexKey(OWNER), [ID, 'not-an-id', other]);
    const results = [
      await m.getHostedProduct(ID),
      await m.getHostedProductUpdateSnapshot(ID),
      await m.getHostedContent(ID, 2),
      await m.getHostedContent(ID, 0),
      await m.listHostedForOwner(OWNER),
      await m.listAvailableHostedForOwner(OWNER),
      await m.getHostedProductsByIds([other, ID, 'bad']),
      m.selectProfileProducts([{ featured: true }, {}, { featured: false }]),
    ];
    expect(bytes(JSON.stringify(results))).toEqual(EXPECTED.readResults);
    expect(h.calls).toEqual(EXPECTED.readCalls);
    h.calls.length = 0;
    h.failRead = true;
    expect([
      await m.getHostedProduct(ID),
      await m.getHostedProductUpdateSnapshot(ID),
      await m.getHostedContent(ID, 2),
      await m.getSellerDisclosure(OWNER),
      await m.sellerDisclosureComplete(OWNER),
    ]).toEqual(['storage', 'storage', 'storage', 'storage', 'storage']);
  });
});

describe('R15a seller replace: Lua bytes, KEYS/ARGV order and next revision', () => {
  const current = {
    id: ID, owner: OWNER, payTo: PAY_TO, title: 'Old', priceJpyc: '100', contentKind: 'text' as const,
    label: 'prompt' as const, contentRevision: 2, saleActive: true, contentAvailable: true, createdAt: 1000, updatedAt: 1500,
  };
  const metadata = {
    title: 'New', desc: 'D', emoji: '🧠', deliveryUrl: 'https://files.example.com/n.zip',
    imageUrl: 'https://cdn.example.com/n.png', galleryUrls: ['https://cdn.example.com/n1.png'], details: 'details',
    specs: [{ label: 'L', value: 'V' }], demoUrl: 'https://demo.example.com/n', priceJpyc: '200', label: 'api' as const,
    category: 'ai' as const, tags: ['t'], handle: 'alice_shop', featured: true, saleActive: false, usdcEnabled: true as const,
  };

  it('writes a new immutable revision with the content', async () => {
    const m = await mod();
    const snapshot = { product: current, token: JSON.stringify(current) };
    const result = await m.replaceHostedSellerProduct({
      snapshot, owner: OWNER.toLowerCase(), metadata, content: { kind: 'url', value: 'https://files.example.com/v3' }, now: 1200,
    });
    expect(bytes(JSON.stringify(result))).toEqual(EXPECTED.replaceWithContent);
    expect(h.calls).toEqual(EXPECTED.replaceWithContentCalls);
    expect(bytes(h.scripts[0])).toEqual(EXPECTED.replaceScript);
  });

  it('keeps the current revision without content and maps every Lua result', async () => {
    const m = await mod();
    const snapshot = { product: current, token: 'raw-token' };
    const minimal = { title: 'T', priceJpyc: '100', label: 'prompt' as const, saleActive: true };
    h.evalResults.push(
      { ok: true, value: 1 }, { ok: true, value: 0 }, { ok: true, value: -1 },
      { ok: true, value: -2 }, { ok: true, value: -4 }, { ok: false },
    );
    const results = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(await m.replaceHostedSellerProduct({ snapshot, owner: OWNER, metadata: minimal }));
    }
    results.push(await m.replaceHostedSellerProduct({ snapshot, owner: PAY_TO, metadata: minimal }));
    expect(bytes(JSON.stringify(results))).toEqual(EXPECTED.replaceWithoutContent);
    expect(h.calls[0]).toEqual(EXPECTED.replaceWithoutContentCall);
    expect(h.calls).toHaveLength(6);
  });
});

describe('R15a takedown (#594): Lua bytes, KEYS/ARGV order and next record', () => {
  it('pins a fresh purge, a repeated purge and the result mapping', async () => {
    const m = await mod();
    const record = {
      id: ID, owner: OWNER, payTo: OWNER, title: 'P', priceJpyc: '5', contentKind: 'text', label: 'prompt',
      contentRevision: 3, saleActive: true, contentAvailable: true, createdAt: 1, updatedAt: NOW + 50, futureMetadata: { keep: true },
    };
    h.store.set(m.hostedProductKey(ID), JSON.stringify(record));
    const fresh = await m.purgeHostedContent(ID);
    expect(bytes(JSON.stringify(fresh))).toEqual(EXPECTED.purgeFreshResult);
    expect(h.calls).toEqual(EXPECTED.purgeFreshCalls);
    expect(bytes(h.scripts[0])).toEqual(EXPECTED.purgeScript);

    h.calls.length = 0;
    h.store.set(m.hostedProductKey(ID), JSON.stringify({ ...record, saleActive: false, contentAvailable: false }));
    h.evalResults.push({ ok: true, value: 1 }, { ok: true, value: 0 }, { ok: true, value: -4 }, { ok: true, value: 2 }, { ok: false });
    const repeated = [];
    for (let index = 0; index < 5; index += 1) repeated.push(await m.purgeHostedContent(ID));
    expect(bytes(JSON.stringify(repeated))).toEqual(EXPECTED.purgeRepeatedResults);
    expect(h.calls.slice(0, 2)).toEqual(EXPECTED.purgeRepeatedCalls);

    h.calls.length = 0;
    h.store.set(m.hostedProductKey(ID), JSON.stringify({ ...record, id: 'h_' + 'cd'.repeat(16) }));
    expect([
      await m.purgeHostedContent(ID),
      await m.purgeHostedContent('bad'),
      await m.purgeHostedContent('h_' + 'ef'.repeat(16)),
    ]).toEqual([
      { ok: false, reason: 'corrupt' },
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'not_found' },
    ]);
    expect(h.calls.map((call) => call[0])).toEqual(['kvGet', 'kvGet']);
  });
});

describe('R15a seller disclosure: KV key and stored JSON', () => {
  it('pins parse, put and get', async () => {
    const m = await mod();
    const parsed = m.parseSellerDisclosureInput({
      name: ' 山田\r\n太郎 ', contact: 'a@example.com', disclosure: '住所\r\n電話\u200b\n',
    });
    expect(bytes(JSON.stringify(parsed))).toEqual(EXPECTED.disclosureParsed);
    if (!parsed.ok) return;
    expect(await m.putSellerDisclosure(OWNER, parsed.value, 777)).toBe(true);
    expect(await m.putSellerDisclosure('not-an-address', parsed.value, 777)).toBe(false);
    const got = await m.getSellerDisclosure(OWNER);
    const complete = await m.sellerDisclosureComplete(OWNER.toLowerCase());
    const missing = await m.sellerDisclosureComplete(PAY_TO);
    expect(bytes(JSON.stringify([got, complete, missing]))).toEqual(EXPECTED.disclosureRead);
    expect(h.calls).toEqual(EXPECTED.disclosureCalls);
  });
});

// 以下の期待値は分割前 (origin/main 7fe944c3) のコードで採取した。
const EXPECTED: Record<string, unknown> = {
  keys: [
    'x402:hosted:h_abababababababababababababababab',
    'x402:hosted:owner:0x1111111111111111111111111111111111111111',
    'x402:hosted:h_abababababababababababababababab:content:7',
    'x402:hosted:seller:0x1111111111111111111111111111111111111111',
    'h_abababababababababababababababab',
    '24',
    '1',
    '1000000',
  ],
  parsedMaximal: {
    sha256: '4bb3b98796fe75baaf545de8d83b97a4b463df90dd38bab13cc911d9c318dde0',
    bytes: '{"ok":true,"product":{"owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"Full product  title","desc":"desc line","emoji":"🧠","imageUrl":"https://cdn.example.com/p.png","deliveryUrl":"https://files.example.com/dl/p.zip","galleryUrls":["https://cdn.example.com/g1.png","https://cdn.example.com/g2.png"],"details":"line1\\nline2\\n\\nline3","specs":[{"label":"Format","value":"GLB 2.0"},{"label":"件数","value":"12"}],"demoUrl":"https://demo.example.com/","priceJpyc":"300","contentKind":"text","label":"api","category":"ai","tags":["prompt","AI"],"handle":"alice_shop","featured":true,"usdcEnabled":true,"contentRevision":1,"saleActive":true,"contentAvailable":true},"content":{"kind":"text","value":"本文\\n2 行目"}}',
  },
  createdMaximal: {
    sha256: 'f891caea2663f0fd542d8aaec554d5be5d107d3be4ff0983358b12d873b1d199',
    bytes: '{"ok":true,"product":{"id":"h_abababababababababababababababab","createdAt":1000,"owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"Full product  title","desc":"desc line","emoji":"🧠","imageUrl":"https://cdn.example.com/p.png","deliveryUrl":"https://files.example.com/dl/p.zip","galleryUrls":["https://cdn.example.com/g1.png","https://cdn.example.com/g2.png"],"details":"line1\\nline2\\n\\nline3","specs":[{"label":"Format","value":"GLB 2.0"},{"label":"件数","value":"12"}],"demoUrl":"https://demo.example.com/","priceJpyc":"300","contentKind":"text","label":"api","category":"ai","tags":["prompt","AI"],"handle":"alice_shop","featured":true,"usdcEnabled":true,"contentRevision":1,"saleActive":true,"contentAvailable":true}}',
  },
  createMaximalCalls: [
    [
      'kvEval',
      'd73f753c9b0ee9ac43dff633aecbf69bc83bd11b883983ffba912a0a0785a054',
      [
        'x402:hosted:h_abababababababababababababababab',
        'x402:hosted:h_abababababababababababababababab:content:1',
        'x402:hosted:owner:0x1111111111111111111111111111111111111111',
      ],
      [
        '{"id":"h_abababababababababababababababab","createdAt":1000,"owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"Full product  title","desc":"desc line","emoji":"🧠","imageUrl":"https://cdn.example.com/p.png","deliveryUrl":"https://files.example.com/dl/p.zip","galleryUrls":["https://cdn.example.com/g1.png","https://cdn.example.com/g2.png"],"details":"line1\\nline2\\n\\nline3","specs":[{"label":"Format","value":"GLB 2.0"},{"label":"件数","value":"12"}],"demoUrl":"https://demo.example.com/","priceJpyc":"300","contentKind":"text","label":"api","category":"ai","tags":["prompt","AI"],"handle":"alice_shop","featured":true,"usdcEnabled":true,"contentRevision":1,"saleActive":true,"contentAvailable":true}',
        '{"kind":"text","value":"本文\\n2 行目"}',
        'h_abababababababababababababababab',
        '24',
      ],
    ],
  ],
  createScript: {
    sha256: 'd73f753c9b0ee9ac43dff633aecbf69bc83bd11b883983ffba912a0a0785a054',
    bytes: 'local cap=tonumber(ARGV[4]); if redis.call(\'EXISTS\',KEYS[1])==1 then return -3 end; if redis.call(\'LLEN\',KEYS[3])>=cap then return -2 end; redis.call(\'SET\',KEYS[1],ARGV[1]); redis.call(\'SET\',KEYS[2],ARGV[2]); redis.call(\'LPUSH\',KEYS[3],ARGV[3]); return 1',
  },
  createMinimalResults: {
    sha256: '921c443411b3283ed3dac3c35a7a54951a5c198e2f54aa08225111fd01fa39ba',
    bytes: '[{"ok":true,"product":{"id":"h_abababababababababababababababab","createdAt":1700000000000,"owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"Download","priceJpyc":"1","contentKind":"url","label":"download","contentRevision":1,"saleActive":true,"contentAvailable":true}},{"ok":false,"reason":"too_many"},{"ok":false,"reason":"conflict"},{"ok":false,"reason":"storage"}]',
  },
  createMinimalCall: [
    'kvEval',
    'd73f753c9b0ee9ac43dff633aecbf69bc83bd11b883983ffba912a0a0785a054',
    [
      'x402:hosted:h_abababababababababababababababab',
      'x402:hosted:h_abababababababababababababababab:content:1',
      'x402:hosted:owner:0x1111111111111111111111111111111111111111',
    ],
    [
      '{"id":"h_abababababababababababababababab","createdAt":1700000000000,"owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"Download","priceJpyc":"1","contentKind":"url","label":"download","contentRevision":1,"saleActive":true,"contentAvailable":true}',
      '{"kind":"url","value":"https://files.example.com/a.zip"}',
      'h_abababababababababababababababab',
      '24',
    ],
  ],
  licenseDelegation: {
    sha256: '94172345171a3f20a5134de495607ac82d129a50ad6b4a4f61fa83451a7dc87b',
    bytes: '[[{"id":"h_abababababababababababababababab","createdAt":2000,"owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"License","priceJpyc":"1000","contentKind":"text","label":"prompt","contentRevision":1,"productKind":"license","registration":{"status":"pending","attempts":0},"saleActive":false,"contentAvailable":true},{"kind":"text","value":"案内"},{"supply":5,"transferable":false,"termsUrl":"https://seller.example/terms","termsVersion":"v1"},24]]',
  },
  storedMaximal: {
    sha256: '1911b9333def1c01ee1122afa00e31bff888578d1d98e7017836908a0466863b',
    bytes: '{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"Stored","desc":"desc","emoji":"🎁","imageUrl":"https://cdn.example.com/i.png","deliveryUrl":"https://files.example.com/x.zip","galleryUrls":["https://cdn.example.com/1.png"],"details":"d\\n\\nd","specs":[{"label":"x","value":"y"}],"demoUrl":"https://demo.example.com/","priceJpyc":"42","contentKind":"url","label":"zip","category":"ai","tags":["b","a"],"handle":"alice_shop","featured":true,"usdcEnabled":true,"contentRevision":3,"saleActive":true,"contentAvailable":true,"createdAt":4000,"updatedAt":5000}',
  },
  purchaseMetadata: {
    sha256: '145c7a0993c13ca40c38c0a4fc1de05c5efc97a5adadc58e5d60ab99598787fc',
    bytes: '{"owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"Stored","desc":"desc","emoji":"🎁","priceJpyc":"42","contentKind":"url","label":"zip"}',
  },
  storedLicense: {
    sha256: 'e276e3286f93c73a0a89e4e2631df736704432657b58c09c9a7882b837e56651',
    bytes: '{"id":"h_abababababababababababababababab","productKind":"license","license":{"schema":1,"rail":"jpyc","tokenChainId":80002,"contract":"0x3333333333333333333333333333333333333333","deploymentId":"openpay-license1155-v1:80002:0x3333333333333333333333333333333333333333","tokenId":"0xa89dd47af3340418614de52e5b291aecf27bdf01c9a603e1d946e1e38c0b679c","transferable":false,"termsUrl":"https://seller.example/terms","termsVersion":"v1","termsHash":"0x739f5d8c81b17c6c664565ba62ec1a694192707a7174e19ac39926dfd90178c8","contentRef":"x402:hosted:h_abababababababababababababababab:content:1","supply":10,"definitionHash":"0x0821a635a449be6faf44f264998ccff674c9cf0e50f65740ba8314aab3d88440"},"registration":{"status":"registered","attempts":1,"txHash":"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"License","priceJpyc":"1000","contentKind":"text","label":"prompt","contentRevision":1,"saleActive":true,"contentAvailable":true,"createdAt":10}',
  },
  licenseMetadata: {
    sha256: 'e4ff6c480148282befea5e5278c8b34f11de1e4a609c7e728c4669265d7deb26',
    bytes: '{"productKind":"license","license":{"schema":1,"rail":"jpyc","tokenChainId":80002,"contract":"0x3333333333333333333333333333333333333333","deploymentId":"openpay-license1155-v1:80002:0x3333333333333333333333333333333333333333","tokenId":"0xa89dd47af3340418614de52e5b291aecf27bdf01c9a603e1d946e1e38c0b679c","transferable":false,"termsUrl":"https://seller.example/terms","termsVersion":"v1","termsHash":"0x739f5d8c81b17c6c664565ba62ec1a694192707a7174e19ac39926dfd90178c8","contentRef":"x402:hosted:h_abababababababababababababababab:content:1","supply":10,"definitionHash":"0x0821a635a449be6faf44f264998ccff674c9cf0e50f65740ba8314aab3d88440"},"owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"License","priceJpyc":"1000","contentKind":"text","label":"prompt"}',
  },
  readResults: {
    sha256: 'bf303bcf582cd0312e952cb3dee6d60bc0851eca0cb52e8a33343c3c9f27f0b3',
    bytes: '[{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":2,"saleActive":true,"contentAvailable":true,"createdAt":1},{"product":{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":2,"saleActive":true,"contentAvailable":true,"createdAt":1},"token":"{\\"id\\":\\"h_abababababababababababababababab\\",\\"owner\\":\\"0x1111111111111111111111111111111111111111\\",\\"payTo\\":\\"0x1111111111111111111111111111111111111111\\",\\"title\\":\\"P\\",\\"priceJpyc\\":\\"5\\",\\"contentKind\\":\\"text\\",\\"label\\":\\"prompt\\",\\"contentRevision\\":2,\\"saleActive\\":true,\\"contentAvailable\\":true,\\"createdAt\\":1}"},{"kind":"text","value":"secret"},null,[{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":2,"saleActive":true,"contentAvailable":true,"createdAt":1}],[{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":2,"saleActive":true,"contentAvailable":true,"createdAt":1}],[{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":2,"saleActive":true,"contentAvailable":true,"createdAt":1}],{"shown":[{"featured":true}],"hiddenCount":2}]',
  },
  readCalls: [
    [
      'kvGet',
      'x402:hosted:h_abababababababababababababababab',
    ],
    [
      'kvGet',
      'x402:hosted:h_abababababababababababababababab',
    ],
    [
      'kvGet',
      'x402:hosted:h_abababababababababababababababab:content:2',
    ],
    [
      'kvLrange',
      'x402:hosted:owner:0x1111111111111111111111111111111111111111',
      0,
      23,
    ],
    [
      'kvGet',
      'x402:hosted:h_abababababababababababababababab',
    ],
    [
      'kvGet',
      'x402:hosted:h_cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    ],
    [
      'kvLrange',
      'x402:hosted:owner:0x1111111111111111111111111111111111111111',
      0,
      23,
    ],
    [
      'kvMget',
      [
        'x402:hosted:h_abababababababababababababababab',
        'x402:hosted:h_cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      ],
    ],
    [
      'kvMget',
      [
        'x402:hosted:h_cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
        'x402:hosted:h_abababababababababababababababab',
      ],
    ],
  ],
  replaceWithContent: {
    sha256: 'a800eeaa6c6d75a04dfe8cb70eada723e318b2b99816af73d85978a0248eca38',
    bytes: '{"ok":true,"product":{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"New","desc":"D","emoji":"🧠","deliveryUrl":"https://files.example.com/n.zip","imageUrl":"https://cdn.example.com/n.png","galleryUrls":["https://cdn.example.com/n1.png"],"details":"details","specs":[{"label":"L","value":"V"}],"demoUrl":"https://demo.example.com/n","priceJpyc":"200","contentKind":"url","label":"api","category":"ai","tags":["t"],"handle":"alice_shop","featured":true,"usdcEnabled":true,"contentRevision":3,"saleActive":false,"contentAvailable":true,"createdAt":1000,"updatedAt":1501}}',
  },
  replaceWithContentCalls: [
    [
      'kvEval',
      '9f07b4f2e9385c88d2fb5f4b67f8a1f494f3c9a43312890d1f29182c3a942bf2',
      [
        'x402:hosted:h_abababababababababababababababab',
        'x402:hosted:h_abababababababababababababababab:content:3',
      ],
      [
        '0x1111111111111111111111111111111111111111',
        '{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"Old","priceJpyc":"100","contentKind":"text","label":"prompt","contentRevision":2,"saleActive":true,"contentAvailable":true,"createdAt":1000,"updatedAt":1500}',
        '1',
        '{"kind":"url","value":"https://files.example.com/v3"}',
        '{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"New","desc":"D","emoji":"🧠","deliveryUrl":"https://files.example.com/n.zip","imageUrl":"https://cdn.example.com/n.png","galleryUrls":["https://cdn.example.com/n1.png"],"details":"details","specs":[{"label":"L","value":"V"}],"demoUrl":"https://demo.example.com/n","priceJpyc":"200","contentKind":"url","label":"api","category":"ai","tags":["t"],"handle":"alice_shop","featured":true,"usdcEnabled":true,"contentRevision":3,"saleActive":false,"contentAvailable":true,"createdAt":1000,"updatedAt":1501}',
      ],
    ],
  ],
  replaceScript: {
    sha256: '9f07b4f2e9385c88d2fb5f4b67f8a1f494f3c9a43312890d1f29182c3a942bf2',
    bytes: 'local cur=redis.call(\'GET\',KEYS[1]); if not cur then return 0 end; local ok,rec=pcall(cjson.decode,cur); if not ok then return -2 end; if type(rec.owner)~=\'string\' or string.lower(rec.owner)~=ARGV[1] then return -1 end; if cur~=ARGV[2] then return -4 end; if ARGV[3]==\'1\' then if redis.call(\'EXISTS\',KEYS[2])==1 then return -4 end; redis.call(\'SET\',KEYS[2],ARGV[4]); end; redis.call(\'SET\',KEYS[1],ARGV[5]); return 1',
  },
  replaceWithoutContent: {
    sha256: 'e976d5560c5ff66e98395d2e45b2eab63770347edf61b4981afa5b6725c72fff',
    bytes: '[{"ok":true,"product":{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"T","priceJpyc":"100","contentKind":"text","label":"prompt","contentRevision":2,"saleActive":true,"contentAvailable":true,"createdAt":1000,"updatedAt":1700000000000}},{"ok":false,"reason":"not_found"},{"ok":false,"reason":"forbidden"},{"ok":false,"reason":"corrupt"},{"ok":false,"reason":"conflict"},{"ok":false,"reason":"storage"},{"ok":false,"reason":"forbidden"}]',
  },
  replaceWithoutContentCall: [
    'kvEval',
    '9f07b4f2e9385c88d2fb5f4b67f8a1f494f3c9a43312890d1f29182c3a942bf2',
    [
      'x402:hosted:h_abababababababababababababababab',
      'x402:hosted:h_abababababababababababababababab:content:2',
    ],
    [
      '0x1111111111111111111111111111111111111111',
      'raw-token',
      '0',
      '',
      '{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x4444444444444444444444444444444444444444","title":"T","priceJpyc":"100","contentKind":"text","label":"prompt","contentRevision":2,"saleActive":true,"contentAvailable":true,"createdAt":1000,"updatedAt":1700000000000}',
    ],
  ],
  purgeFreshResult: {
    sha256: '215318f54b32de1e23695615d0a6d9f18cfdf066d2936a765fa514721e7acf10',
    bytes: '{"ok":true,"alreadyPurged":false,"contentRevision":3}',
  },
  purgeFreshCalls: [
    [
      'kvGet',
      'x402:hosted:h_abababababababababababababababab',
    ],
    [
      'kvEval',
      '78a10e747b26e5cbfc5a0533e78118637e2178264766f0104003cdda9d949254',
      [
        'x402:hosted:h_abababababababababababababababab',
      ],
      [
        '{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":3,"saleActive":true,"contentAvailable":true,"createdAt":1,"updatedAt":1700000000050,"futureMetadata":{"keep":true}}',
        '{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":3,"saleActive":false,"contentAvailable":false,"createdAt":1,"updatedAt":1700000000051,"futureMetadata":{"keep":true}}',
        '3',
      ],
    ],
  ],
  purgeScript: {
    sha256: '78a10e747b26e5cbfc5a0533e78118637e2178264766f0104003cdda9d949254',
    bytes: 'local cur=redis.call(\'GET\',KEYS[1]); if not cur then return 0 end; if cur~=ARGV[1] then return -4 end; for rev=1,tonumber(ARGV[3]) do redis.call(\'DEL\',KEYS[1]..\':content:\'..rev); end; redis.call(\'SET\',KEYS[1],ARGV[2]); return 1',
  },
  purgeRepeatedResults: {
    sha256: 'c9afea03108154365f9e553bb105505c64d4b9e2e01513c5570321fd2bfd1cbf',
    bytes: '[{"ok":true,"alreadyPurged":true,"contentRevision":3},{"ok":false,"reason":"not_found"},{"ok":false,"reason":"conflict"},{"ok":false,"reason":"storage"},{"ok":false,"reason":"storage"}]',
  },
  purgeRepeatedCalls: [
    [
      'kvGet',
      'x402:hosted:h_abababababababababababababababab',
    ],
    [
      'kvEval',
      '78a10e747b26e5cbfc5a0533e78118637e2178264766f0104003cdda9d949254',
      [
        'x402:hosted:h_abababababababababababababababab',
      ],
      [
        '{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":3,"saleActive":false,"contentAvailable":false,"createdAt":1,"updatedAt":1700000000050,"futureMetadata":{"keep":true}}',
        '{"id":"h_abababababababababababababababab","owner":"0x1111111111111111111111111111111111111111","payTo":"0x1111111111111111111111111111111111111111","title":"P","priceJpyc":"5","contentKind":"text","label":"prompt","contentRevision":3,"saleActive":false,"contentAvailable":false,"createdAt":1,"updatedAt":1700000000050,"futureMetadata":{"keep":true}}',
        '3',
      ],
    ],
  ],
  disclosureParsed: {
    sha256: '3e8050ed1328fcdb490277f9a0e3aa5836dede4be065fe6edcaebae013661ea4',
    bytes: '{"ok":true,"value":{"name":"山田 太郎","contact":"a@example.com","disclosure":"住所\\n電話"}}',
  },
  disclosureRead: {
    sha256: '5ff6400b453c74992bbf229d4c89a4e0977ed1a3edaea7955071dec693db4914',
    bytes: '[{"name":"山田 太郎","contact":"a@example.com","disclosure":"住所\\n電話","updatedAt":777},true,false]',
  },
  disclosureCalls: [
    [
      'kvSet',
      'x402:hosted:seller:0x1111111111111111111111111111111111111111',
      '{"name":"山田 太郎","contact":"a@example.com","disclosure":"住所\\n電話","updatedAt":777}',
    ],
    [
      'kvGet',
      'x402:hosted:seller:0x1111111111111111111111111111111111111111',
    ],
    [
      'kvGet',
      'x402:hosted:seller:0x1111111111111111111111111111111111111111',
    ],
    [
      'kvGet',
      'x402:hosted:seller:0x4444444444444444444444444444444444444444',
    ],
  ],
};
