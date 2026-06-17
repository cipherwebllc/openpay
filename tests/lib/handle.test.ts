import { describe, it, expect } from 'vitest';
import { getAddress } from 'viem';
import {
  normalizeHandle,
  decodeHandleSegment,
  isValidHandleFormat,
  isReserved,
  validateHandle,
  validateTipConfig,
  validateHandleTipConfig,
  validateProfile,
  methodToPublishableConfig,
  configToSearchParams,
  parseHandleRecord,
  serializeHandleRecord,
  handleStorefrontConfig,
  MAX_HANDLES_PER_WALLET,
  MAX_PROFILE_LINKS,
  DEFAULT_RECEIVE_METHODS,
  type HandleRecord,
  type HandleTipConfig,
  type PublishableTipConfig,
} from '@/lib/handle';
import { parseTipParams } from '@/lib/url';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

describe('normalizeHandle', () => {
  it('strips leading @, lowercases, trims', () => {
    expect(normalizeHandle('@Alice')).toBe('alice');
    expect(normalizeHandle('  @@Bob ')).toBe('bob');
    expect(normalizeHandle('CDX_01')).toBe('cdx_01');
  });
});

describe('decodeHandleSegment', () => {
  it('decodes percent-encoded @ that Next.js delivers in the dynamic param', () => {
    // 本番の 404 の真因: Next.js は `/ja/@masia` の dynamic param を `%40masia` で渡す。
    expect(decodeHandleSegment('%40masia')).toBe('@masia');
    expect(decodeHandleSegment('%40Alice')).toBe('@Alice');
  });
  it('is idempotent for already-decoded / plain segments', () => {
    expect(decodeHandleSegment('@masia')).toBe('@masia');
    expect(decodeHandleSegment('masia')).toBe('masia');
  });
  it('returns the raw segment on malformed percent sequences (no throw)', () => {
    expect(decodeHandleSegment('%')).toBe('%');
    expect(decodeHandleSegment('%zz')).toBe('%zz');
    expect(decodeHandleSegment('100%done')).toBe('100%done');
  });
  it('feeds normalizeHandle to the canonical handle after decode', () => {
    expect(normalizeHandle(decodeHandleSegment('%40masia'))).toBe('masia');
  });
});

describe('isValidHandleFormat', () => {
  it('accepts 3-30 lowercase alnum + underscore', () => {
    expect(isValidHandleFormat('abc')).toBe(true);
    expect(isValidHandleFormat('good_one_99')).toBe(true);
    expect(isValidHandleFormat('a'.repeat(30))).toBe(true);
  });
  it('rejects too short / too long / bad chars', () => {
    expect(isValidHandleFormat('ab')).toBe(false);
    expect(isValidHandleFormat('a'.repeat(31))).toBe(false);
    expect(isValidHandleFormat('has-dash')).toBe(false);
    expect(isValidHandleFormat('has space')).toBe(false);
    expect(isValidHandleFormat('UpperCase')).toBe(false);
    expect(isValidHandleFormat('emoji😀x')).toBe(false);
  });
});

describe('isReserved', () => {
  it('flags routes, locales, brand terms; allows normal names', () => {
    expect(isReserved('api')).toBe(true);
    expect(isReserved('pay')).toBe(true);
    expect(isReserved('tip')).toBe(true);
    expect(isReserved('ja')).toBe(true);
    expect(isReserved('openpay')).toBe(true);
    expect(isReserved('alice')).toBe(false);
  });
});

describe('validateHandle', () => {
  it('normalizes and accepts a good handle', () => {
    expect(validateHandle('@Alice')).toEqual({ ok: true, handle: 'alice' });
    expect(validateHandle('good_one')).toEqual({ ok: true, handle: 'good_one' });
  });
  it('rejects reserved with reason=reserved', () => {
    expect(validateHandle('pay')).toEqual({ ok: false, reason: 'reserved' });
    expect(validateHandle('@OpenPay')).toEqual({ ok: false, reason: 'reserved' });
  });
  it('rejects bad format with reason=format', () => {
    expect(validateHandle('ab')).toEqual({ ok: false, reason: 'format' });
    expect(validateHandle('has-dash')).toEqual({ ok: false, reason: 'format' });
  });
});

