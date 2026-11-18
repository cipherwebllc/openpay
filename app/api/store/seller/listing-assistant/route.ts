import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { isAdminWallet } from '@/lib/adminAuth';
import { logger } from '@/lib/logger';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { rejectCrossOriginWrite } from '@/lib/net/crossOriginWrite';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
import { listingAssistantEnabled } from '@/lib/store/listingAssistantConfig';
import {
  generateListingDraft,
  LISTING_ASSISTANT_BODY_MAX_BYTES,
  LISTING_ASSISTANT_DAILY_KEY,
  LISTING_ASSISTANT_DAILY_MAX,
  parseListingAssistantInput,
  secondsUntilNextUtcDay,
} from '@/lib/store/listingAssistantServer';
import { requireStoreSeller, storePrivateJson } from '@/app/api/store/_shared';

// AI 出品アシスタント (Gemini で出品文の案を作る)。運営者 (ADMIN_WALLETS) だけの試し・既定 OFF。
// 商品を KV から読まない: 送るのは画面から届いた公開用の欄 (lib/store/listingAssistant の許可リスト)・メモ・画像だけ。
// お金の動き (relay・settle・fee・order) には触れない。案は保存しない (反映は画面のフォーム → 既存の保存)。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Gemini を待つのは 20 秒まで (lib/store/listingAssistantServer)。本文の読み取り・認証・応答の分を足した上限。
export const maxDuration = 30;

const DAY_SEC = 86_400;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore || !listingAssistantEnabled()) {
    return storePrivateJson({ ok: false, error: 'not_found' }, 404);
  }
  const csrf = rejectCrossOriginWrite(req, { json: true });
  if (csrf) return csrf;

  const body = await readJsonBodyCapped(req, LISTING_ASSISTANT_BODY_MAX_BYTES);
  if (!body.ok) {
    return storePrivateJson(
      { ok: false, error: body.reason === 'too_large' ? 'payload_too_large' : 'invalid_json' },
      body.reason === 'too_large' ? 413 : 400,
    );
  }

  const auth = await requireStoreSeller(req, 'listing-assistant');
  if (!auth.ok) return auth.response;
  // ADMIN_WALLETS が空なら誰も通さない (isAdminWallet は fail-closed)。
  if (!isAdminWallet(auth.address)) {
    return storePrivateJson({ ok: false, error: 'forbidden' }, 403);
  }

  // 全体の日次 1 本 (UTC 日の窓)。checkReadRateLimit は no-throw・KV 障害は通す (既存の limiter と同じ fail-open)。
  if (!(await checkReadRateLimit(LISTING_ASSISTANT_DAILY_KEY, LISTING_ASSISTANT_DAILY_MAX, DAY_SEC))) {
    const retryAfterSec = secondsUntilNextUtcDay();
    return storePrivateJson(
      { ok: false, error: 'rate_limited', retryAfterSec },
      429,
      { 'Retry-After': String(retryAfterSec) },
    );
  }

  const parsed = parseListingAssistantInput(body.value);
  if (!parsed.ok) {
    return storePrivateJson({ ok: false, error: parsed.error }, parsed.status);
  }

  const result = await generateListingDraft(parsed.input);
  if (!result.ok) {
    // 固定の code と Google の HTTP status だけ (入力の画像・メモ・出力の本文は出さない)。
    logger.warn('store.listing_assistant.failed', {
      code: result.error,
      ...(result.upstreamStatus === undefined ? {} : { upstreamStatus: result.upstreamStatus }),
    });
    return storePrivateJson(
      { ok: false, error: result.error, ...(result.retryAfterSec === undefined ? {} : { retryAfterSec: result.retryAfterSec }) },
      result.status,
      result.retryAfterSec === undefined ? undefined : { 'Retry-After': String(result.retryAfterSec) },
    );
  }
  return storePrivateJson({ ok: true, draft: result.draft });
}
