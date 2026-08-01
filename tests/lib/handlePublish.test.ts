import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_DRAFT, type HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import {
  buildPublishProfile,
  buildPublishPayload,
  EMPTY_HANDLE_PUBLISH_BASELINE,
  formatPublishedRelativeTime,
  handlePublishBaselineReducer,
  hasDroppedProfileUrl,
  hasUnpublishedHandleChanges,
} from '@/lib/handlePublish';
import { MAX_LINK_IMAGE_URL_LEN, MAX_PROFILE_EMBEDS } from '@/lib/handle';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OPTIONS = { receiver: ADDR, enableJpycAvalanche: false };

function draft(patch: Partial<HandleProfileDraft> = {}): HandleProfileDraft {
  return {
    ...DEFAULT_PROFILE_DRAFT,
    presetsJpyc: [...DEFAULT_PROFILE_DRAFT.presetsJpyc],
    socials: [],
    links: [],
    to: ADDR,
    ...patch,
  };
}

describe('buildPublishPayload', () => {
  it('trim/filter/キー順 + config/profile theme を publish body で固定する', () => {
    const payload = buildPublishPayload(
      draft({
        name: '  Alice  ',
        color: '#12ab34',
        jpycAvalanche: true,
        presetsJpyc: [' 300 ', 'bad', '0', '5'],
        bio: '  hello  ',
        avatar: ' https://cdn.example/avatar.png ',
        socials: [
          ' https://x.com/alice ',
          'http://example.com/insecure',
        ],
        links: [
          {
            label: ' Site ',
            url: ' https://example.com ',
            emoji: ' 🌐 ',
            featured: true,
          },
          {
            label: 'Dropped',
            url: 'http://example.com',
            featured: true,
          },
        ],
        theme: 'night',
      }),
      OPTIONS,
    );

    expect(payload).not.toBeNull();
    const body = JSON.stringify({ handle: 'alice', ...payload });
    expect(body).toBe(
      `{"handle":"alice","config":{"to":"${ADDR}","name":"Alice","color":"#12ab34","theme":"night","methods":[{"token":"jpyc","chain":"polygon"},{"token":"jpyc","chain":"kaia"}],"presets":{"jpyc":["300","5"]}},"profile":{"bio":"hello","avatar":"https://cdn.example/avatar.png","socials":["https://x.com/alice"],"links":[{"label":"Site","url":"https://example.com","emoji":"🌐","featured":true}],"theme":"night"}}`,
    );
  });

  it('heading を canonical キー順 {kind,label,emoji} の exact JSON にする', () => {
    const payload = buildPublishPayload(
      draft({
        links: [
          { kind: 'heading', label: '  Projects  ', emoji: ' 📌 ' },
          { label: 'Site', url: 'https://example.com' },
        ],
      }),
      OPTIONS,
    );

    expect(payload).not.toBeNull();
    const body = JSON.stringify({ handle: 'alice', ...payload });
    expect(body).toBe(
      `{"handle":"alice","config":{"to":"${ADDR}","color":"#2563eb","theme":"clean","methods":[{"token":"jpyc","chain":"polygon"},{"token":"jpyc","chain":"kaia"}],"presets":{"jpyc":["300","1000","3000"]}},"profile":{"links":[{"kind":"heading","label":"Projects","emoji":"📌"},{"label":"Site","url":"https://example.com"}],"theme":"clean"}}`,
    );
  });

  it('opt-in link media を canonical キー順の exact JSON に追加する', () => {
    const payload = buildPublishPayload(
      draft({
        links: [
          {
            label: ' Video ',
            url: ' https://youtu.be/dQw4w9WgXcQ ',
            emoji: ' 🎬 ',
            imageUrl: ' https://cdn.example.com/video.jpg ',
            featured: true,
            embed: true,
          },
        ],
      }),
      OPTIONS,
    );

    expect(payload).not.toBeNull();
    const body = JSON.stringify({ handle: 'alice', ...payload });
    expect(body).toBe(
      `{"handle":"alice","config":{"to":"${ADDR}","color":"#2563eb","theme":"clean","methods":[{"token":"jpyc","chain":"polygon"},{"token":"jpyc","chain":"kaia"}],"presets":{"jpyc":["300","1000","3000"]}},"profile":{"links":[{"label":"Video","url":"https://youtu.be/dQw4w9WgXcQ","emoji":"🎬","imageUrl":"https://cdn.example.com/video.jpg","featured":true,"embed":true}],"theme":"clean"}}`,
    );
  });

  it('link imageUrl は https かつ 512 文字以下だけ canonical に残す', () => {
    const prefix = 'https://cdn.example.com/';
    const atLimit = `${prefix}${'a'.repeat(MAX_LINK_IMAGE_URL_LEN - prefix.length)}`;
    const profile = buildPublishProfile(
      draft({
        links: [
          { label: 'Exact', url: 'https://example.com/1', imageUrl: atLimit },
          {
            label: 'Too long',
            url: 'https://example.com/2',
            imageUrl: `${atLimit}a`,
          },
          {
            label: 'Insecure',
            url: 'https://example.com/3',
            imageUrl: 'http://cdn.example.com/image.jpg',
          },
        ],
      }),
    );

    expect(profile.links?.[0]).toHaveProperty('imageUrl', atLimit);
    expect(profile.links?.[1]).not.toHaveProperty('imageUrl');
    expect(profile.links?.[2]).not.toHaveProperty('imageUrl');
  });

  it('supported embed の先頭 3 件だけを canonical に残す', () => {
    const profile = buildPublishProfile(
      draft({
        links: [
          ...Array.from({ length: MAX_PROFILE_EMBEDS + 1 }, (_, index) => ({
            label: `Video ${index}`,
            url: 'https://youtu.be/dQw4w9WgXcQ',
            embed: true as const,
          })),
          {
            label: 'Unsupported',
            url: 'https://example.com/video',
            embed: true,
          },
        ],
      }),
    );

    expect(
      profile.links?.filter(
        (link) => link.kind !== 'heading' && link.embed === true,
      ),
    ).toHaveLength(MAX_PROFILE_EMBEDS);
    expect(profile.links?.[MAX_PROFILE_EMBEDS]).not.toHaveProperty('embed');
    expect(profile.links?.[MAX_PROFILE_EMBEDS + 1]).not.toHaveProperty('embed');
  });

  it('受取先未解決または受取方法 0 件は publish 不可 (null)', () => {
    expect(buildPublishPayload(draft(), { ...OPTIONS, receiver: null })).toBeNull();
    expect(
      buildPublishPayload(
        draft({ jpycPolygon: false, jpycKaia: false }),
        OPTIONS,
      ),
    ).toBeNull();
  });

  it('@handle publish はラベル付き tip URL preset を解釈せず黙って落とす', () => {
    const payload = buildPublishPayload(
      draft({ presetsJpyc: ['300|☕ コーヒー1杯', '1000'] }),
      OPTIONS,
    );
    expect(payload?.config.presets).toEqual({ jpyc: ['1000'] });
  });

  it('heading は URL drop 判定から隔離し、通常リンクだけを検査する', () => {
    expect(
      hasDroppedProfileUrl(
        draft({ links: [{ kind: 'heading', label: 'Projects' }] }),
      ),
    ).toBe(false);
    expect(
      hasDroppedProfileUrl(
        draft({ links: [{ label: 'Site', url: 'http://example.com' }] }),
      ),
    ).toBe(true);
  });

  it('非 https の link imageUrl も drop 警告の対象にする', () => {
    expect(
      hasDroppedProfileUrl(
        draft({
          links: [
            {
              label: 'Site',
              url: 'https://example.com',
              imageUrl: 'http://cdn.example.com/site.png',
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasDroppedProfileUrl(
        draft({
          links: [
            {
              label: 'Site',
              url: 'https://example.com',
              imageUrl: 'https://cdn.example.com/site.png',
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('handle publish baseline state machine', () => {
  it('読込直後=非dirty・canonical に影響しない空白/無効 URL の差も非dirty', () => {
    const loaded = buildPublishPayload(
      draft({ name: 'Alice', bio: 'hello' }),
      OPTIONS,
    )!;
    const state = handlePublishBaselineReducer(EMPTY_HANDLE_PUBLISH_BASELINE, {
      type: 'loaded',
      snapshot: { handle: 'alice', payload: loaded, updatedAt: 100 },
    });

    expect(hasUnpublishedHandleChanges(state, 'alice', loaded)).toBe(false);
    const equivalent = buildPublishPayload(
      draft({
        name: ' Alice ',
        bio: ' hello ',
        socials: ['http://invalid.example'],
      }),
      OPTIONS,
    )!;
    expect(hasUnpublishedHandleChanges(state, 'alice', equivalent)).toBe(false);
  });

  it('編集で dirty・publish 成功は送信 snapshot を baseline にし、送信後編集は dirty を維持', () => {
    const loaded = buildPublishPayload(draft({ name: 'Alice' }), OPTIONS)!;
    let state = handlePublishBaselineReducer(EMPTY_HANDLE_PUBLISH_BASELINE, {
      type: 'loaded',
      snapshot: { handle: 'alice', payload: loaded, updatedAt: 100 },
    });
    const sent = buildPublishPayload(draft({ name: 'Sent name' }), OPTIONS)!;
    expect(hasUnpublishedHandleChanges(state, 'alice', sent)).toBe(true);

    // mutation 変数が保持した sent を成功時 baseline にする。通信中に draft がさらに
    // 変わっていても current を baseline に採用しない。
    state = handlePublishBaselineReducer(state, {
      type: 'published',
      snapshot: { handle: 'alice', payload: sent, updatedAt: 200 },
    });
    expect(state.baseline?.updatedAt).toBe(200);
    expect(hasUnpublishedHandleChanges(state, 'alice', sent)).toBe(false);
    const editedAfterSend = buildPublishPayload(
      draft({ name: 'Edited after send' }),
      OPTIONS,
    )!;
    expect(hasUnpublishedHandleChanges(state, 'alice', editedAfterSend)).toBe(true);
  });

  it('heading の trim 同値は非dirty、編集・追加・削除・並替は dirty', () => {
    const links = [
      { kind: 'heading', label: 'Projects', emoji: '📌' },
      { label: 'Site', url: 'https://example.com' },
    ] satisfies HandleProfileDraft['links'];
    const loaded = buildPublishPayload(draft({ links }), OPTIONS)!;
    const state = handlePublishBaselineReducer(EMPTY_HANDLE_PUBLISH_BASELINE, {
      type: 'loaded',
      snapshot: { handle: 'alice', payload: loaded, updatedAt: 100 },
    });

    expect(hasUnpublishedHandleChanges(state, 'alice', loaded)).toBe(false);
    const trimEquivalent = buildPublishPayload(
      draft({
        links: [
          { kind: 'heading', label: ' Projects ', emoji: ' 📌 ' },
          { label: ' Site ', url: ' https://example.com ' },
        ],
      }),
      OPTIONS,
    )!;
    expect(
      hasUnpublishedHandleChanges(state, 'alice', trimEquivalent),
    ).toBe(false);

    const edited = buildPublishPayload(
      draft({
        links: [
          { kind: 'heading', label: 'Selected projects', emoji: '📌' },
          links[1],
        ],
      }),
      OPTIONS,
    )!;
    expect(hasUnpublishedHandleChanges(state, 'alice', edited)).toBe(true);

    const added = buildPublishPayload(
      draft({
        links: [
          ...links,
          { kind: 'heading', label: 'Contact' },
        ],
      }),
      OPTIONS,
    )!;
    expect(hasUnpublishedHandleChanges(state, 'alice', added)).toBe(true);

    const deleted = buildPublishPayload(
      draft({ links: [links[1]] }),
      OPTIONS,
    )!;
    expect(hasUnpublishedHandleChanges(state, 'alice', deleted)).toBe(true);

    const reordered = buildPublishPayload(
      draft({ links: [links[1], links[0]] }),
      OPTIONS,
    )!;
    expect(hasUnpublishedHandleChanges(state, 'alice', reordered)).toBe(true);
  });

  it('link image/embed の opt-in 変更も dirty にする', () => {
    const baseLinks = [
      { label: 'Video', url: 'https://youtu.be/dQw4w9WgXcQ' },
    ] satisfies HandleProfileDraft['links'];
    const loaded = buildPublishPayload(draft({ links: baseLinks }), OPTIONS)!;
    const state = handlePublishBaselineReducer(EMPTY_HANDLE_PUBLISH_BASELINE, {
      type: 'loaded',
      snapshot: { handle: 'alice', payload: loaded, updatedAt: 100 },
    });

    const withImage = buildPublishPayload(
      draft({
        links: [
          {
            ...baseLinks[0],
            imageUrl: 'https://cdn.example.com/video.jpg',
          },
        ],
      }),
      OPTIONS,
    )!;
    const withEmbed = buildPublishPayload(
      draft({ links: [{ ...baseLinks[0], embed: true }] }),
      OPTIONS,
    )!;
    expect(hasUnpublishedHandleChanges(state, 'alice', withImage)).toBe(true);
    expect(hasUnpublishedHandleChanges(state, 'alice', withEmbed)).toBe(true);
  });

  it('handle 切替は旧 baseline を置換し、編集停止/解放の discard で破棄する', () => {
    const alice = buildPublishPayload(draft({ name: 'Alice' }), OPTIONS)!;
    const bob = buildPublishPayload(draft({ name: 'Bob' }), OPTIONS)!;
    let state = handlePublishBaselineReducer(EMPTY_HANDLE_PUBLISH_BASELINE, {
      type: 'loaded',
      snapshot: { handle: 'alice', payload: alice, updatedAt: 100 },
    });
    state = handlePublishBaselineReducer(state, {
      type: 'loaded',
      snapshot: { handle: 'bob', payload: bob, updatedAt: 110 },
    });
    expect(state.baseline?.handle).toBe('bob');
    expect(hasUnpublishedHandleChanges(state, 'alice', alice)).toBe(false);
    expect(hasUnpublishedHandleChanges(state, 'bob', bob)).toBe(false);

    state = handlePublishBaselineReducer(state, { type: 'discarded' });
    expect(state.baseline).toBeNull();
    expect(hasUnpublishedHandleChanges(state, 'bob', null)).toBe(false);
  });
});

describe('formatPublishedRelativeTime', () => {
  it('Intl.RelativeTimeFormat の相対時刻 + ISO dateTime を返す', () => {
    const now = Date.UTC(2026, 6, 10, 12, 0, 0);
    const updatedAt = now - 2 * 60 * 60 * 1_000;
    expect(formatPublishedRelativeTime(updatedAt, 'ja', now)).toEqual({
      dateTime: '2026-07-10T10:00:00.000Z',
      label: '2 時間前',
    });
  });

  it('updatedAt 欠損/不正は UI fallback 用の null', () => {
    expect(formatPublishedRelativeTime(undefined, 'ja', 0)).toBeNull();
    expect(formatPublishedRelativeTime(Number.NaN, 'en', 0)).toBeNull();
  });
});
