import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_DRAFT, isPristineProfileDraft, sameProfileDraft, useHandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import {
  MAX_LINK_IMAGE_URL_LEN,
  MAX_PROFILE_EMBEDS,
  MAX_PROFILE_LINKS,
} from '@/lib/handle';

const STORAGE_KEY = 'openpay:handle-profile-draft:v1';

describe('useHandleProfileDraft', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each(['message', 'thanks', 'thanksUrl'] as const)('restores %s values and intentional empty strings without treating a legacy omission as clear', async (field) => {
    for (const value of [undefined, 'Saved value', '']) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ [field]: value }));
      const restored = renderHook(() => useHandleProfileDraft());
      await waitFor(() => expect(restored.result.current.hydrated).toBe(true));
      expect(restored.result.current.settings[field]).toBe(value);
      restored.unmount();
    }
  });

  it('退役した webhook (R1) が残る旧下書きもエラーにせず読み、webhook は捨てて手付かず判定にも数えない', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: 'Alice', webhook: 'https://discord.com/api/webhooks/1/x' }));
    const first = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(first.result.current.hydrated).toBe(true));
    expect(first.result.current.settings.name).toBe('Alice');
    expect(Object.hasOwn(first.result.current.settings, 'webhook')).toBe(false);
    first.unmount();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ webhook: 'https://discord.com/api/webhooks/1/x' }));
    const legacyOnly = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(legacyOnly.result.current.hydrated).toBe(true));
    expect(isPristineProfileDraft(legacyOnly.result.current.settings)).toBe(true);
  });


  it.each(['serif', 'rounded'] as const)('persists and restores %s/grid', async (font) => {
    const first = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(first.result.current.hydrated).toBe(true));
    act(() => first.result.current.setSettings((current) => ({ ...current, font, linkLayout: 'grid' })));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ font, linkLayout: 'grid' }));
    first.unmount();
    const restored = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(restored.result.current.hydrated).toBe(true));
    expect(restored.result.current.settings).toMatchObject({ font, linkLayout: 'grid' });
  });
  it.each([{}, { font: 'invalid', linkLayout: 'invalid' }, { font: null, linkLayout: 42 }])('restores legacy/invalid enums as defaults %j', async (loaded) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toMatchObject({ font: 'sans', linkLayout: 'list' });
  });
  it('saves, reloads and resets cover exactly like avatar', async () => {
    const first = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(first.result.current.hydrated).toBe(true));
    expect(first.result.current.settings.cover).toBe('');
    const images = {
      avatar: ' https://example.com/avatar.png ',
      cover: ' http://example.com/cover.png ',
    };
    act(() => first.result.current.setSettings((current) => ({ ...current, ...images })));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject(images);
    });
    first.unmount();
    const restored = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(restored.result.current.hydrated).toBe(true));
    expect(restored.result.current.settings).toMatchObject(images);
    act(() => restored.result.current.setSettings(DEFAULT_PROFILE_DRAFT));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
        avatar: '',
        cover: '',
      });
    });
    expect(restored.result.current.settings.cover).toBe('');
  });

  it('restores missing or non-string cover as empty', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cover: 42 }));
    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.cover).toBe('');
  });

  it('keeps v1 kind-less regular links backward compatible', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        links: [
          {
            label: 'Site',
            url: 'https://example.com',
            emoji: '🌐',
            featured: true,
          },
        ],
      }),
    );

    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.links).toEqual([
      {
        label: 'Site',
        url: 'https://example.com',
        emoji: '🌐',
        featured: true,
      },
    ]);
  });

  it('persists a heading in the existing v1 key and restores it after remount', async () => {
    const first = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(first.result.current.hydrated).toBe(true));
    act(() => {
      first.result.current.setSettings((current) => ({
        ...current,
        links: [
          { kind: 'heading', label: 'Projects', emoji: '📌' },
          { label: 'Site', url: 'https://example.com' },
        ],
      }));
    });
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) ?? '{}',
      );
      expect(stored.links).toEqual([
        { kind: 'heading', label: 'Projects', emoji: '📌' },
        { label: 'Site', url: 'https://example.com' },
      ]);
    });
    first.unmount();

    const restored = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(restored.result.current.hydrated).toBe(true));
    expect(restored.result.current.settings.links).toEqual([
      { kind: 'heading', label: 'Projects', emoji: '📌' },
      { label: 'Site', url: 'https://example.com' },
    ]);
  });

  it('persists raw link image input and a supported embed in the existing v1 key', async () => {
    const first = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(first.result.current.hydrated).toBe(true));
    act(() => {
      first.result.current.setSettings((current) => ({
        ...current,
        links: [
          {
            label: 'Video',
            url: 'https://youtu.be/dQw4w9WgXcQ',
            imageUrl: ' http://draft.example/video.jpg ',
            embed: true,
          },
        ],
      }));
    });
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) ?? '{}',
      );
      expect(stored.links).toEqual([
        {
          label: 'Video',
          url: 'https://youtu.be/dQw4w9WgXcQ',
          imageUrl: ' http://draft.example/video.jpg ',
          embed: true,
        },
      ]);
    });
    first.unmount();

    const restored = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(restored.result.current.hydrated).toBe(true));
    expect(restored.result.current.settings.links).toEqual([
      {
        label: 'Video',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        imageUrl: ' http://draft.example/video.jpg ',
        embed: true,
      },
    ]);
  });

  it('restores an Audius embed candidate but strips forged resolved data from v1 storage', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        links: [
          {
            label: 'Audius',
            url: 'https://audius.co/openpay/test-track',
            embed: true,
            embedResolved: {
              provider: 'audius',
              kind: 'track',
              id: 'Forged999',
            },
          },
        ],
      }),
    );

    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.links).toEqual([
      {
        label: 'Audius',
        url: 'https://audius.co/openpay/test-track',
        embed: true,
      },
    ]);
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) ?? '{}',
      ) as { links?: Array<Record<string, unknown>> };
      expect(stored.links?.[0]).not.toHaveProperty('embedResolved');
    });
  });

  it('drops unknown kinds and heals heading-only fields without consuming regular-link caps', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        links: [
          { kind: 'divider', label: 'Unknown' },
          {
            kind: 'heading',
            label: 'Projects',
            emoji: '📌',
            url: 'https://invalid.example',
            featured: true,
            imageUrl: 'https://invalid.example/heading.png',
            embed: true,
          },
          {
            label: 'Featured',
            url: 'https://example.com/featured',
            featured: true,
          },
          {
            label: 'Second',
            url: 'https://example.com/second',
            featured: true,
          },
        ],
      }),
    );

    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.links).toEqual([
      { kind: 'heading', label: 'Projects', emoji: '📌' },
      {
        label: 'Featured',
        url: 'https://example.com/featured',
        featured: true,
      },
      { label: 'Second', url: 'https://example.com/second' },
    ]);
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) ?? '{}',
      );
      expect(stored.links).toEqual(result.current.settings.links);
    });
  });

  it('drops unsupported/stale embeds and keeps only the first MAX_PROFILE_EMBEDS', async () => {
    const supported = Array.from(
      { length: MAX_PROFILE_EMBEDS + 1 },
      (_, index) => ({
        label: `Video ${index}`,
        url: 'https://youtu.be/dQw4w9WgXcQ',
        embed: true,
      }),
    );
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        links: [
          ...supported,
          {
            label: 'Unsupported',
            url: 'https://example.com/video',
            embed: true,
          },
        ],
      }),
    );

    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(
      result.current.settings.links.filter(
        (link) => link.kind !== 'heading' && link.embed === true,
      ),
    ).toHaveLength(MAX_PROFILE_EMBEDS);
    expect(result.current.settings.links[MAX_PROFILE_EMBEDS]).toEqual({
      label: `Video ${MAX_PROFILE_EMBEDS}`,
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(result.current.settings.links[MAX_PROFILE_EMBEDS + 1]).toEqual({
      label: 'Unsupported',
      url: 'https://example.com/video',
    });
  });

  it('drops an over-limit link image from corrupted localStorage on restore', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        links: [
          {
            label: 'Image',
            url: 'https://example.com',
            imageUrl: `https://${'a'.repeat(MAX_LINK_IMAGE_URL_LEN)}`,
          },
        ],
      }),
    );

    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.links).toEqual([
      { label: 'Image', url: 'https://example.com' },
    ]);
  });

  it('shares MAX_PROFILE_LINKS between headings and regular links on reload', async () => {
    const links = Array.from({ length: MAX_PROFILE_LINKS + 1 }, (_, index) =>
      index % 2 === 0
        ? { kind: 'heading', label: `Heading ${index}` }
        : { label: `Link ${index}`, url: `https://example.com/${index}` },
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ links }));

    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.links).toHaveLength(MAX_PROFILE_LINKS);
    expect(result.current.settings.links).toEqual(links.slice(0, MAX_PROFILE_LINKS));
  });
});

