// 埋め込み対応リンクの provider URL 解析と、allowlist 済み iframe URL の再構築 (browser-safe)。
// iframe src は user URL を転用せず、検証済みの type / ID だけから組み立てる。
import type { HandleEmbedResolved } from './schema';

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{22}$/;
const AUDIUS_ID_PATTERN = /^[A-Za-z0-9]{3,16}$/;
const NICONICO_ID_PATTERN = /^(?:sm|so|nm)\d+$/;
const VIMEO_ID_PATTERN = /^\d{6,12}$/;
const APPLE_MUSIC_ID_PATTERN = /^\d+$/;
const TIKTOK_USER_PATTERN = /^[A-Za-z0-9._]+$/;
const TIKTOK_ID_PATTERN = /^\d+$/;
const SUNO_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOUNDCLOUD_PATH_PART_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENCODED_PATH_COMPONENT_PATTERN = /^(?:[^/%]|%[0-9A-Fa-f]{2})+$/u;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com']);
const NICONICO_HOSTS = new Set([
  'nicovideo.jp',
  'www.nicovideo.jp',
  'sp.nicovideo.jp',
]);
const SPOTIFY_EMBED_TYPES = [
  'track',
  'album',
  'playlist',
  'episode',
  'show',
  'artist',
] as const;

export type HandleEmbed =
  | {
      provider: 'youtube' | 'niconico' | 'vimeo';
      id: string;
      src: string;
    }
  | {
      provider: 'spotify';
      type: (typeof SPOTIFY_EMBED_TYPES)[number];
      id: string;
      src: string;
      height: 152 | 352;
    }
  | {
      provider: 'audius';
      kind: 'track';
      id: string;
      src: string;
      height: 152;
    }
  | {
      provider: 'apple-music';
      storefront: string;
      slug: string;
      albumId: string;
      itemId?: string;
      src: string;
      height: 175 | 450;
    }
  | {
      provider: 'tiktok';
      id: string;
      src: string;
      height: 580;
    }
  | {
      provider: 'suno';
      id: string;
      src: string;
      height: 152;
    }
  | {
      provider: 'soundcloud';
      user: string;
      slug: string;
      src: string;
      height: 166;
    };

function isSpotifyEmbedType(
  value: string,
): value is (typeof SPOTIFY_EMBED_TYPES)[number] {
  return (SPOTIFY_EMBED_TYPES as readonly string[]).includes(value);
}

function parseHandleEmbedUrl(url: string): URL | null {
  const value = url.trim();
  // URL は既定 port (:443) を空文字へ正規化するため、parse 前の authority でも明示 port を拒否。
  const rawAuthority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
  if (!rawAuthority || rawAuthority.includes(':')) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  ) {
    return null;
  }
  return parsed;
}

function parseAudiusEmbedResolved(raw: unknown): HandleEmbedResolved | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const resolved = raw as Record<string, unknown>;
  if (
    resolved.provider !== 'audius' ||
    resolved.kind !== 'track' ||
    typeof resolved.id !== 'string' ||
    !AUDIUS_ID_PATTERN.test(resolved.id)
  ) {
    return null;
  }
  return { provider: 'audius', kind: 'track', id: resolved.id };
}

function encodeValidatedPathComponent(value: string): string | null {
  if (!ENCODED_PATH_COMPONENT_PATTERN.test(value)) return null;
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return null;
  }
}

// Audius は公開 URL だけでは track ID を得られないため、builder/route が保存前候補を
// 判定する関数を extractor と分離する。track 以外は server resolve の Location 検証で拒否する。
export function isAudiusHandleEmbedUrl(url: string): boolean {
  return parseHandleEmbedUrl(url)?.hostname === 'audius.co';
}

/**
 * 対応リンク URL から provider/ID を検証抽出し、安全な iframe 設定を返す。
 * iframe src は user URL を転用せず、allowlist 済み type と regex 済み ID だけで構築する。
 */
