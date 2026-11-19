import 'server-only';

import { isAdminWallet } from '@/lib/adminAuth';

// 画像のアップロードの server の設定 (段階・ownerKey の秘密・Blob の store)。server-only (掟 9: 秘密を client 共有の
// lib/env.ts に入れない)。Blob の操作 (lib/images/blobStore.ts) と分けるのは、出品者の GET (app/api/store/seller) と
// @handle の持ち主の GET (app/api/handle) がここだけを見るため — @vercel/blob をその GET と、その route を読む兄弟の
// テストに持ち込まない。

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

// IP の枠の秘密 (IP_HASH_SECRET) の最小の長さ。lib/net/ipHash の MIN_SECRET_BYTES と同じ値 (それより短いと hashIpBucket が
// null を返し、POST の route は 503 not_configured で止まる)。ipHash を import しないのは、ipHash を vi.mock する兄弟のテストが
// 出品者の GET を読むため (mock に無い export を読むと落ちる)。2 つが同じ判定であることは tests/app/api/handle-image-upload.test.ts が見る。
const MIN_IP_HASH_SECRET_BYTES = 32;

/** IP の枠を数えられる設定か (IP_HASH_SECRET が 32 byte 以上)。接続元の IP が分からない要求は POST の route が自分で止める。 */
function imageUploadIpHashConfigured(): boolean {
  const secret = process.env.IP_HASH_SECRET;
  return !!secret && Buffer.byteLength(secret, 'utf8') >= MIN_IP_HASH_SECRET_BYTES;
}

/** この段階でそのウォレットがアップロードしてよいか (段階と権限だけ・設定の有無は見ない)。 */
export function imageUploadAllowedFor(mode: ImageUploadMode, address: string): boolean {
  if (mode === 'all') return true;
  // ADMIN_WALLETS が空なら誰も通さない (isAdminWallet は fail-closed)。
  return mode === 'admin' && isAdminWallet(address);
}

/** 秘密・Blob の設定・IP の枠の秘密がそろっているか (段階と権限は見ない)。 */
function imageUploadConfigured(): boolean {
  return imageOwnerSecret() !== null && imageBlobStoreConfigured() && imageUploadIpHashConfigured();
}

/**
 * 画面が新しい画像の欄を出すか (出品者の GET と、@handle の持ち主の GET /api/handle と、/api/auth/siwe/me の imageUpload)。
 * 段階・権限に加えて、秘密・Blob の設定・IP の枠の秘密がそろっているときだけ true (そろっていないのに欄を出すと、押すたびに
 * 503 になる)。アップロード・一覧・削除の route も同じ順で自分で判定する。
 */
export function imageUploadAvailableFor(address: string): boolean {
  return imageUploadAllowedFor(imageUploadMode(), address) && imageUploadConfigured();
}

/**
 * サインインの前に「サインインすると画像の機能を使えるかもしれない」と言えるか (/api/auth/siwe/me の imageUploadSignIn・
 * ヘッダのサインインの導線 = 掟 7)。段階が admin / all で設定がそろっているときだけ true。admin では運営者かどうかは
 * サインインするまで分からないので、全員にサインインの導線だけを出す (画像の欄と一覧は imageUploadAvailableFor で決める)。
 */
export function imageUploadSignInOffered(): boolean {
  return imageUploadMode() !== 'off' && imageUploadConfigured();
}

/**
 * サインインすれば誰でも画像をアップロードできる段階か (/api/auth/siwe/me の imageUploadOpen)。段階が all で設定がそろって
 * いるときだけ true。画面の「サインインすると画像をアップロードできます」の 1 行はこれで出す (admin の段階では運営者でない人に
 * できないことを言わない・ヘッダのサインインの導線は imageUploadSignInOffered のまま)。
 */
export function imageUploadOpenToAll(): boolean {
  return imageUploadMode() === 'all' && imageUploadConfigured();
}
