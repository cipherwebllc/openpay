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
  extractHandleEmbed,
  isHandleEmbedUrl,
  methodToPublishableConfig,
  configToSearchParams,
  parseHandleRecord,
  serializeHandleRecord,
  handleStorefrontConfig,
  MAX_HANDLES_PER_WALLET,
  MAX_LINK_LABEL_LEN,
  MAX_LINK_IMAGE_URL_LEN,
  MAX_PROFILE_LINKS,
  MAX_PROFILE_EMBEDS,
  MAX_SOCIAL_LINKS,
  DEFAULT_RECEIVE_METHODS,
  type HandleRecord,
  type HandleTipConfig,
  type PublishableTipConfig,
} from '@/lib/handle';
import { parseTipParams } from '@/lib/url';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const YOUTUBE_ID = 'dQw4w9WgXcQ';
const SPOTIFY_ID = '0123456789ABCDEFGHIJKL';
const AUDIUS_ID = 'AbC123xYz';
const AUDIUS_URL = 'https://audius.co/openpay/test-track';

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
      theme: 'gradient',
      crossChain: false,
    };
    const parsed = parseTipParams(config.to, configToSearchParams(config));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.token).toBe('usdc');
      expect(parsed.params.chain).toBe('base');
      expect(parsed.params.name).toBe('Alice');
      expect(parsed.params.theme).toBe('gradient');
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
  it('theme を TipParams と同じ allowlist で保持し、不正値は落とす', () => {
    const valid = validateHandleTipConfig({
      to: ADDR,
      theme: 'night',
      methods: [{ token: 'jpyc', chain: 'polygon' }],
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.config.theme).toBe('night');

    const invalid = validateHandleTipConfig({
      to: ADDR,
      theme: 'neon',
      methods: [{ token: 'jpyc', chain: 'polygon' }],
    });
    expect(invalid.ok).toBe(true);
    if (invalid.ok) expect(invalid.config.theme).toBeUndefined();
  });
});

