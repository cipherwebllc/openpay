// @handle 予約/更新 + 所有一覧 API (SIWE 必須)。NEXT_PUBLIC_ENABLE_HANDLES OFF で 404 (inert)。
//
// POST /api/handle { handle, config, profile?, expectedUpdatedAt? }
//   → 予約 (新規) or 所有者による version 付き設定更新
// GET  /api/handle  → 自分が保有する handle を**レコード込み**で返す (編集 UI の prefill 用)

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '../auth/siwe/_session';
import {
  validateHandle,
  validateHandleTipConfig,
  validateProfile,
  isAudiusHandleEmbedUrl,
  isHandleEmbedUrl,
  MAX_HANDLES_PER_WALLET,
  MAX_PROFILE_EMBEDS,
  MAX_PROFILE_LINKS,
  type HandleProfile,
} from '@/lib/handle';
import { validateStorefrontParts, type StorefrontParts } from '@/lib/mobileOrder';
import {
  reserveOrUpdateHandle,
  listHandleRecordsForOwner,
} from '@/lib/handleStore';

export const runtime = 'nodejs';
export const maxDuration = 10;

function notFound() {
  return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
}

const AUDIUS_RESOLVE_URL = 'https://api.audius.co/v1/resolve';
const AUDIUS_TRACK_LOCATION =
  /^https:\/\/api\.audius\.co\/v1\/tracks\/([A-Za-z0-9]{3,16})[/?]/;

