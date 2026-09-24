import { describe, expect, it } from 'vitest';
import {
  CLEARABLE_HANDLE_TIP_FIELDS, parseHandleRecord, serializeHandleRecord, validateProfile,
  validateHandleTipConfig, type HandleTipConfig,
} from '@/lib/handle';

// R13 の分割前 (monolith) に対して採取したバイト列。保存済み record の tolerant な読み出しの
// JSON キー順・バイト列を、意図的に寛容な挙動も含めて固定する (厳格な書き込み検証の期待値ではない)。
const config: HandleTipConfig = { to: 'receiver', methods: [{ token: 'jpyc', chain: 'polygon' }] };
const configJson = '{"to":"receiver","methods":[{"token":"jpyc","chain":"polygon"}]}';
const rawRecord = (patch: Record<string, unknown> = {}) => JSON.stringify({
  owner: 'owner', config, createdAt: 1, updatedAt: 2, ...patch,
});
const recordJson = (configBytes = configJson, tail = '') =>
  `{"owner":"owner","config":${configBytes},"createdAt":1,"updatedAt":2${tail}}`;
const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const corpus = [
  {
    name: 'legacy JPYC defaults and string-only presets',
    raw: rawRecord({ config: { to: 'receiver', token: 'jpyc', presets: ['300', 400, null, ' 500 '], future: true } }),
    expected: recordJson('{"to":"receiver","methods":[{"token":"jpyc","chain":"polygon"}],"presets":{"jpyc":["300"," 500 "]}}'),
  },
  {
    name: 'legacy USDC default and false cross-chain flag',
    raw: rawRecord({ config: { to: 'receiver', token: 'usdc', crossChain: false, presets: ['1.00'] } }),
    expected: recordJson('{"to":"receiver","methods":[{"token":"usdc","chain":"base","crossChain":false}],"presets":{"usdc":["1.00"]}}'),
  },
  {
    name: 'legacy unknown token has no inferred chain and retains array presets',
    raw: rawRecord({ config: { to: 'receiver', token: 'future', presets: ['-1', 'invalid'] } }),
    expected: recordJson('{"to":"receiver","methods":[{"token":"future"}],"presets":{"future":["-1","invalid"]}}'),
  },
  {
    name: 'legacy explicit chain, untrimmed shared strings and unknown-field removal',
    raw: rawRecord({
      config: {
        to: 'receiver', token: 'usdc', chain: 'arc', crossChain: true,
        name: ' Alice ', message: '', color: 'invalid', theme: 'night', thanks: ' Thanks ',
        thanksUrl: 'http://legacy.test', webhook: 'not a url', ignored: 'discard',
      },
      profile: {}, future: { version: 99 },
    }),
    expected: recordJson('{"to":"receiver","name":" Alice ","message":"","color":"invalid","theme":"night","thanks":" Thanks ","thanksUrl":"http://legacy.test","webhook":"not a url","methods":[{"token":"usdc","chain":"arc","crossChain":true}]}'),
  },
  {
    name: 'methods take precedence, preserve duplicates/unknowns, and presets follow token order',
    raw: rawRecord({ config: {
      to: 'receiver', token: 'usdc', chain: 'base', theme: 'future',
      methods: [
        { token: 'future', chain: 'unknown', crossChain: true, extra: 1 },
        { token: 'jpyc', chain: 'polygon', crossChain: false },
        { token: 'jpyc', chain: 'polygon' },
      ],
      presets: { usdc: ['2', false], future: ['3'], jpyc: ['0', 4, ''] },
    } }),
    expected: recordJson('{"to":"receiver","methods":[{"token":"future","chain":"unknown","crossChain":true},{"token":"jpyc","chain":"polygon","crossChain":false},{"token":"jpyc","chain":"polygon"}],"presets":{"jpyc":["0",""],"usdc":["2"]}}'),
  },
  {
    name: 'non-array methods still use the legacy branch',
    raw: rawRecord({ config: { to: 'receiver', token: 'jpyc', methods: null, presets: { jpyc: [false], usdc: [] } } }),
    expected: recordJson(),
  },
  {
    name: 'array presets use the first method without semantic validation',
    raw: rawRecord({ config: { to: 'receiver', methods: [{ token: 'usdc', chain: 'unsupported' }], presets: ['bad', 1] } }),
    expected: recordJson('{"to":"receiver","methods":[{"token":"usdc","chain":"unsupported"}],"presets":{"usdc":["bad"]}}'),
  },
  {
    name: 'partially corrupt profile recovers valid fields and discards a broken storefront',
    raw: rawRecord({
      profile: {
        bio: ` ${'b'.repeat(161)} `, avatar: 'http://bad.test/a', cover: ' https://ok.test/c ',
        font: 'serif', linkLayout: 'future', socials: [null, 'http://bad.test', ' https://ok.test/s ', ''],
        links: [
          null, [], { kind: 'future', label: 'bad', url: 'https://ok.test' },
          { kind: 'heading', label: 'broken', featured: false },
          { kind: 'heading', label: ` ${'h'.repeat(41)} `, emoji: ' 🎵 ', extra: true },
          { label: ` ${'l'.repeat(41)} `, url: ' https://ok.test/1 ', emoji: 'abc', featured: true, imageUrl: 'http://bad.test', embed: true },
          { label: ' Second ', url: 'https://ok.test/2', emoji: ' 🐈✨ ', featured: true, imageUrl: ' https://ok.test/i ' },
        ],
        theme: 'night', extra: true,
      },
      storefront: { chain: 'polygon', menu: [] },
    }),
    expected: recordJson(configJson, `,"profile":{"bio":"${'b'.repeat(160)}","cover":"https://ok.test/c","font":"serif","socials":["https://ok.test/s"],"links":[{"kind":"heading","label":"${'h'.repeat(40)}","emoji":"🎵"},{"label":"${'l'.repeat(40)}","url":"https://ok.test/1","featured":true},{"label":"Second","url":"https://ok.test/2","emoji":"🐈✨","imageUrl":"https://ok.test/i"}],"theme":"night"}`),
  },
  {
    name: 'invalid Audius does not consume the embed cap; excess embeds remain normal links',
    raw: rawRecord({ profile: { links: [
      { label: 'Broken', url: 'https://audius.co/a/b', embed: true, embedResolved: { provider: 'audius', kind: 'track', id: '!' } },
      { label: 'Audius', url: 'https://audius.co/a/b', embed: true, embedResolved: { provider: 'audius', kind: 'track', id: 'AbC123', extra: true } },
      { label: 'YouTube', url: 'https://youtu.be/dQw4w9WgXcQ?t=10', embed: true, embedResolved: { untrusted: true } },
      { label: 'Vimeo', url: 'https://vimeo.com/123456', embed: true },
      { label: 'Overflow', url: 'https://youtu.be/dQw4w9WgXcQ', embed: true },
    ] } }),
    expected: recordJson(configJson, ',"profile":{"links":[{"label":"Broken","url":"https://audius.co/a/b"},{"label":"Audius","url":"https://audius.co/a/b","embed":true,"embedResolved":{"provider":"audius","kind":"track","id":"AbC123"}},{"label":"YouTube","url":"https://youtu.be/dQw4w9WgXcQ?t=10","embed":true},{"label":"Vimeo","url":"https://vimeo.com/123456","embed":true},{"label":"Overflow","url":"https://youtu.be/dQw4w9WgXcQ"}]}'),
  },
  {
    name: 'profile caps count valid entries; stored methods have no write cap',
    raw: rawRecord({
      config: { to: 'receiver', methods: Array.from({ length: 7 }, () => ({ token: 'jpyc', chain: 'polygon' })) },
      profile: {
        socials: [false, ...Array.from({ length: 11 }, (_, i) => `https://s.test/${i}`)],
        links: [null, ...Array.from({ length: 21 }, (_, i) => ({ label: `L${i}`, url: `https://l.test/${i}` }))],
      },
    }),
    expected: recordJson(`{"to":"receiver","methods":[${Array(7).fill('{"token":"jpyc","chain":"polygon"}').join(',')}]}`,
      `,"profile":{"socials":[${Array.from({ length: 10 }, (_, i) => `"https://s.test/${i}"`).join(',')}],"links":[${Array.from({ length: 20 }, (_, i) => `{"label":"L${i}","url":"https://l.test/${i}"}`).join(',')}]}`),
  },
  {
    name: 'valid storefront follows profile in serialized order',
    raw: rawRecord({
      profile: { bio: ' hi ' },
      storefront: { chain: 'polygon', mode: 'storefront', feePayer: 'merchant', menu: [{ id: 'coffee', name: 'Coffee', price: '300' }], extra: true },
    }),
    expected: recordJson(configJson, ',"profile":{"bio":"hi"},"storefront":{"chain":"polygon","mode":"storefront","feePayer":"merchant","menu":[{"id":"coffee","name":"Coffee","price":"300"}]}'),
  },
  {
    name: 'valid avatar and grid link layout are retained (trimmed)',
    raw: rawRecord({ profile: { avatar: ' https://ok.test/a.png ', linkLayout: 'grid' } }),
    expected: recordJson(configJson, ',"profile":{"avatar":"https://ok.test/a.png","linkLayout":"grid"}'),
  },
];