export function extractHandleEmbed(
  url: string,
  embedResolved?: unknown,
): HandleEmbed | null {
  const parsed = parseHandleEmbedUrl(url);
  if (!parsed) return null;

  const host = parsed.hostname;
  let youtubeId: string | null = null;
  if (YOUTUBE_HOSTS.has(host)) {
    if (/^\/watch\/?$/.test(parsed.pathname)) {
      youtubeId = parsed.searchParams.get('v');
    } else {
      youtubeId =
        parsed.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ??
        null;
    }
  } else if (host === 'youtu.be') {
    youtubeId =
      parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null;
  }
  if (youtubeId !== null) {
    if (!YOUTUBE_ID_PATTERN.test(youtubeId)) return null;
    return {
      provider: 'youtube',
      id: youtubeId,
      src: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
    };
  }

  if (host === 'open.spotify.com') {
    const spotifyPath = parsed.pathname.match(
      /^\/([^/]+)\/([A-Za-z0-9]{22})\/?$/,
    );
    if (!spotifyPath) return null;
    const [, type, spotifyId] = spotifyPath;
    if (!isSpotifyEmbedType(type) || !SPOTIFY_ID_PATTERN.test(spotifyId)) {
      return null;
    }
    return {
      provider: 'spotify',
      type,
      id: spotifyId,
      src: `https://open.spotify.com/embed/${type}/${spotifyId}`,
      height: type === 'track' || type === 'episode' ? 152 : 352,
    };
  }

  if (NICONICO_HOSTS.has(host)) {
    const id = parsed.pathname.match(/^\/watch\/((?:sm|so|nm)\d+)\/?$/)?.[1];
    if (!id || !NICONICO_ID_PATTERN.test(id)) return null;
    return {
      provider: 'niconico',
      id,
      src: `https://embed.nicovideo.jp/watch/${id}`,
    };
  }

  if (host === 'vimeo.com') {
    const id = parsed.pathname.match(/^\/(\d{6,12})\/?$/)?.[1];
    if (!id || !VIMEO_ID_PATTERN.test(id)) return null;
    return {
      provider: 'vimeo',
      id,
      src: `https://player.vimeo.com/video/${id}`,
    };
  }

  if (host === 'music.apple.com') {
    const path = parsed.pathname.match(
      /^\/([a-z]{2})\/album\/([^/]+)\/(\d+)\/?$/u,
    );
    if (!path) return null;
    const [, storefront, rawSlug, albumId] = path;
    const slug = encodeValidatedPathComponent(rawSlug);
    if (!slug || !APPLE_MUSIC_ID_PATTERN.test(albumId)) return null;

    const query = [...parsed.searchParams.entries()];
    let itemId: string | undefined;
    if (query.length > 0) {
      if (
        query.length !== 1 ||
        query[0][0] !== 'i' ||
        !APPLE_MUSIC_ID_PATTERN.test(query[0][1])
      ) {
        return null;
      }
      itemId = query[0][1];
    }

    return {
      provider: 'apple-music',
      storefront,
      slug,
      albumId,
      ...(itemId ? { itemId } : {}),
      src: `https://embed.music.apple.com/${storefront}/album/${slug}/${albumId}${
        itemId ? `?i=${itemId}` : ''
      }`,
      height: itemId ? 175 : 450,
    };
  }

  if (host === 'tiktok.com' || host === 'www.tiktok.com') {
    const path = parsed.pathname.match(/^\/@([^/]+)\/video\/(\d+)\/?$/);
    if (
      !path ||
      !TIKTOK_USER_PATTERN.test(path[1]) ||
      !TIKTOK_ID_PATTERN.test(path[2])
    ) {
      return null;
    }
    const id = path[2];
    return {
      provider: 'tiktok',
      id,
      src: `https://www.tiktok.com/embed/v2/${id}`,
      height: 580,
    };
  }

  if (host === 'suno.com') {
    const id = parsed.pathname.match(/^\/song\/([^/]+)\/?$/)?.[1];
    if (!id || !SUNO_UUID_V4_PATTERN.test(id)) return null;
    return {
      provider: 'suno',
      id,
      src: `https://suno.com/embed/${id}`,
      height: 152,
    };
  }

  if (host === 'soundcloud.com') {
    const path = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (
      !path ||
      !SOUNDCLOUD_PATH_PART_PATTERN.test(path[1]) ||
      !SOUNDCLOUD_PATH_PART_PATTERN.test(path[2]) ||
      parsed.searchParams.has('secret_token')
    ) {
      return null;
    }
    const [, user, slug] = path;
    const trackUrl = `https://soundcloud.com/${user}/${slug}`;
    return {
      provider: 'soundcloud',
      user,
      slug,
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(trackUrl)}`,
      height: 166,
    };
  }

  if (host !== 'audius.co') return null;
  const audius = parseAudiusEmbedResolved(embedResolved);
  if (!audius) return null;
  return {
    ...audius,
    src: `https://audius.co/embed/track/${audius.id}?flavor=compact`,
    // 120 だと実カード下端が切れてスクロールバーが出る (2026-08-01 本番実害)。
    // Spotify track 行と同じ 152 に統一。
    height: 152,
  };
}

// builder/draft/publish は Audius の server ID がまだ無い段階なので、URL 候補だけを判定する。
export function isHandleEmbedUrl(url: string): boolean {
  return extractHandleEmbed(url) !== null || isAudiusHandleEmbedUrl(url);
}