describe('validateTipConfig', () => {
  it('accepts a valid jpyc config and returns a checksummed, parsed config', () => {
    const res = validateTipConfig({ to: ADDR.toLowerCase(), token: 'jpyc' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.to).toBe(getAddress(ADDR));
      expect(res.config.token).toBe('jpyc');
    }
  });
  it('rejects non-object / missing fields', () => {
    expect(validateTipConfig(null).ok).toBe(false);
    expect(validateTipConfig('x').ok).toBe(false);
    expect(validateTipConfig({ token: 'jpyc' }).ok).toBe(false);
    expect(validateTipConfig({ to: ADDR }).ok).toBe(false);
  });
  it('rejects invalid address / token (delegates to parseTipParams)', () => {
    expect(validateTipConfig({ to: '0xnope', token: 'jpyc' }).ok).toBe(false);
    expect(validateTipConfig({ to: ADDR, token: 'eth' }).ok).toBe(false);
  });
});

describe('configToSearchParams', () => {
  it('round-trips back through parseTipParams', () => {
    const config: PublishableTipConfig = {
      to: ADDR,
      token: 'usdc',
      chain: 'base',
      name: 'Alice',
      crossChain: false,
    };
    const parsed = parseTipParams(config.to, configToSearchParams(config));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.token).toBe('usdc');
      expect(parsed.params.chain).toBe('base');
      expect(parsed.params.name).toBe('Alice');
      expect(parsed.params.crossChain).toBe(false);
    }
  });
});