describe('extractHandleEmbed', () => {
  it.each([
    `https://www.youtube.com/watch?v=${YOUTUBE_ID}&list=PL123#chapter`,
    `https://youtu.be/${YOUTUBE_ID}/?si=share#chapter`,
    `https://youtube.com/shorts/${YOUTUBE_ID}?feature=share`,
  ])('extracts the three supported YouTube forms and builds a fixed nocookie src: %s', (url) => {
    expect(extractHandleEmbed(url)).toEqual({
      provider: 'youtube',
      id: YOUTUBE_ID,
      src: `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`,
    });
  });

  it.each([
    ['track', 152],
    ['album', 352],
    ['playlist', 352],
    ['episode', 152],
    ['show', 352],
    ['artist', 352],
  ] as const)('extracts Spotify %s and returns its fixed src/height', (type, height) => {
    expect(
      extractHandleEmbed(
        `https://open.spotify.com/${type}/${SPOTIFY_ID}/?si=share#details`,
      ),
    ).toEqual({
      provider: 'spotify',
      type,
      id: SPOTIFY_ID,
      src: `https://open.spotify.com/embed/${type}/${SPOTIFY_ID}`,
      height,
    });
  });

  it('builds an Audius compact track src only from the resolved record ID', () => {
    expect(
      extractHandleEmbed(`${AUDIUS_URL}?ref=profile#play`, {
        provider: 'audius',
        kind: 'track',
        id: AUDIUS_ID,
      }),
    ).toEqual({
      provider: 'audius',
      kind: 'track',
      id: AUDIUS_ID,
      src: `https://audius.co/embed/track/${AUDIUS_ID}?flavor=compact`,
      height: 120,
    });
  });

  it('recognizes an unresolved Audius URL as a builder candidate without extracting it', () => {
    expect(isHandleEmbedUrl(AUDIUS_URL)).toBe(true);
    expect(extractHandleEmbed(AUDIUS_URL)).toBeNull();
    for (const invalidUrl of [
      'http://audius.co/openpay/test-track',
      'https://user:pass@audius.co/openpay/test-track',
      'https://audius.co:443/openpay/test-track',
      'https://audius.co.evil.example/openpay/test-track',
    ]) {
      expect(isHandleEmbedUrl(invalidUrl)).toBe(false);
      expect(
        extractHandleEmbed(invalidUrl, {
          provider: 'audius',
          kind: 'track',
          id: AUDIUS_ID,
        }),
      ).toBeNull();
    }
  });

  it.each([
    undefined,
    { provider: 'audius', kind: 'track', id: 'Ab' },
    { provider: 'audius', kind: 'track', id: 'AbcdefghijklmnoPQ' },
    { provider: 'audius', kind: 'track', id: 'Abc-123' },
    { provider: 'audius', kind: 'album', id: AUDIUS_ID },
    { provider: 'spotify', kind: 'track', id: AUDIUS_ID },
  ])('rejects an Audius embed with invalid resolved data: %j', (resolved) => {
    expect(extractHandleEmbed(AUDIUS_URL, resolved)).toBeNull();
  });

  it.each([
    `http://www.youtube.com/watch?v=${YOUTUBE_ID}`,
    `https://user:pass@www.youtube.com/watch?v=${YOUTUBE_ID}`,
    `https://www.youtube.com:443/watch?v=${YOUTUBE_ID}`,
    `https://www.youtube.com:8443/watch?v=${YOUTUBE_ID}`,
    `https://music.youtube.com/watch?v=${YOUTUBE_ID}`,
    `https://www.youtube.com.evil.example/watch?v=${YOUTUBE_ID}`,
    `https://www.youtube.com/watch?v=short`,
    'https://www.youtube.com/watch?v=bad%21bad%21bad',
    `https://youtu.be/${YOUTUBE_ID}/extra`,
    `https://youtube.com/videos/${YOUTUBE_ID}`,
    `https://open.spotify.com/collection/${SPOTIFY_ID}`,
    'https://open.spotify.com/track/short',
    'https://open.spotify.com/track/0123456789ABCDEFGHIJK!',
    `https://spotify.com/track/${SPOTIFY_ID}`,
    `http://audius.co/openpay/test-track`,
    `https://user:pass@audius.co/openpay/test-track`,
    `https://audius.co:443/openpay/test-track`,
    `https://audius.co.evil.example/openpay/test-track`,
  ])('rejects unsupported or non-canonical embed URLs: %s', (url) => {
    expect(extractHandleEmbed(url)).toBeNull();
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
  it('accepts and canonicalizes a heading without url/featured', () => {
    const res = validateProfile({
      links: [{ kind: 'heading', label: '  Projects  ', emoji: ' 📌 ' }],
    });
    expect(res).toEqual({
      ok: true,
      profile: {
        links: [{ kind: 'heading', label: 'Projects', emoji: '📌' }],
      },
    });
  });
  it('uses the existing UTF-16 40-character label boundary for headings', () => {
    expect(
      validateProfile({
        links: [{ kind: 'heading', label: 'x'.repeat(MAX_LINK_LABEL_LEN) }],
      }).ok,
    ).toBe(true);
    expect(
      validateProfile({
        links: [{ kind: 'heading', label: 'x'.repeat(MAX_LINK_LABEL_LEN + 1) }],
      }).ok,
    ).toBe(false);
    // 補助平面文字は UTF-16 で 2 code units。code point 数へ誤変更するとこの境界を
    // すり抜けるため、20 個 (=40) / 20 個 + ASCII 1 文字 (=41) も固定する。
    expect(
      validateProfile({
        links: [{ kind: 'heading', label: '😀'.repeat(20) }],
      }).ok,
    ).toBe(true);
    expect(
      validateProfile({
        links: [{ kind: 'heading', label: `${'😀'.repeat(20)}x` }],
      }).ok,
    ).toBe(false);
  });
  it('rejects regular-link-only fields on headings and rejects unknown kind', () => {
    expect(
      validateProfile({
        links: [{ kind: 'heading', label: 'A', url: '' }],
      }).ok,
    ).toBe(false);
    expect(
      validateProfile({
        links: [{ kind: 'heading', label: 'A', featured: false }],
      }).ok,
    ).toBe(false);
    expect(
      validateProfile({
        links: [{ kind: 'heading', label: 'A', imageUrl: '' }],
      }).ok,
    ).toBe(false);
    expect(
      validateProfile({
        links: [{ kind: 'heading', label: 'A', embed: false }],
      }).ok,
    ).toBe(false);
    expect(
      validateProfile({
        links: [{ kind: 'divider', label: 'A' }],
      }).ok,
    ).toBe(false);
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
  it('shares MAX_PROFILE_LINKS across headings and regular links', () => {
    const atLimit = Array.from({ length: MAX_PROFILE_LINKS }, (_, i) =>
      i % 2 === 0
        ? { kind: 'heading', label: `Heading ${i}` }
        : { label: `Link ${i}`, url: `https://example.com/${i}` },
    );
    expect(validateProfile({ links: atLimit }).ok).toBe(true);
    expect(
      validateProfile({
        links: [...atLimit, { kind: 'heading', label: 'Overflow' }],
      }).ok,
    ).toBe(false);
  });
  it('rejects an over-long link url', () => {
    const longUrl = 'https://x.com/' + 'a'.repeat(520);
    expect(validateProfile({ links: [{ label: 'x', url: longUrl }] }).ok).toBe(false);
  });
  it('accepts a trimmed https link image at 512 chars and omits an empty image', () => {
    const prefix = 'https://images.example/';
    const imageUrl = prefix + 'a'.repeat(MAX_LINK_IMAGE_URL_LEN - prefix.length);
    const res = validateProfile({
      links: [
        {
          label: 'Image',
          url: 'https://example.com/image',
          imageUrl: ` ${imageUrl} `,
        },
        { label: 'Empty', url: 'https://example.com/empty', imageUrl: '   ' },
      ],
    });
    expect(res).toEqual({
      ok: true,
      profile: {
        links: [
          { label: 'Image', url: 'https://example.com/image', imageUrl },
          { label: 'Empty', url: 'https://example.com/empty' },
        ],
      },
    });
  });
  it('rejects invalid link image type/protocol and the 513th character', () => {
    const prefix = 'https://images.example/';
    const tooLong =
      prefix + 'a'.repeat(MAX_LINK_IMAGE_URL_LEN + 1 - prefix.length);
    const base = { label: 'Image', url: 'https://example.com' };
    expect(validateProfile({ links: [{ ...base, imageUrl: 42 }] })).toEqual({
      ok: false,
      error: 'image must be string',
    });
    expect(
      validateProfile({ links: [{ ...base, imageUrl: 'http://images.example/a' }] }),
    ).toEqual({ ok: false, error: 'image must be an https url' });
    expect(validateProfile({ links: [{ ...base, imageUrl: tooLong }] })).toEqual({
      ok: false,
      error: 'image url too long',
    });
  });
  it('accepts supported embed URLs and preserves only embed=true', () => {
    const res = validateProfile({
      links: [
        {
          label: 'Video',
          url: ` https://youtu.be/${YOUTUBE_ID}?si=share `,
          embed: true,
        },
        {
          label: 'Song',
          url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
          embed: true,
        },
        { label: 'Plain', url: 'https://example.com', embed: false },
      ],
    });
    expect(res).toEqual({
      ok: true,
      profile: {
        links: [
          {
            label: 'Video',
            url: `https://youtu.be/${YOUTUBE_ID}?si=share`,
            embed: true,
          },
          {
            label: 'Song',
            url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
            embed: true,
          },
          { label: 'Plain', url: 'https://example.com' },
        ],
      },
    });
  });
  it('accepts Audius only with a valid resolved track and canonicalizes the server field', () => {
    expect(
      validateProfile({
        links: [
          {
            label: 'Audius',
            url: AUDIUS_URL,
            embed: true,
            embedResolved: {
              provider: 'audius',
              kind: 'track',
              id: AUDIUS_ID,
              ignored: 'client-extra',
            },
          },
        ],
      }),
    ).toEqual({
      ok: true,
      profile: {
        links: [
          {
            label: 'Audius',
            url: AUDIUS_URL,
            embed: true,
            embedResolved: {
              provider: 'audius',
              kind: 'track',
              id: AUDIUS_ID,
            },
          },
        ],
      },
    });
  });
  it.each([
    ['missing', undefined],
    [
      'invalid ID',
      { provider: 'audius', kind: 'track', id: 'bad-id' },
    ],
    [
      'wrong kind',
      { provider: 'audius', kind: 'album', id: AUDIUS_ID },
    ],
  ])('rejects Audius embed with %s resolved data', (_case, embedResolved) => {
    expect(
      validateProfile({
        links: [
          {
            label: 'Audius',
            url: AUDIUS_URL,
            embed: true,
            embedResolved,
          },
        ],
      }),
    ).toEqual({ ok: false, error: 'embed not supported for this url' });
  });
  it('rejects embed=true on an unsupported URL with the exact error', () => {
    expect(
      validateProfile({
        links: [{ label: 'Site', url: 'https://example.com', embed: true }],
      }),
    ).toEqual({ ok: false, error: 'embed not supported for this url' });
  });
  it('accepts three embeds and rejects the fourth with the exact error', () => {
    const embeds = Array.from({ length: MAX_PROFILE_EMBEDS }, (_, index) => ({
      label: `Video ${index}`,
      url: `https://youtu.be/${YOUTUBE_ID}?n=${index}`,
      embed: true,
    }));
    expect(validateProfile({ links: embeds }).ok).toBe(true);
    expect(
      validateProfile({
        links: [
          ...embeds,
          {
            label: 'Song',
            url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
            embed: true,
          },
        ],
      }),
    ).toEqual({ ok: false, error: 'too many embeds' });
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
  it('accepts a known theme and drops unknown/invalid theme (no error, clean-treated)', () => {
    const ok = validateProfile({ bio: 'hi', theme: 'night' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.profile.theme).toBe('night');
    // 未知値はエラーにせず theme を落とす (= clean 扱い)。
    const unknown = validateProfile({ bio: 'hi', theme: 'neon' });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.profile.theme).toBeUndefined();
    // 非 string でもエラーにしない。
    const nonStr = validateProfile({ bio: 'hi', theme: 42 });
    expect(nonStr.ok).toBe(true);
    if (nonStr.ok) expect(nonStr.profile.theme).toBeUndefined();
  });

  it('carries link emoji (≤2 code points) and drops an over-long emoji but keeps label/url', () => {
    const res = validateProfile({
      links: [
        { label: 'X', url: 'https://x.com/a', emoji: ' 🌐 ' },
        { label: 'Multi', url: 'https://x.com/b', emoji: '👨‍👩‍👧' }, // ZWJ = 1 grapheme but >2 code points → drop
        { label: 'Two', url: 'https://x.com/c', emoji: '⚡🔥' }, // 2 code points → keep
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profile.links?.[0]).toEqual({
        label: 'X',
        url: 'https://x.com/a',
        emoji: '🌐',
      });
      // emoji が drop されても link 自体は残る (label/url を落とさない)。
      expect(res.profile.links?.[1]).toEqual({ label: 'Multi', url: 'https://x.com/b' });
      expect(res.profile.links?.[2].emoji).toBe('⚡🔥');
    }
  });

  it('enforces at most one featured link (first wins, rest dropped)', () => {
    const res = validateProfile({
      links: [
        { label: 'A', url: 'https://x.com/a', featured: true },
        { label: 'B', url: 'https://x.com/b', featured: true },
        { label: 'C', url: 'https://x.com/c' },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profile.links).toEqual([
        { label: 'A', url: 'https://x.com/a', featured: true },
        { label: 'B', url: 'https://x.com/b' },
        { label: 'C', url: 'https://x.com/c' },
      ]);
    }
  });

  it('rejects invalid socials (non-https / non-string / empty / too many / too long)', () => {
    expect(validateProfile({ socials: ['http://x.com/a'] }).ok).toBe(false);
    expect(validateProfile({ socials: ['javascript:alert(1)'] }).ok).toBe(false);
    expect(validateProfile({ socials: [123] }).ok).toBe(false);
    expect(validateProfile({ socials: ['   '] }).ok).toBe(false);
    expect(validateProfile({ socials: 'https://x.com/a' }).ok).toBe(false);
    const atCap = Array.from(
      { length: MAX_SOCIAL_LINKS },
      (_, i) => `https://x.com/u${i}`,
    );
    expect(validateProfile({ socials: atCap }).ok).toBe(true);
    const many = Array.from(
      { length: MAX_SOCIAL_LINKS + 1 },
      (_, i) => `https://x.com/u${i}`,
    );
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
      theme: 'soft',
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
    expect(pc.theme).toBe('soft');
  });

  it('tip URL 専用の presetLabels が混入しても handle 変換では黙って落とす', () => {
    const config = {
      to: ADDR,
      methods: [{ token: 'jpyc' as const, chain: 'polygon' as const }],
      presets: { jpyc: ['300'] },
      presetLabels: { jpyc: ['☕ コーヒー1杯'] },
    } satisfies HandleTipConfig & {
      presetLabels: { jpyc: string[] };
    };
    const pc = methodToPublishableConfig(config, config.methods[0]);
    expect(pc.presets).toEqual(['300']);
    expect(pc).not.toHaveProperty('presetLabels');
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
  it('round-trips a valid stored heading', () => {
    const withHeading: HandleRecord = {
      ...good,
      profile: {
        ...good.profile,
        links: [
          { kind: 'heading', label: 'Projects', emoji: '📌' },
          { label: 'X', url: 'https://x.com/a' },
        ],
      },
    };
    expect(parseHandleRecord(serializeHandleRecord(withHeading))).toEqual(
      withHeading,
    );
  });
  it('round-trips valid link image and embed fields', () => {
    const withMedia: HandleRecord = {
      ...good,
      profile: {
        links: [
          {
            label: 'Image',
            url: 'https://example.com',
            imageUrl: 'https://images.example/card.png',
          },
          {
            label: 'Video',
            url: `https://www.youtube.com/watch?v=${YOUTUBE_ID}`,
            embed: true,
          },
          {
            label: 'Song',
            url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
            embed: true,
          },
        ],
      },
    };
    expect(parseHandleRecord(serializeHandleRecord(withMedia))).toEqual(withMedia);
  });
  it('round-trips a stored Audius resolved track field', () => {
    const withAudius: HandleRecord = {
      ...good,
      profile: {
        links: [
          {
            label: 'Audius',
            url: AUDIUS_URL,
            embed: true,
            embedResolved: {
              provider: 'audius',
              kind: 'track',
              id: AUDIUS_ID,
            },
          },
        ],
      },
    };
    expect(parseHandleRecord(serializeHandleRecord(withAudius))).toEqual(
      withAudius,
    );
  });
  it('drops an invalid stored Audius embed without consuming the shared cap', () => {
    const links = [
      {
        label: 'Broken Audius',
        url: AUDIUS_URL,
        embed: true,
        embedResolved: {
          provider: 'audius',
          kind: 'track',
          id: 'bad-id',
        },
      },
      ...Array.from({ length: MAX_PROFILE_EMBEDS }, (_, index) => ({
        label: `Video ${index}`,
        url: `https://youtu.be/${YOUTUBE_ID}?n=${index}`,
        embed: true,
      })),
    ];
    const parsed = parseHandleRecord(
      JSON.stringify({ ...good, profile: { links } }),
    );
    expect(parsed?.profile?.links?.[0]).toEqual({
      label: 'Broken Audius',
      url: AUDIUS_URL,
    });
    expect(
      parsed?.profile?.links?.filter(
        (link) => link.kind !== 'heading' && link.embed === true,
      ),
    ).toHaveLength(MAX_PROFILE_EMBEDS);
  });
  it('truncates an overlong stored heading label to the existing read limit', () => {
    const stored = {
      ...good,
      profile: {
        links: [
          {
            kind: 'heading',
            label: 'x'.repeat(MAX_LINK_LABEL_LEN + 1),
          },
        ],
      },
    };
    expect(
      parseHandleRecord(JSON.stringify(stored))?.profile?.links,
    ).toEqual([
      { kind: 'heading', label: 'x'.repeat(MAX_LINK_LABEL_LEN) },
    ]);
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
  it('drops only invalid/unsupported/over-cap media fields and keeps every valid link', () => {
    const links = [
      {
        label: 'Unsupported',
        url: 'https://example.com',
        imageUrl: 'http://images.example/insecure.png',
        embed: true,
      },
      {
        label: 'Video 1',
        url: `https://youtu.be/${YOUTUBE_ID}?n=1`,
        imageUrl: 42,
        embed: true,
      },
      {
        label: 'Video 2',
        url: `https://youtu.be/${YOUTUBE_ID}?n=2`,
        embed: true,
      },
      {
        label: 'Song',
        url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
        embed: true,
      },
      {
        label: 'Album over cap',
        url: `https://open.spotify.com/album/${SPOTIFY_ID}`,
        imageUrl: ' https://images.example/album.png ',
        embed: true,
      },
    ];
    const parsed = parseHandleRecord(
      JSON.stringify({ ...good, profile: { links } }),
    );
    expect(parsed?.profile?.links).toEqual([
      { label: 'Unsupported', url: 'https://example.com' },
      {
        label: 'Video 1',
        url: `https://youtu.be/${YOUTUBE_ID}?n=1`,
        embed: true,
      },
      {
        label: 'Video 2',
        url: `https://youtu.be/${YOUTUBE_ID}?n=2`,
        embed: true,
      },
      {
        label: 'Song',
        url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
        embed: true,
      },
      {
        label: 'Album over cap',
        url: `https://open.spotify.com/album/${SPOTIFY_ID}`,
        imageUrl: 'https://images.example/album.png',
      },
    ]);
  });
  it('round-trips theme + link emoji/featured and enforces single featured on read', () => {
    const themed: HandleRecord = {
      ...good,
      profile: {
        bio: 'hi',
        theme: 'gradient',
        links: [
          { label: 'A', url: 'https://x.com/a', emoji: '⚡', featured: true },
          { label: 'B', url: 'https://x.com/b' },
        ],
      },
    };
    expect(parseHandleRecord(serializeHandleRecord(themed))).toEqual(themed);
    // 破損: 複数 featured / 未知 theme が来ても読込側で健全化 (先頭のみ featured・theme 落とす)。
    const messy = {
      ...good,
      profile: {
        theme: 'neon',
        links: [
          { label: 'A', url: 'https://x.com/a', featured: true },
          { label: 'B', url: 'https://x.com/b', featured: true },
        ],
      },
    };
    const parsed = parseHandleRecord(JSON.stringify(messy));
    expect(parsed?.profile?.theme).toBeUndefined();
    expect(parsed?.profile?.links).toEqual([
      { label: 'A', url: 'https://x.com/a', featured: true },
      { label: 'B', url: 'https://x.com/b' },
    ]);
  });

  it('drops only malformed/unknown stored heading rows without consuming featured', () => {
    const messy = {
      ...good,
      profile: {
        links: [
          { kind: 'heading', label: 'Kept' },
          { kind: 'divider', label: 'Unknown' },
          { kind: 'heading', label: 'Broken', featured: true },
          { label: 'Featured', url: 'https://x.com/a', featured: true },
          { label: 'Second', url: 'https://x.com/b', featured: true },
        ],
      },
    };
    const parsed = parseHandleRecord(JSON.stringify(messy));
    expect(parsed?.profile?.links).toEqual([
      { kind: 'heading', label: 'Kept' },
      { label: 'Featured', url: 'https://x.com/a', featured: true },
      { label: 'Second', url: 'https://x.com/b' },
    ]);
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

  it('プロフィールのテーマ色 (config.color) を accent に流す (店舗ページの配色)', () => {
    const colored: HandleRecord = { ...base, config: { ...base.config, color: '#9a3412' } };
    expect(handleStorefrontConfig(colored, 'shop')?.accent).toBe('#9a3412');
    // 色未設定なら accent は載らない (注文ページは既定色になる)
    expect('accent' in (handleStorefrontConfig(base, 'shop') ?? {})).toBe(false);
  });

  it('storefront の cover (カバー画像・https) を config.cover に流す', () => {
    const withCover: HandleRecord = {
      ...base,
      storefront: { ...base.storefront!, cover: 'https://img.example/cover.jpg' },
    };
    expect(handleStorefrontConfig(withCover, 'shop')?.cover).toBe('https://img.example/cover.jpg');
    expect('cover' in (handleStorefrontConfig(base, 'shop') ?? {})).toBe(false);
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

  it('storefront の chains (複数受取チェーン) を MobileOrderConfig へ載せる', () => {
    const multi: HandleRecord = {
      ...base,
      storefront: { ...base.storefront!, chain: 'kaia', chains: ['kaia', 'polygon'] },
    };
    expect(handleStorefrontConfig(multi, 'shop')?.chains).toEqual(['kaia', 'polygon']);
  });

  it('storefront の dineIn (店内・提供形態) を MobileOrderConfig へ載せる', () => {
    const dineIn: HandleRecord = {
      ...base,
      storefront: { ...base.storefront!, dineIn: true },
    };
    expect(handleStorefrontConfig(dineIn, 'shop')?.dineIn).toBe(true);
    // 未設定 (テイクアウト) は dineIn を持たない。
    expect('dineIn' in (handleStorefrontConfig(base, 'shop') ?? {})).toBe(false);
  });

  it('storefront の時間系 3 項目を伝播し、欠落時は config に載せない', () => {
    const withTime: HandleRecord = {
      ...base,
      storefront: {
        ...base.storefront!,
        openFrom: '09:30',
        lastOrder: '21:30',
        minLeadMinutes: 20,
      },
    };
    expect(handleStorefrontConfig(withTime, 'shop')).toMatchObject({
      openFrom: '09:30',
      lastOrder: '21:30',
      minLeadMinutes: 20,
    });

    const withoutTime = handleStorefrontConfig(base, 'shop') ?? {};
    expect('openFrom' in withoutTime).toBe(false);
    expect('lastOrder' in withoutTime).toBe(false);
    expect('minLeadMinutes' in withoutTime).toBe(false);
  });
});

describe('MAX_HANDLES_PER_WALLET', () => {
  it('is 3 (D2)', () => {
    expect(MAX_HANDLES_PER_WALLET).toBe(3);
  });
});