it.each([undefined, null, 1, 'true', true, false])('usdcArc draft is additive and strictly boolean: %s', async (value) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ usdcBase: true, usdcArc: value }));
  const { result } = renderHook(() => useHandleProfileDraft());
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  expect(result.current.settings.usdcArc).toBe(value === true);
  expect(result.current.settings.usdcBase).toBe(true);
});

describe('isPristineProfileDraft (持っている @handle の編集に自動で入ってよいか)', () => {
  const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

  it('既定のまま・受取先が空か接続中のウォレット (大文字小文字を問わない) なら手付かず', () => {
    expect(isPristineProfileDraft(DEFAULT_PROFILE_DRAFT)).toBe(true);
    expect(isPristineProfileDraft({ ...DEFAULT_PROFILE_DRAFT, to: WALLET }, WALLET)).toBe(true);
    expect(isPristineProfileDraft({ ...DEFAULT_PROFILE_DRAFT, to: WALLET.toLowerCase() }, WALLET)).toBe(true);
  });

  it('別の受取先を打った下書きは手付かずではない', () => {
    expect(isPristineProfileDraft({ ...DEFAULT_PROFILE_DRAFT, to: WALLET })).toBe(false);
    expect(isPristineProfileDraft({ ...DEFAULT_PROFILE_DRAFT, to: 'alice.eth' }, WALLET)).toBe(false);
  });

  it.each(['message', 'thanks', 'thanksUrl'] as const)('高度な設定 (%s) だけ書いた下書きも手付かずではない', (key) => {
    expect(isPristineProfileDraft({ ...DEFAULT_PROFILE_DRAFT, [key]: 'x' })).toBe(false);
    expect(isPristineProfileDraft({ ...DEFAULT_PROFILE_DRAFT, [key]: '' })).toBe(true);
  });
});