describe('validateHandleTipConfig', () => {
  it('accepts the default methods (JPYC Polygon / Kaia)', () => {
    const res = validateHandleTipConfig({
      to: ADDR.toLowerCase(),
      name: 'Alice',
      methods: [...DEFAULT_RECEIVE_METHODS],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.to).toBe(getAddress(ADDR));
      const keys = res.config.methods.map((m) => `${m.token}:${m.chain}`);
      expect(keys).toEqual(['jpyc:polygon', 'jpyc:kaia']);
    }
  });
  it('still accepts a legacy USDC cross-chain method (back-compat)', () => {
    // ビルダーからは提供終了したが、既存レコードの usdc method は検証/公開とも通り続ける。
    const res = validateHandleTipConfig({
      to: ADDR,
      methods: [
        { token: 'jpyc', chain: 'polygon' },
        { token: 'usdc', chain: 'base', crossChain: true },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const usdc = res.config.methods.find((m) => m.token === 'usdc');
      expect(usdc?.crossChain).toBe(true);
    }
  });
  it('dedupes identical token+chain methods', () => {
    const res = validateHandleTipConfig({
      to: ADDR,
      methods: [
        { token: 'jpyc', chain: 'polygon' },
        { token: 'jpyc', chain: 'polygon' },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.methods).toHaveLength(1);
  });
  it('drops gasless-unsupported / invalid methods but keeps valid ones', () => {
    const res = validateHandleTipConfig({
      to: ADDR,
      methods: [
        { token: 'jpyc', chain: 'polygon' },
        { token: 'eth', chain: 'polygon' }, // 無効 token → 除外
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.methods).toHaveLength(1);
  });
  it('rejects when no method is valid / methods empty / to missing', () => {
    expect(validateHandleTipConfig({ to: ADDR, methods: [] }).ok).toBe(false);
    expect(validateHandleTipConfig({ methods: [{ token: 'jpyc', chain: 'polygon' }] }).ok).toBe(
      false,
    );
    expect(
      validateHandleTipConfig({ to: ADDR, methods: [{ token: 'eth', chain: 'polygon' }] }).ok,
    ).toBe(false);
    expect(validateHandleTipConfig(null).ok).toBe(false);
  });
  it('keeps per-token presets', () => {
    const res = validateHandleTipConfig({
      to: ADDR,
      methods: [
        { token: 'jpyc', chain: 'polygon' },
        { token: 'usdc', chain: 'base', crossChain: true },
      ],
      presets: { jpyc: ['300', '500'], usdc: ['5'] },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.presets?.jpyc).toEqual(['300', '500']);
      expect(res.config.presets?.usdc).toEqual(['5']);
    }
  });
});

describe('validateProfile', () => {
  it('accepts bio + https avatar + https links', () => {
    const res = validateProfile({
      bio: '  Web3 creator ',
      avatar: 'https://cdn.example.com/a.png',
      links: [{ label: ' X ', url: 'https://x.com/alice' }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profile.bio).toBe('Web3 creator');
      expect(res.profile.avatar).toBe('https://cdn.example.com/a.png');
      expect(res.profile.links).toEqual([{ label: 'X', url: 'https://x.com/alice' }]);
    }
  });
  it('treats empty / undefined as {} (no profile)', () => {
    expect(validateProfile(undefined)).toEqual({ ok: true, profile: {} });
    expect(validateProfile({ bio: '   ', avatar: '', links: [] })).toEqual({
      ok: true,
      profile: {},
    });
  });
  it('rejects non-https avatar and link urls (javascript:/data:/http:)', () => {
    expect(validateProfile({ avatar: 'http://x.com/a.png' }).ok).toBe(false);
    expect(validateProfile({ links: [{ label: 'x', url: 'javascript:alert(1)' }] }).ok).toBe(
      false,
    );
    expect(validateProfile({ links: [{ label: 'x', url: 'http://x.com' }] }).ok).toBe(false);
    expect(
      validateProfile({ links: [{ label: 'x', url: 'data:text/html,hi' }] }).ok,
    ).toBe(false);
  });
  it('rejects too-long bio / too-many links / empty label', () => {
    expect(validateProfile({ bio: 'x'.repeat(161) }).ok).toBe(false);
    const many = Array.from({ length: MAX_PROFILE_LINKS + 1 }, (_, i) => ({
      label: `l${i}`,
      url: 'https://x.com',
    }));
    expect(validateProfile({ links: many }).ok).toBe(false);
    expect(validateProfile({ links: [{ label: '  ', url: 'https://x.com' }] }).ok).toBe(false);
  });
  it('rejects an over-long link url', () => {
    const longUrl = 'https://x.com/' + 'a'.repeat(520);
    expect(validateProfile({ links: [{ label: 'x', url: longUrl }] }).ok).toBe(false);
  });
  it('accepts https socials (trimmed) and treats empty array as no socials', () => {
    const res = validateProfile({
      socials: [' https://x.com/alice ', 'https://github.com/alice'],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profile.socials).toEqual([
        'https://x.com/alice',
        'https://github.com/alice',
      ]);
    }
    expect(validateProfile({ socials: [] })).toEqual({ ok: true, profile: {} });
  });
  it('rejects invalid socials (non-https / non-string / empty / too many / too long)', () => {
    expect(validateProfile({ socials: ['http://x.com/a'] }).ok).toBe(false);
    expect(validateProfile({ socials: ['javascript:alert(1)'] }).ok).toBe(false);
    expect(validateProfile({ socials: [123] }).ok).toBe(false);
    expect(validateProfile({ socials: ['   '] }).ok).toBe(false);
    expect(validateProfile({ socials: 'https://x.com/a' }).ok).toBe(false);
    const many = Array.from({ length: 7 }, (_, i) => `https://x.com/u${i}`);
    expect(validateProfile({ socials: many }).ok).toBe(false);
    const longUrl = 'https://x.com/' + 'a'.repeat(520);
    expect(validateProfile({ socials: [longUrl] }).ok).toBe(false);
  });
});

describe('methodToPublishableConfig', () => {
  it('maps a method + shared identity to a PublishableTipConfig', () => {
    const config: HandleTipConfig = {
      to: ADDR,
      name: 'Alice',
      color: '#2563eb',
      methods: [{ token: 'usdc', chain: 'base', crossChain: true }],
      presets: { jpyc: ['300'], usdc: ['5'] },
    };
    const pc = methodToPublishableConfig(config, config.methods[0]);
    expect(pc.to).toBe(ADDR);
    expect(pc.token).toBe('usdc');
    expect(pc.chain).toBe('base');
    expect(pc.crossChain).toBe(true);
    expect(pc.presets).toEqual(['5']); // usdc 用 preset を選ぶ
    expect(pc.name).toBe('Alice');
  });
});

describe('parseHandleRecord', () => {
  const good: HandleRecord = {
    owner: ADDR,
    config: {
      to: ADDR,
      name: 'Alice',
      methods: [
        { token: 'jpyc', chain: 'polygon' },
        { token: 'jpyc', chain: 'kaia' },
        { token: 'usdc', chain: 'base', crossChain: true },
      ],
      presets: { jpyc: ['300'] },
    },
    profile: {
      bio: 'hi',
      socials: ['https://x.com/a', 'https://line.me/abc'],
      links: [{ label: 'X', url: 'https://x.com/a' }],
    },
    createdAt: 1,
    updatedAt: 2,
  };

  it('parses a well-formed multi-method record (round-trip)', () => {
    expect(parseHandleRecord(serializeHandleRecord(good))).toEqual(good);
  });
  it('migrates a legacy single-config record to methods[1]', () => {
    const legacy = {
      owner: ADDR,
      config: { to: ADDR, token: 'jpyc', chain: 'kaia', name: 'Bob', presets: ['100'] },
      createdAt: 1,
      updatedAt: 2,
    };
    const parsed = parseHandleRecord(JSON.stringify(legacy));
    expect(parsed).not.toBeNull();
    expect(parsed?.config.methods).toEqual([{ token: 'jpyc', chain: 'kaia' }]);
    expect(parsed?.config.presets).toEqual({ jpyc: ['100'] });
    expect(parsed?.config.name).toBe('Bob');
  });
  it('migrates a legacy config with no chain to the token default', () => {
    const legacy = {
      owner: ADDR,
      config: { to: ADDR, token: 'jpyc' },
      createdAt: 1,
      updatedAt: 2,
    };
    const parsed = parseHandleRecord(JSON.stringify(legacy));
    expect(parsed?.config.methods).toEqual([{ token: 'jpyc', chain: 'polygon' }]);
  });
  it('drops malformed profile parts but keeps the tip config', () => {
    const rec = {
      ...good,
      profile: {
        bio: 'ok',
        avatar: 'http://insecure/a.png', // 非https → drop
        socials: ['https://x.com/good', 'http://insecure', 42, 'javascript:1'],
        links: [
          { label: 'good', url: 'https://x.com' },
          { label: 'bad', url: 'javascript:1' }, // drop
        ],
      },
    };
    const parsed = parseHandleRecord(JSON.stringify(rec));
    expect(parsed?.profile?.bio).toBe('ok');
    expect(parsed?.profile?.avatar).toBeUndefined();
    expect(parsed?.profile?.socials).toEqual(['https://x.com/good']);
    expect(parsed?.profile?.links).toEqual([{ label: 'good', url: 'https://x.com' }]);
  });
  it('parses + round-trips a storefront (menu/chain/mode)', () => {
    const withStore: HandleRecord = {
      ...good,
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
      },
    };
    expect(parseHandleRecord(serializeHandleRecord(withStore))).toEqual(withStore);
  });
  it('drops a malformed storefront but keeps the tip config + profile', () => {
    const rec = {
      ...good,
      // base は JPYC チェーンでない → storefront は丸ごと drop (tip/profile は残す)。
      storefront: { chain: 'base', mode: 'storefront', feePayer: 'merchant', menu: [{ id: 'a', name: 'x', price: '1' }] },
    };
    const parsed = parseHandleRecord(JSON.stringify(rec));
    expect(parsed).not.toBeNull();
    expect(parsed?.storefront).toBeUndefined();
    expect(parsed?.config.name).toBe('Alice');
    expect(parsed?.profile?.bio).toBe('hi');
  });
  it('returns null for null / malformed JSON', () => {
    expect(parseHandleRecord(null)).toBeNull();
    expect(parseHandleRecord('not json')).toBeNull();
    expect(parseHandleRecord('123')).toBeNull();
  });
  it('returns null when required fields are missing or config invalid', () => {
    expect(parseHandleRecord(JSON.stringify({ owner: ADDR }))).toBeNull();
    expect(parseHandleRecord(JSON.stringify({ ...good, owner: 123 }))).toBeNull();
    // config に to も token も methods も無い
    expect(
      parseHandleRecord(JSON.stringify({ ...good, config: { name: 'x' } })),
    ).toBeNull();
    // methods 要素が壊れている
    expect(
      parseHandleRecord(
        JSON.stringify({ ...good, config: { to: ADDR, methods: [{ token: 'jpyc' }] } }),
      ),
    ).toBeNull();
  });
});

describe('handleStorefrontConfig', () => {
  const base: HandleRecord = {
    owner: ADDR,
    config: { to: ADDR, name: 'テスト珈琲店', methods: [{ token: 'jpyc', chain: 'polygon' }] },
    profile: { avatar: 'https://img.example/icon.png', socials: ['https://x.com/shop'] },
    storefront: {
      chain: 'kaia',
      mode: 'storefront',
      feePayer: 'merchant',
      menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
    },
    createdAt: 1,
    updatedAt: 2,
  };

  it('storefront 無しは null', () => {
    const noStore: HandleRecord = { owner: ADDR, config: base.config, createdAt: 1, updatedAt: 2 };
    expect(handleStorefrontConfig(noStore, 'shop')).toBeNull();
  });

  it('identity を handle 由来で合成して MobileOrderConfig を返す (受取先/店名/アイコン/SNS)', () => {
    const config = handleStorefrontConfig(base, 'shop');
    expect(config).not.toBeNull();
    expect(config?.receiver.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(config?.shopName).toBe('テスト珈琲店');
    expect(config?.avatar).toBe('https://img.example/icon.png');
    expect(config?.socials).toEqual(['https://x.com/shop']);
    expect(config?.chain).toBe('kaia'); // storefront 側のチェーン (tip method と独立)
    expect(config?.menu).toEqual([{ id: 'a', name: 'ブレンド', price: '500' }]);
  });

  it('config.name が無ければ @handle を店名にフォールバック', () => {
    const noName: HandleRecord = { ...base, config: { ...base.config, name: undefined } };
    expect(handleStorefrontConfig(noName, 'shop')?.shopName).toBe('@shop');
  });

  it('受取先が不正なら null (validateOrderConfig 委譲)', () => {
    const badTo: HandleRecord = { ...base, config: { ...base.config, to: 'not-an-address' } };
    expect(handleStorefrontConfig(badTo, 'shop')).toBeNull();
  });

  it('storefront のブランディング (店名/アイコン/SNS) を @handle より優先 (ビルダー由来)', () => {
    const withBrand: HandleRecord = {
      ...base,
      storefront: {
        ...base.storefront!,
        shopName: 'ビルダー店名',
        avatar: 'https://img.example/builder.png',
        socials: ['https://x.com/builder'],
      },
    };
    const config = handleStorefrontConfig(withBrand, 'shop');
    expect(config?.shopName).toBe('ビルダー店名'); // config.name ('テスト珈琲店') ではなく storefront 優先
    expect(config?.avatar).toBe('https://img.example/builder.png'); // profile.avatar ではなく
    expect(config?.socials).toEqual(['https://x.com/builder']); // profile.socials ではなく
  });

  it('storefront の店舗情報 (住所/営業時間/電話/受付停止) を MobileOrderConfig へ載せる', () => {
    const withInfo: HandleRecord = {
      ...base,
      storefront: {
        ...base.storefront!,
        address: '東京都〇〇 1-2-3',
        hours: '11:00-22:00',
        phone: '03-1234-5678',
        acceptingOrders: false,
      },
    };
    const config = handleStorefrontConfig(withInfo, 'shop');
    expect(config?.address).toBe('東京都〇〇 1-2-3');
    expect(config?.hours).toBe('11:00-22:00');
    expect(config?.phone).toBe('03-1234-5678');
    expect(config?.acceptingOrders).toBe(false);
  });
});

describe('MAX_HANDLES_PER_WALLET', () => {
  it('is 3 (D2)', () => {
    expect(MAX_HANDLES_PER_WALLET).toBe(3);
  });
});