async function resolveAudiusTrackId(url: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${AUDIUS_RESOLVE_URL}?url=${encodeURIComponent(url)}&app_name=openpay`,
      {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.status !== 302) return null;
    const location = response.headers.get('location');
    if (!location) return null;
    // undici fetch の Location は相対パスで返る (2026-08-01 実機で確認)。resolve API の
    // base で絶対化してから、host/path を含めて厳格検証する。
    let absolute: string;
    try {
      absolute = new URL(location, AUDIUS_RESOLVE_URL).toString();
    } catch {
      return null;
    }
    return absolute.match(AUDIUS_TRACK_LOCATION)?.[1] ?? null;
  } catch {
    // timeout/network 障害を未解決 ID の保存へ波及させず、呼出側で明示的な保存失敗に統一する。
    return null;
  }
}

type ResolvedAudiusProfile =
  | { ok: true; profile: unknown }
  | { ok: false; error: 'audius resolve failed' | 'too many embeds' };

async function resolveAudiusEmbeds(rawProfile: unknown): Promise<ResolvedAudiusProfile> {
  if (
    typeof rawProfile !== 'object' ||
    rawProfile === null ||
    Array.isArray(rawProfile)
  ) {
    return { ok: true, profile: rawProfile };
  }

  const source = rawProfile as Record<string, unknown>;
  if (!Array.isArray(source.links)) {
    return { ok: true, profile: rawProfile };
  }
  // 異常 payload による外向き fetch の fan-out を process/socket へ波及させない。
  // 既存 validator が同じ上限エラーを返すので、I/O 前にそのまま戻す。
  if (source.links.length > MAX_PROFILE_LINKS) {
    return { ok: true, profile: rawProfile };
  }

  const strippedLinks = source.links.map((rawLink) => {
    if (typeof rawLink !== 'object' || rawLink === null || Array.isArray(rawLink)) {
      return rawLink;
    }
    const link = { ...(rawLink as Record<string, unknown>) };
    // server 導出 field は全 provider で client 値を信用せず、保存ごとに strip する。
    delete link.embedResolved;
    return link;
  });
  const supportedEmbedCount = strippedLinks.reduce((count, rawLink) => {
    if (typeof rawLink !== 'object' || rawLink === null || Array.isArray(rawLink)) {
      return count;
    }
    const link = rawLink as Record<string, unknown>;
    return link.embed === true &&
      typeof link.url === 'string' &&
      isHandleEmbedUrl(link.url)
      ? count + 1
      : count;
  }, 0);
  if (supportedEmbedCount > MAX_PROFILE_EMBEDS) {
    return { ok: false, error: 'too many embeds' };
  }

  const resolvedLinks = await Promise.all(
    strippedLinks.map(async (rawLink) => {
      if (typeof rawLink !== 'object' || rawLink === null || Array.isArray(rawLink)) {
        return { ok: true as const, link: rawLink };
      }
      const link = rawLink as Record<string, unknown>;
      if (
        link.embed !== true ||
        typeof link.url !== 'string' ||
        !isAudiusHandleEmbedUrl(link.url)
      ) {
        return { ok: true as const, link };
      }

      const id = await resolveAudiusTrackId(link.url.trim());
      if (!id) {
        return { ok: false as const, error: 'audius resolve failed' as const };
      }
      link.embedResolved = { provider: 'audius', kind: 'track', id };
      return { ok: true as const, link };
    }),
  );
  const links: unknown[] = [];
  for (const result of resolvedLinks) {
    if (!result.ok) return result;
    links.push(result.link);
  }

  return {
    ok: true,
    profile: {
      ...source,
      links,
    },
  };
}

export async function GET() {
  if (!env.enableHandles) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  const owned = await listHandleRecordsForOwner(session.address);
  if (owned === null) {
    return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 502 });
  }
  // 編集 prefill のため config/profile も返す (公開ページと同じレコード)。
  // セッション固有の応答なので共有キャッシュ (CDN/proxy) に載せない。
  return NextResponse.json(
    {
      ok: true,
      handles: owned.map((o) => ({
        handle: o.handle,
        config: o.record.config,
        profile: o.record.profile,
        storefront: o.record.storefront, // 店舗公開済みかの prefill (ビルダーの「公開済み」表示)
        updatedAt: o.record.updatedAt,
      })),
      max: MAX_HANDLES_PER_WALLET,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(req: Request) {
  if (!env.enableHandles) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }
  const {
    handle: rawHandle,
    config: rawConfig,
    profile: rawProfile,
    storefront: rawStorefront,
    expectedUpdatedAt: rawExpectedUpdatedAt,
  } = body as Record<string, unknown>;
  if (typeof rawHandle !== 'string') {
    return NextResponse.json({ ok: false, error: 'handle_required' }, { status: 400 });
  }

  const validated = validateHandle(rawHandle);
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, error: validated.reason === 'reserved' ? 'reserved' : 'invalid_format' },
      { status: 400 },
    );
  }

  const config = validateHandleTipConfig(rawConfig);
  if (!config.ok) {
    return NextResponse.json(
      { ok: false, error: 'invalid_config', detail: config.error },
      { status: 400 },
    );
  }

  let expectedUpdatedAt: number | undefined;
  if (rawExpectedUpdatedAt !== undefined) {
    if (
      typeof rawExpectedUpdatedAt !== 'number' ||
      !Number.isFinite(rawExpectedUpdatedAt)
    ) {
      return NextResponse.json(
        { ok: false, error: 'invalid_expected_updated_at' },
        { status: 400 },
      );
    }
    expectedUpdatedAt = rawExpectedUpdatedAt;
  }

  // profile が body に無ければ undefined を渡す (= update で既存 profile を保持)。
  // 明示的に与えられた場合のみ検証して置換 (空 {} はクリア)。
  let profileArg: HandleProfile | undefined;
  if (rawProfile !== undefined && rawProfile !== null) {
    const resolvedProfile = await resolveAudiusEmbeds(rawProfile);
    if (!resolvedProfile.ok) {
      if (resolvedProfile.error === 'too many embeds') {
        return NextResponse.json(
          {
            ok: false,
            error: 'invalid_profile',
            detail: resolvedProfile.error,
          },
          { status: 400 },
        );
      }
      return NextResponse.json(
        { ok: false, error: resolvedProfile.error },
        { status: 400 },
      );
    }
    const profile = validateProfile(resolvedProfile.profile);
    if (!profile.ok) {
      return NextResponse.json(
        { ok: false, error: 'invalid_profile', detail: profile.error },
        { status: 400 },
      );
    }
    profileArg = profile.profile;
  }

  // storefront の三状態: 省略 = 変更しない / null = 削除 / object = 検証して置換 (店舗公開)。
  let storefrontArg: StorefrontParts | null | undefined;
  if (rawStorefront === null) {
    storefrontArg = null; // 明示クリア (店舗を取り下げ)
  } else if (rawStorefront !== undefined) {
    const sf = validateStorefrontParts(rawStorefront);
    if (!sf) {
      return NextResponse.json({ ok: false, error: 'invalid_storefront' }, { status: 400 });
    }
    storefrontArg = sf;
  }

  const result = await reserveOrUpdateHandle({
    handle: validated.handle,
    owner: session.address,
    config: config.config,
    profile: profileArg,
    storefront: storefrontArg,
    expectedUpdatedAt,
    nowMs: Date.now(),
  });

  switch (result.status) {
    case 'created':
      return NextResponse.json(
        {
          ok: true,
          handle: validated.handle,
          status: 'created',
          updatedAt: result.record.updatedAt,
          ...(result.listing ? { listing: result.listing } : {}),
        },
        { status: 201 },
      );
    case 'updated':
      return NextResponse.json({
        ok: true,
        handle: validated.handle,
        status: 'updated',
        updatedAt: result.record.updatedAt,
        ...(result.listing ? { listing: result.listing } : {}),
      });
    case 'conflict':
      return NextResponse.json({ ok: false, error: 'conflict' }, { status: 409 });
    case 'taken':
      return NextResponse.json({ ok: false, error: 'taken' }, { status: 409 });
    case 'limit':
      return NextResponse.json(
        { ok: false, error: 'limit', max: MAX_HANDLES_PER_WALLET },
        { status: 409 },
      );
    case 'kv_unavailable':
      return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
    case 'kv_error':
    default:
      logger.error('handle.reserve.kv_error', { handle: validated.handle });
      return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 502 });
  }
}
