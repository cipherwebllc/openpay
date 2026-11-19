import 'server-only';

import { isAdminWallet } from '@/lib/adminAuth';

// 画像のアップロードの server の設定 (段階・ownerKey の秘密・Blob の store)。server-only (掟 9: 秘密を client 共有の
// lib/env.ts に入れない)。Blob の操作 (lib/images/blobStore.ts) と分けるのは、出品者の GET (app/api/store/seller) が
// ここだけを見るため — @vercel/blob を出品者の GET と、その route を読む兄弟のテストに持ち込まない。

export type ImageUploadMode = 'off' | 'admin' | 'all';

const MIN_OWNER_SECRET_BYTES = 32;

// 不正な値の警告はプロセスごとに 1 回 (route と出品者の GET が要求ごとに読むので、毎回ログを埋めない)。
let warnedUnrecognizedMode = false;

/**
 * 公開の段階 (既定 off)。`admin` = ADMIN_WALLETS の運営者だけ・`all` = SIWE でサインインした全員。
 * 不正な値は off とし、値そのものはログに出さない (誤って秘密を入れた設定をログに残さないため)。
 */
export function imageUploadMode(): ImageUploadMode {
  const raw = process.env.IMAGE_UPLOAD_MODE;
  if (raw === 'admin' || raw === 'all') return raw;
  if (raw && raw !== 'off' && !warnedUnrecognizedMode) {
    warnedUnrecognizedMode = true;
    console.warn('[OpenPay] IMAGE_UPLOAD_MODE has an unrecognized value; treating as off.');
  }
  return 'off';
}

/**
 * ownerKey (path のウォレットの部分) を作る秘密。32 byte 未満・未設定なら null (= 発行しない・503 not_configured)。
 * 回さない: 回すと同じウォレットの ownerKey が変わり、PR 3 の一覧・削除・枚数の数え方が前の画像に届かなくなる。
 */
export function imageOwnerSecret(): string | null {
  const secret = process.env.IMAGE_OWNER_KEY_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_OWNER_SECRET_BYTES) return null;
  return secret;
}

/**
 * Blob の store がつながっているか (BLOB_STORE_ID)。認証は OIDC: Vercel の関数では request の x-vercel-oidc-token、
 * 手元では `vercel env pull` の VERCEL_OIDC_TOKEN を @vercel/blob が読む。長く生きる BLOB_READ_WRITE_TOKEN は使わない。
 */
export function imageBlobStoreConfigured(): boolean {
  return (process.env.BLOB_STORE_ID?.trim() ?? '') !== '';
}

/** この段階でそのウォレットがアップロードしてよいか (段階と権限だけ・設定の有無は見ない)。 */
export function imageUploadAllowedFor(mode: ImageUploadMode, address: string): boolean {
  if (mode === 'all') return true;
  // ADMIN_WALLETS が空なら誰も通さない (isAdminWallet は fail-closed)。
  return mode === 'admin' && isAdminWallet(address);
}

/**
 * 画面が新しい画像の欄を出すか (出品者の GET の imageUpload)。段階・権限に加えて、秘密と Blob の設定がそろっているとき
 * だけ true (そろっていないのに欄を出すと、押すたびに 503 になる)。POST の route も同じ順で自分で判定する。
 */
export function imageUploadAvailableFor(address: string): boolean {
  const mode = imageUploadMode();
  return imageUploadAllowedFor(mode, address) && imageOwnerSecret() !== null && imageBlobStoreConfigured();
}
