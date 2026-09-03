// SIWE (Sign-In With Ethereum / EIP-4361) ログインの純粋コア + KV キー/トークン util。
//
// 店主は wallet アドレスのみで一意識別されるため、freee トークン保存 (Phase C) や
// 収益化ゲート (Phase D) の前提として「この cookie = この checksum アドレス」を確立する。
// jose/iron-session を足さず、ランダム cookie トークン → KV セッションレコードで実現する。
//
// セキュリティ: nonce はサーバ発行 1 回限り (DEL の atomic count で replay を弾く)・
// message domain は呼出側の host と一致必須・署名検証は viem verifySiweMessage (EOA は
// ローカル ECDSA recover、スマートアカウントは ERC-6492/1271)。本モジュールは viem/KV を
// 注入する DI コアにして、署名や KV 無しでも全分岐を unit test できるようにする。

import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { LEGAL_ENTITY } from './legal';

/** セッション cookie 名の基底 (dev/test はこの素の名前をそのまま使う)。 */
const SESSION_COOKIE_BASE = 'op_sess';

/**
 * セッション cookie 名 (reader/writer 共通の単一情報源)。httpOnly のため client JS からは読めない。
 *
 * 本番は `__Host-` prefix を付ける。この prefix の付いた cookie をブラウザは
 * 「Secure + Path=/ + Domain 属性なし」でしか受理せず、**サブドメインからの上書き**も拒否する。
 * 何の波及を断つための防御か: 乗っ取られた/別運用のサブドメインが親ドメイン向けに
 * op_sess を書き込んで店主のセッションを固定する (session fixation) 経路を構造的に塞ぐ。
 *
 * dev (NODE_ENV!=='production') は http://localhost で prefix 付き cookie がブラウザに
 * 拒否されるため素の名前へ落とす。判定を NODE_ENV 一本に閉じているのは、cookies() しか
 * 持たない reader (_session.ts / logout) と writer (verify) が**必ず同じ名前**に合意する
 * 必要があるため — 本番で素の名前も読みに行けば上で塞いだ注入経路がそのまま開く。
 * 「本番かつ非 https」は cookie 自体が secure:true で成立しない構成なので分岐を増やさない。
 */
export function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? `__Host-${SESSION_COOKIE_BASE}`
    : SESSION_COOKIE_BASE;
}
/** verifySiweLogin で許容する最大有効期間 (issued→exp の差)。正規クライアントは 10 分以内。 */
const MAX_SIWE_VALIDITY_MS = 15 * 60 * 1000;
/** セッション有効期間 (KV TTL と cookie maxAge を揃える)。 */
export const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 日
/** nonce 有効期間 (署名までの猶予)。 */
export const NONCE_TTL_SEC = 600; // 10 分

export function sessionKey(token: string): string {
  return `siwe:sess:${token}`;
}

export function nonceKey(nonce: string): string {
  return `siwe:nonce:${nonce}`;
}

// SIWE の domain 束縛は phishing replay 防止のため **サーバ制御の許可リスト**で判定する
// (リクエストの Host ヘッダは攻撃者が偽装できるので絶対に comparand にしない)。
// canonical 本番 host (lib/legal) + 明示 env (SIWE_ALLOWED_DOMAINS) + 開発時のみ localhost。
export function allowedSiweDomains(): string[] {
  const fromEnv = (process.env.SIWE_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const canonical = new URL(LEGAL_ENTITY.siteUrl).host;
  return [canonical, ...fromEnv];
}

export function isAllowedSiweDomain(domain: string): boolean {
  if (allowedSiweDomains().includes(domain)) return true;
  // 開発時のみ localhost / 127.0.0.1 (任意 port) を許可。本番では不可。
  if (process.env.NODE_ENV !== 'production') {
    return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain);
  }
  return false;
}

/** KV セッション値の JSON 形。address は保存時に checksum 化済。 */
export type SessionRecord = { address: Address };

/** 暗号学的乱数 32 bytes の 64hex (Web Crypto・runtime 非依存)。 */
function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 暗号学的乱数の 64hex セッショントークン。 */
export function newSessionToken(): string {
  return randomHex32();
}

/** SIWE nonce 用の CSPRNG 64hex。EIP-4361 の英数字 8 文字以上を満たす。 */
export function newSiweNonce(): string {
  return randomHex32();
}

/** KV から読んだ生 JSON を SessionRecord に。壊れていれば null。 */
export function parseSessionRecord(raw: string | null | undefined): SessionRecord | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const addr = (obj as { address?: unknown }).address;
  if (typeof addr !== 'string' || !isAddress(addr)) return null;
  return { address: getAddress(addr) };
}