describe('stored handle record byte corpus', () => {
  it.each(corpus)('$name', ({ raw, expected }) => {
    const record = parseHandleRecord(raw);
    expect(record).not.toBeNull();
    expect(serializeHandleRecord(record!)).toBe(expected);
  });

  it.each([null, '', '{', 'null', 'false', '42', '"record"', '[]', '{}'])('rejects malformed envelope %j', (raw) => {
    expect(parseHandleRecord(raw)).toBeNull();
  });

  it.each([
    { owner: null }, { createdAt: '1' }, { updatedAt: null }, { config: null },
    { config: [] }, { config: { token: 'jpyc' } },
    { config: { ...config, methods: [] } },
    { config: { ...config, methods: [{ token: 'jpyc' }] } },
    { config: { ...config, methods: [null] } },
    { config: { ...config, methods: [{ token: 'jpyc', chain: 'polygon', crossChain: null }] } },
    { config: { to: 'receiver', token: 'jpyc', chain: 1 } },
    { config: { to: 'receiver', token: 'usdc', crossChain: 'true' } },
  ])('rejects structurally corrupt required data %j', (patch) => {
    expect(parseHandleRecord(rawRecord(patch))).toBeNull();
  });

  it.each(['name', 'message', 'color', 'thanks', 'thanksUrl', 'webhook'])('does not accept persisted null or non-string %s', (field) => {
    for (const value of [null, 1, false, [], {}]) {
      expect(parseHandleRecord(rawRecord({ config: { ...config, [field]: value } }))).toBeNull();
    }
    // C10: null は更新命令であり、保存済み config の値にはならない。
    expect(serializeHandleRecord(parseHandleRecord(rawRecord({ config: { ...config, [field]: undefined } }))!)).toBe(recordJson());
  });

  it('turns write-side C10 null clears into omitted keys before a config is saved', () => {
    const result = validateHandleTipConfig({
      to: ADDR, name: 'Alice', methods: [{ token: 'jpyc', chain: 'polygon' }],
      message: null, thanks: null, thanksUrl: null, webhook: null,
    });
    if (!result.ok) throw new Error(result.error);
    for (const field of CLEARABLE_HANDLE_TIP_FIELDS) expect(result.config[field]).toBeUndefined();
    expect(serializeHandleRecord({ owner: 'owner', config: result.config, createdAt: 1, updatedAt: 2 })).toBe(
      recordJson(`{"to":"${ADDR}","name":"Alice","methods":[{"token":"jpyc","chain":"polygon"}]}`),
    );
  });

  it.each([null, [], 1, '', {}, { bio: false, avatar: 'http://bad.test', links: [null], theme: 'future' }])('drops wholly corrupt/empty profile %j without dropping the tip', (profile) => {
    expect(serializeHandleRecord(parseHandleRecord(rawRecord({ profile }))!)).toBe(recordJson());
  });

  it('retains undefined own keys and structural-only receiver/method validation on read', () => {
    const record = parseHandleRecord(rawRecord())!;
    expect(Object.keys(record.config)).toEqual(['to', 'name', 'message', 'color', 'thanks', 'thanksUrl', 'webhook', 'methods', 'presets']);
    expect(Object.hasOwn(record.config.methods[0], 'crossChain')).toBe(true);
    expect(record.config.methods[0].crossChain).toBeUndefined();
    expect(validateHandleTipConfig(record.config).ok).toBe(false);
  });

  it('keeps strict profile rejection distinct from tolerant stored recovery', () => {
    const profile = { bio: 'b'.repeat(161), avatar: 'http://bad.test', links: [{ label: 'OK', url: 'https://ok.test' }] };
    expect(validateProfile(profile)).toEqual({ ok: false, error: 'bio too long' });
    expect(serializeHandleRecord(parseHandleRecord(rawRecord({ profile }))!)).toBe(
      recordJson(configJson, `,"profile":{"bio":"${'b'.repeat(160)}","links":[{"label":"OK","url":"https://ok.test"}]}`),
    );
  });

  it('serializes in caller insertion order without revalidation or sorting', () => {
    const record = { updatedAt: 2, profile: { bio: ' untrimmed ' }, config, owner: 'owner', createdAt: 1 };
    expect(serializeHandleRecord(record)).toBe(`{"updatedAt":2,"profile":{"bio":" untrimmed "},"config":${configJson},"owner":"owner","createdAt":1}`);
  });
});
