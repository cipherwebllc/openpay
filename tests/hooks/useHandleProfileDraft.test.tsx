import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useHandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import { MAX_PROFILE_LINKS } from '@/lib/handle';

const STORAGE_KEY = 'openpay:handle-profile-draft:v1';

describe('useHandleProfileDraft', () => {
  beforeEach(() => {
    window.localStorage.clear();
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

  it('drops unknown kinds and heals heading url/featured without consuming featured', async () => {
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