describe('sameProfileDraft (保存時と同じ正規化で、すべての項目を比べる)', () => {
  it('色の大文字小文字やキーの順序は同じと見なす', () => {
    expect(sameProfileDraft({ ...DEFAULT_PROFILE_DRAFT, color: '#2563EB' }, DEFAULT_PROFILE_DRAFT)).toBe(true);
  });
  it('公開に載らない入力途中の値 (空の URL のリンク・空の SNS 行) も違いとして数える', () => {
    expect(sameProfileDraft({ ...DEFAULT_PROFILE_DRAFT, links: [{ label: 'x', url: '' }] }, DEFAULT_PROFILE_DRAFT)).toBe(false);
    expect(sameProfileDraft({ ...DEFAULT_PROFILE_DRAFT, socials: [''] }, DEFAULT_PROFILE_DRAFT)).toBe(false);
  });
});

// トップの見本から入れたテーマと色の印 (seededLook・plans/lp-polish-2026-11.md P6)。
describe('見本から入れたテーマと色の印 (seededLook)', () => {
  const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
  const SEEDED = { ...DEFAULT_PROFILE_DRAFT, theme: 'night', color: '#7c3aed', seededLook: { theme: 'night', color: '#7c3aed' } } as const;

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('印の無い旧い下書きはそのまま読めて、印のキーを足さない (保存し直しもしない)', async () => {
    const legacy = JSON.stringify({ ...DEFAULT_PROFILE_DRAFT, name: 'Alice', theme: 'bold' });
    localStorage.setItem(STORAGE_KEY, legacy);
    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toMatchObject({ name: 'Alice', theme: 'bold' });
    expect(Object.hasOwn(result.current.settings, 'seededLook')).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem(STORAGE_KEY)).toBe(legacy);
  });

  it('印は値と一緒に保存され、読み直しても残る', async () => {
    const first = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(first.result.current.hydrated).toBe(true));
    act(() => first.result.current.setSettings((s) => ({ ...s, theme: 'night', color: '#7c3aed', seededLook: { theme: 'night', color: '#7c3aed' } })));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ theme: 'night', color: '#7c3aed', seededLook: { theme: 'night', color: '#7c3aed' } }),
    );
    first.unmount();
    const restored = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(restored.result.current.hydrated).toBe(true));
    expect(restored.result.current.settings.seededLook).toEqual({ theme: 'night', color: '#7c3aed' });
    expect(isPristineProfileDraft(restored.result.current.settings)).toBe(true);
  });

  it.each([
    ['テーマが一覧に無い', { theme: 'neon', color: '#7c3aed' }],
    ['色が #rrggbb でない', { theme: 'night', color: 'violet' }],
    ['色が無い', { theme: 'night' }],
    ['配列', ['night', '#7c3aed']],
    ['文字列', 'night'],
    ['null', null],
  ])('壊れた印 (%s) は印なしに戻し、値 (テーマと色) はそのまま', async (_label, seededLook) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'night', color: '#7c3aed', seededLook }));
    const { result } = renderHook(() => useHandleProfileDraft());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toMatchObject({ theme: 'night', color: '#7c3aed' });
    expect(Object.hasOwn(result.current.settings, 'seededLook')).toBe(false);
    // 印が無いので、既定でないテーマと色の下書きは手が入ったものと数える (今までと同じ)。
    expect(isPristineProfileDraft(result.current.settings)).toBe(false);
  });

  it('別のタブで入れた値と印は、前面に戻ったときに一緒に取り込む', async () => {
    const a = renderHook(() => useHandleProfileDraft()).result;
    const b = renderHook(() => useHandleProfileDraft()).result;
    await waitFor(() => expect(a.current.hydrated && b.current.hydrated).toBe(true));
    act(() => a.current.setSettings((s) => ({ ...s, theme: 'night', color: '#7c3aed', seededLook: { theme: 'night', color: '#7c3aed' } })));
    expect(b.current.settings.theme).toBe('clean');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(b.current.settings).toMatchObject({ theme: 'night', color: '#7c3aed', seededLook: { theme: 'night', color: '#7c3aed' } });
    expect(isPristineProfileDraft(b.current.settings)).toBe(true);
    // 片方のタブで公開中の内容を読み込む (印の無い下書きに置き換わる) と、もう片方からも印が消える。
    act(() => a.current.setSettings(() => ({ ...DEFAULT_PROFILE_DRAFT, to: WALLET, theme: 'night', color: '#7c3aed' })));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(Object.hasOwn(b.current.settings, 'seededLook')).toBe(false);
    expect(isPristineProfileDraft(b.current.settings, WALLET)).toBe(false);
  });

  it('手付かずの判定: 入れた値のままでほかが既定なら手付かず (受取先が接続中のウォレットでも)', () => {
    expect(isPristineProfileDraft(SEEDED)).toBe(true);
    expect(isPristineProfileDraft({ ...SEEDED, to: WALLET }, WALLET)).toBe(true);
    // 片方だけ入れた印 (もう片方は既定の値のまま)。
    expect(isPristineProfileDraft({ ...DEFAULT_PROFILE_DRAFT, theme: 'night', seededLook: { theme: 'night', color: DEFAULT_PROFILE_DRAFT.color } })).toBe(true);
  });

  it('手付かずの判定: テーマか色を入れた値から変えた・ほかの項目を書いた・別の受取先を打った下書きは手付かずではない', () => {
    expect(isPristineProfileDraft({ ...SEEDED, theme: 'bold' })).toBe(false);
    expect(isPristineProfileDraft({ ...SEEDED, color: '#059669' })).toBe(false);
    expect(isPristineProfileDraft({ ...SEEDED, name: 'Alice' })).toBe(false);
    expect(isPristineProfileDraft({ ...SEEDED, font: 'serif' })).toBe(false);
    expect(isPristineProfileDraft({ ...SEEDED, message: 'x' })).toBe(false);
    expect(isPristineProfileDraft({ ...SEEDED, to: WALLET })).toBe(false);
    // 既定のテーマと色に戻した下書きは、印があっても今までどおり手付かず。
    expect(isPristineProfileDraft({ ...SEEDED, theme: 'clean', color: '#2563eb' })).toBe(true);
  });

  it('公開中との比較 (sameProfileDraft) は印を比べない', () => {
    const { seededLook: _seededLook, ...published } = SEEDED;
    expect(sameProfileDraft(SEEDED, published)).toBe(true);
    expect(sameProfileDraft(SEEDED, { ...published, color: '#059669' })).toBe(false);
  });
});
