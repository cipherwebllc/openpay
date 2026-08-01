import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useHandleProfileDraft } from '@/hooks/useHandleProfileDraft';
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