export type SiweVerifyResult =
  | { ok: true; token: string; address: Address }
  | { ok: false; status: number; error: string };

export type SiweVerifyDeps = {
  /** chainId が当アプリ対応チェーンか。 */
  isSupportedChainId: (id: number) => boolean;
  /** message の domain がサーバ制御の許可リストに含まれるか (Host ヘッダ非依存)。 */
  isAllowedDomain: (domain: string) => boolean;
  /** 署名検証 (route 側で viem verifySiweMessage を注入)。 */
  verify: (p: {
    message: string;
    signature: Hex;
    address: Address;
    domain: string;
    nonce: string;
    chainId: number;
  }) => Promise<boolean>;
  /** nonce を atomic に消費 (存在し消せたら true・二重/期限切れは false)。 */
  consumeNonce: (nonce: string) => Promise<boolean>;
  /** セッションを作成しトークンを返す。 */
  createSession: (address: Address) => Promise<string>;
};

/**
 * SIWE ログインの検証フロー (純粋コア)。
 * 順序: 構造検証 (400) → domain 一致 → uri 束縛 → 署名検証 → nonce 消費 → セッション発行。
 * 署名検証を nonce 消費より前に置くのは、署名失敗で nonce を焼かない (再送可能) ため。
 * replay は「有効な (message,signature) の 2 回目」で consumeNonce が false になり弾かれる。
 */
export async function verifySiweLogin(
  params: { message: unknown; signature: unknown },
  deps: SiweVerifyDeps,
): Promise<SiweVerifyResult> {
  const { message, signature } = params;
  if (typeof message !== 'string' || message.length === 0) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  if (typeof signature !== 'string' || !isHex(signature)) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }

  const fields = parseSiweMessage(message);
  const { address, nonce, chainId, domain } = fields;
  if (
    !address ||
    !isAddress(address) ||
    !nonce ||
    typeof chainId !== 'number' ||
    !domain
  ) {
    return { ok: false, status: 400, error: 'invalid_message' };
  }
  if (!deps.isSupportedChainId(chainId)) {
    return { ok: false, status: 400, error: 'unsupported_chain' };
  }
  if (!deps.isAllowedDomain(domain)) {
    return { ok: false, status: 401, error: 'domain_mismatch' };
  }

  // uri 束縛 (defense-in-depth): EIP-4361 の uri は「どのリソースへサインインするか」を宣言する
  // 必須フィールドだが、これまで未検証だった。domain だけ正しく uri を攻撃者オリジンにした
  // message を署名させ、その署名を別サイトで再利用する余地を塞ぐ。判定は domain と同じ
  // サーバ制御の許可リスト (Host ヘッダ非依存)。scheme は https 必須 —
  // 許可 host が localhost/127.0.0.1 (開発) のときだけ http も許す。
  const { uri } = fields;
  if (!uri) {
    return { ok: false, status: 400, error: 'invalid_message' };
  }
  let uriUrl: URL;
  try {
    uriUrl = new URL(uri);
  } catch {
    return { ok: false, status: 400, error: 'invalid_message' };
  }
  if (!deps.isAllowedDomain(uriUrl.host)) {
    return { ok: false, status: 400, error: 'invalid_message' };
  }
  const uriIsLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(uriUrl.host);
  if (uriUrl.protocol !== 'https:' && !(uriUrl.protocol === 'http:' && uriIsLocal)) {
    return { ok: false, status: 400, error: 'invalid_message' };
  }

  // 鮮度束縛 (defense-in-depth): expirationTime を必須化し issuedAt+15分以内に cap。
  // viem は expirationTime が present のときしか判定せず、省略した message が nonce TTL
  // だけを境界に受理されてしまう。正規クライアント (useSiweSession) は常に issuedAt と
  // 10 分 exp を付ける。
  const { issuedAt, expirationTime } = fields;
  if (!issuedAt || !expirationTime) {
    return { ok: false, status: 400, error: 'invalid_message' };
  }
  const validityMs = expirationTime.getTime() - issuedAt.getTime();
  if (validityMs <= 0 || validityMs > MAX_SIWE_VALIDITY_MS) {
    return { ok: false, status: 400, error: 'invalid_message' };
  }

  const checksum = getAddress(address);
  const valid = await deps.verify({
    message,
    signature,
    address: checksum,
    domain,
    nonce,
    chainId,
  });
  if (!valid) {
    return { ok: false, status: 401, error: 'invalid_signature' };
  }

  const fresh = await deps.consumeNonce(nonce);
  if (!fresh) {
    return { ok: false, status: 401, error: 'nonce_invalid' };
  }

  const token = await deps.createSession(checksum);
  return { ok: true, token, address: checksum };
}
