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

// トップの見本から入れたテーマと色 (plans/lp-polish-2026-11.md P6)。印は下書きに入れず、タブごとに持つ (hooks/useLandingLookSeed)。
// 手付かずの判定は、このタブの印を渡したときだけ、テーマと色が印のままなら既定と同じに数える。
describe('isPristineProfileDraft: このタブの見本の印 (seed) を渡したとき', () => {
  const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
  const SEED = { theme: 'night', color: '#7c3aed' } as const;
  const LOOK = { ...DEFAULT_PROFILE_DRAFT, theme: 'night', color: '#7c3aed' } as const;

  it('テーマと色が印のままで、ほかが既定なら手付かず (受取先が接続中のウォレットでも)', () => {
    expect(isPristineProfileDraft(LOOK, undefined, SEED)).toBe(true);
    expect(isPristineProfileDraft({ ...LOOK, to: WALLET }, WALLET, SEED)).toBe(true);
    // 既定のテーマと色は、印があっても今までどおり手付かず。
    expect(isPristineProfileDraft(DEFAULT_PROFILE_DRAFT, undefined, SEED)).toBe(true);
  });

  it('印を渡さない (別のタブ・印が無い) ときは今までと同じ: 見本の値の入った下書きは手を入れたもの', () => {
    expect(isPristineProfileDraft(LOOK)).toBe(false);
    expect(isPristineProfileDraft(LOOK, WALLET, null)).toBe(false);
  });

  it('テーマか色が印と違う・ほかの項目を書いた・別の受取先を打った下書きは手付かずではない', () => {
    expect(isPristineProfileDraft({ ...LOOK, theme: 'bold' }, undefined, SEED)).toBe(false);
    expect(isPristineProfileDraft({ ...LOOK, color: '#059669' }, undefined, SEED)).toBe(false);
    expect(isPristineProfileDraft({ ...LOOK, name: 'Alice' }, undefined, SEED)).toBe(false);
    expect(isPristineProfileDraft({ ...LOOK, font: 'serif' }, undefined, SEED)).toBe(false);
    expect(isPristineProfileDraft({ ...LOOK, message: 'x' }, undefined, SEED)).toBe(false);
    expect(isPristineProfileDraft({ ...LOOK, to: WALLET }, undefined, SEED)).toBe(false);
  });
});

// 2 つのタブ (同じ localStorage) で、片方のタブの変更がまだ保存されていない間に前面に戻る順。同期の決まり (SYNC_RULES) は
// main のまま: テーマと色はそれぞれ別の単位で、両方のタブの変更が混ざって残る。見本の印を下書きに入れない (P6) ので、別のタブの
// 見本の値が、このタブの手入力を「手付かず」に変えることもない。
describe('別のタブとの同期: テーマと色 (main と同じ結果)', () => {
  const focusTab = () => act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  const look = (d: { theme: string; color: string }) => ({ theme: d.theme, color: d.color });
  const storedLook = () => look(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));

  beforeEach(() => {
    window.localStorage.clear();
  });

  async function twoTabs() {
    const a = renderHook(() => useHandleProfileDraft()).result;
    const b = renderHook(() => useHandleProfileDraft()).result;
    await waitFor(() => expect(a.current.hydrated && b.current.hydrated).toBe(true));
    return { a, b };
  }

  it('B が見本の Bold × 緑を保存 → A が手で Bold を選んで未保存のまま前面に戻る: A は手付かずにならない', async () => {
    const { a, b } = await twoTabs();
    // B は見本の値を入れたタブ (B の印は B だけのもの)。
    act(() => b.current.setSettings((s) => ({ ...s, theme: 'bold', color: '#059669' })));
    act(() => {
      a.current.setSettings((s) => ({ ...s, theme: 'bold' }));
      window.dispatchEvent(new Event('focus'));
    });
    expect(look(a.current.settings)).toEqual({ theme: 'bold', color: '#059669' });
    // A には印が無い: 手入力の入った下書きは手付かずではない (持っている @handle の自動編集に入らない)。
    expect(isPristineProfileDraft(a.current.settings)).toBe(false);
    expect(isPristineProfileDraft(b.current.settings, undefined, { theme: 'bold', color: '#059669' })).toBe(true);
  });

  it('B が緑を保存 → A が未保存の Bold のまま前面に戻る → 両方の変更が残る', async () => {
    const { a, b } = await twoTabs();
    act(() => b.current.setSettings((s) => ({ ...s, color: '#059669' })));
    act(() => {
      a.current.setSettings((s) => ({ ...s, theme: 'bold' }));
      window.dispatchEvent(new Event('focus'));
    });
    focusTab();
    expect(storedLook()).toEqual({ theme: 'bold', color: '#059669' });
    expect(look(a.current.settings)).toEqual({ theme: 'bold', color: '#059669' });
    expect(look(b.current.settings)).toEqual({ theme: 'bold', color: '#059669' });
  });

  it('B が緑を保存 → A が前面に戻らずに Bold を保存 → 両方の変更が残る', async () => {
    const { a, b } = await twoTabs();
    act(() => b.current.setSettings((s) => ({ ...s, color: '#059669' })));
    act(() => a.current.setSettings((s) => ({ ...s, theme: 'bold' })));
    expect(storedLook()).toEqual({ theme: 'bold', color: '#059669' });
    focusTab();
    expect(look(a.current.settings)).toEqual({ theme: 'bold', color: '#059669' });
    expect(look(b.current.settings)).toEqual({ theme: 'bold', color: '#059669' });
  });

  it('B が Bold を保存 → A が未保存の緑のまま前面に戻る → 両方の変更が残る', async () => {
    const { a, b } = await twoTabs();
    act(() => b.current.setSettings((s) => ({ ...s, theme: 'bold' })));
    act(() => {
      a.current.setSettings((s) => ({ ...s, color: '#059669' }));
      window.dispatchEvent(new Event('focus'));
    });
    focusTab();
    expect(storedLook()).toEqual({ theme: 'bold', color: '#059669' });
    expect(look(a.current.settings)).toEqual({ theme: 'bold', color: '#059669' });
    expect(look(b.current.settings)).toEqual({ theme: 'bold', color: '#059669' });
  });
});
