import { NextResponse } from 'next/server';
import { rejectCrossOriginWrite } from '@/lib/net/crossOriginWrite';
import { env } from '@/lib/env';
import { isAdminWallet } from '@/lib/adminAuth';
import { listingAssistantEnabled } from '@/lib/store/listingAssistantConfig';
import { imageUploadAvailableFor } from '@/lib/images/config';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import {
  getSellerDisclosure,
  parseSellerDisclosureInput,
  putSellerDisclosure,
} from '@/lib/x402/hostedStore';
import {
  hasOnlyKeys,
  objectValue,
  requireStoreSeller,
  STORE_BODY_MAX_BYTES,
  storePrivateJson,
} from '@/app/api/store/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELLER_INPUT_KEYS = new Set(['name', 'contact', 'disclosure']);

function notFound(): NextResponse {
  return storePrivateJson({ ok: false, error: 'not_found' }, 404);
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'seller-read');
  if (!auth.ok) return auth.response;

  const seller = await getSellerDisclosure(auth.address);
  if (seller === 'storage') {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  // 画面が AI 出品アシスタントの入口を出すか (フラグ ON かつ運営者)。POST の route も同じ順で自分で判定する。
  const listingAssistant = listingAssistantEnabled() && isAdminWallet(auth.address);
  // 画面が画像の欄 (アップロード) を出すか (段階 admin なら運営者だけ・all なら全員・秘密か Blob の設定が無ければ false)。
  // false のとき画面は今の URL の欄のまま。POST /api/images/upload も同じ順で自分で判定する。
  const imageUpload = imageUploadAvailableFor(auth.address);
  return storePrivateJson({ ok: true, seller, listingAssistant, imageUpload });
}

export async function PUT(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const csrf = rejectCrossOriginWrite(req, { json: true });
  if (csrf) return csrf;
  const auth = await requireStoreSeller(req, 'seller-write');
  if (!auth.ok) return auth.response;

  const body = await readJsonBodyCapped(req, STORE_BODY_MAX_BYTES);
  if (!body.ok) {
    return storePrivateJson(
      {
        ok: false,
        error:
          body.reason === 'too_large' ? 'payload_too_large' : 'invalid_json',
      },
      body.reason === 'too_large' ? 413 : 400,
    );
  }
  const raw = objectValue(body.value);
  if (!raw) {
    return storePrivateJson({ ok: false, error: 'invalid_body' }, 400);
  }
  if (!hasOnlyKeys(raw, SELLER_INPUT_KEYS)) {
    return storePrivateJson({ ok: false, error: 'invalid_body' }, 400);
  }
  const parsed = parseSellerDisclosureInput({
    name: raw.name,
    contact: raw.contact,
    disclosure: raw.disclosure,
  });
  if (!parsed.ok) {
    return storePrivateJson(
      { ok: false, error: 'invalid_seller', detail: parsed.error },
      400,
    );
  }
  if (!(await putSellerDisclosure(auth.address, parsed.value))) {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  const seller = await getSellerDisclosure(auth.address);
  if (seller === 'storage' || seller === null) {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  return storePrivateJson({ ok: true, seller });
}
