import 'server-only';

// 「お店の端末で送る」の受け渡し (plans/store-gas-wallet.md P2)。お客様のスマホが作った署名を、お店の端末へ
// 短時間 (最長 10 分) だけ渡す。OpenPay は署名を検証して預かるだけで、送信もガスもしない。
//
// 安全の要点:
//   - 署名は「既存 forwarder 経由で、このセッションの店へ、この金額 + 1 wei」にしか使えない (検証で固定)。
//     第三者が読んで送っても店に入るだけ。
//   - 1 セッション 1 枠: 最初の有効な署名で固定 (SET NX)。同じ署名 (from・nonce) の再送は冪等。枠は解放しない
//     (解放すると、まだ生きている 1 枚目と 2 枚目が両方使われる二重払いの種になる)。
//   - セッション id とお店の端末の読み取りトークンは、サーバの秘密値 (IP_HASH_SECRET を用途で分けた HMAC) で
//     作る。偽の id・トークンは KV に触れる前に弾く (任意の id で KV の読み取りを消費させない)。
//   - 端末だけが読める項目 (署名) はトークン (ヘッダ) で守る。トークンは保存しない (id から導き直して照合)。
//   - KV 障害は fail-closed (受け渡しを止める・偽の成功を返さない)。
//   - お店の端末は使わなくなったセッション (QR の出し直し・別の会計) を締め切れる。締め切りは署名の枠に
//     「締め切り」の印を置く (SET NX GET) ので、お客様の署名と同時でもどちらか一方だけが勝つ。
//     署名が先なら端末はそれを受け取って送る・締め切りが先ならお客様には「期限切れ」(410) を返す。

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import {
  verifyForwarderSettle,
  type ForwarderVerifyDeps,
} from '@/lib/relay/forwarderRecover';
import { buildForwarderNonce, type ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import {
  STORE_DEVICE_FEE_WEI,
  STORE_DEVICE_MAX_VALIDITY_SEC,
  STORE_DEVICE_MIN_CLAIM_REMAINING_SEC,
  STORE_HANDOFF_TOKEN_PATTERN,
  STORE_HANDOFF_TTL_SEC,
  isStoreDeviceAmount,
  isStoreHandoffId,
} from '@/lib/storeDevicePayment';

export type HandoffSession = {
  v: 1;
  chainId: number;
  merchant: Address;
  /** 請求額 (wei の 10 進文字列)。お客様はこれ + 1 wei を払う。 */
  amount: string;
  createdAt: number;
  expiresAt: number;
};

export type HandoffAuth = {
  v: 1;
  from: Address;
  merchantValue: string;
  feeValue: string;
  validAfter: string;
  validBefore: string;
  intentSalt: Hex;
  signature: Hex;
  nonce: Hex;
  at: number;
};

/** 署名の枠に置く「締め切り」の印 (お店の端末が使わなくなったセッション)。 */
export type HandoffClosedMark = { v: 1; closed: true; at: number };

export type HandoffSnapshot = {
  session: HandoffSession | null;
  auth: HandoffAuth | null;
  txHash: Hex | null;
  /** 署名の枠に締め切りの印がある (以後の署名は受けない)。 */
  closed: boolean;
};

/** KV の薄い抽象 (テストで差し替える)。失敗は null / false で返し、呼び出し側が fail-closed にする。 */
export type HandoffStore = {
  /** 新しいセッションを置く (同じ id が既にあれば false)。 */
  putSession(id: string, session: HandoffSession, ttlSec: number): Promise<boolean | null>;
  /** セッション・署名・tx をまとめて読む (1 往復)。KV 障害は null。 */
  read(id: string): Promise<HandoffSnapshot | null>;
  /**
   * 署名の枠を取る。空いていれば置いて existing=null、埋まっていれば既存を返す。
   * 締め切りの印があれば closed=true (置けていない)。KV 障害は null。
   */
  claimAuth(
    id: string,
    auth: HandoffAuth,
    ttlSec: number,
  ): Promise<{ existing: HandoffAuth | null; closed?: true } | null>;
  /**
   * 署名の枠に締め切りの印を置く。空いていれば置いて closed=true、締め切り済みも closed=true、
   * 署名が先に入っていれば closed=false でその署名を返す。KV 障害は null。
   */
  closeSlot(
    id: string,
    mark: HandoffClosedMark,
    ttlSec: number,
  ): Promise<{ closed: true } | { closed: false; existing: HandoffAuth } | null>;
  /** 端末が送った tx を記録し、記録されている hash (先に別の hash があればそれ) を返す。KV 障害は null。 */
  putTx(id: string, txHash: Hex, ttlSec: number): Promise<Hex | null>;
};

export type HandoffDeps = ForwarderVerifyDeps & {
  store: HandoffStore;
  /** この環境の対象チェーン (mainnet = Polygon・testnet = Amoy)。 */
  expectedChainId: number;
  readAuthorizationUsed: (
    chainId: number,
    token: Address,
    from: Address,
    nonce: Hex,
  ) => Promise<boolean>;
  /** HMAC (hex)。秘密値が無い・短いときは null (受け渡しを止める)。 */
  mac: (message: string) => string | null;
  randomBytes: (n: number) => Buffer;
};

export type HandoffError =
  | 'invalid_body'
  | 'unsupported_chain'
  | 'invalid_merchant'
  | 'merchant_is_fee_receiver'
  | 'merchant_is_forwarder'
  | 'invalid_amount'
  | 'not_found'
  | 'expired'
  | 'merchant_mismatch'
  | 'amount_mismatch'
  | 'slot_taken'
  | 'authorization_used'
  | 'bad_token'
  | 'invalid_tx'
  | 'handoff_unavailable'
  | (string & {}); // verifyForwarderSettle の理由コード (fee_value_mismatch・insufficient_balance 等)

export type HandoffFailure = { ok: false; status: number; error: HandoffError };

const KEY_PREFIX = 'storehandoff:v1:';
export const handoffSessionKey = (id: string) => `${KEY_PREFIX}${id}`;
export const handoffAuthKey = (id: string) => `${KEY_PREFIX}${id}:auth`;
export const handoffTxKey = (id: string) => `${KEY_PREFIX}${id}:tx`;

function fail(status: number, error: HandoffError): HandoffFailure {
  return { ok: false, status, error };
}

// id = base64url(乱数 10 byte ‖ HMAC 先頭 6 byte) = 22 文字。偽の id は KV に触れる前に弾ける。
const ID_RANDOM_BYTES = 10;
const ID_TAG_BYTES = 6;

function idTag(random: Buffer, mac: HandoffDeps['mac']): Buffer | null {
  const h = mac(`store-handoff-id:v1:${random.toString('hex')}`);
  return h ? Buffer.from(h, 'hex').subarray(0, ID_TAG_BYTES) : null;
}

export function newHandoffId(deps: Pick<HandoffDeps, 'mac' | 'randomBytes'>): string | null {
  const random = deps.randomBytes(ID_RANDOM_BYTES);
  const tag = idTag(random, deps.mac);
  return tag ? Buffer.concat([random, tag]).toString('base64url') : null;
}

/** 形 (22 文字) と HMAC の両方を満たす id か (KV を読む前の判定)。 */
export function isGenuineHandoffId(id: string, mac: HandoffDeps['mac']): boolean {
  if (!isStoreHandoffId(id)) return false;
  const raw = Buffer.from(id, 'base64url');
  if (raw.length !== ID_RANDOM_BYTES + ID_TAG_BYTES) return false;
  const expected = idTag(raw.subarray(0, ID_RANDOM_BYTES), mac);
  const actual = raw.subarray(ID_RANDOM_BYTES);
  return expected !== null && expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** お店の端末の読み取りトークン (id から導く・保存しない)。 */
export function handoffTokenFor(id: string, mac: HandoffDeps['mac']): string | null {
  return mac(`store-handoff-token:v1:${id}`);
}

function tokenMatches(token: string | null, id: string, mac: HandoffDeps['mac']): boolean {
  if (!token || !STORE_HANDOFF_TOKEN_PATTERN.test(token)) return false;
  const expected = handoffTokenFor(id, mac);
  if (!expected) return false;
  const a = Buffer.from(token, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseWei(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) return null;
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// 1. セッションを作る (お店の端末)
// ---------------------------------------------------------------------------

export type CreatedHandoff = { ok: true; id: string; token: string; expiresAt: number };

export async function createHandoffSession(
  body: Record<string, unknown>,
  deps: HandoffDeps,
): Promise<CreatedHandoff | HandoffFailure> {
  const chainId = body.chainId;
  if (typeof chainId !== 'number' || chainId !== deps.expectedChainId) {
    return fail(400, 'unsupported_chain');
  }
  const forwarder = deps.forwarderFor(chainId);
  const feeReceiver = deps.feeReceiverFor(chainId);
  if (!forwarder || !feeReceiver || !deps.jpycAddressFor(chainId)) {
    return fail(400, 'unsupported_chain');
  }
  if (typeof body.merchant !== 'string' || !isAddress(body.merchant, { strict: false })) {
    return fail(400, 'invalid_merchant');
  }
  const merchant = getAddress(body.merchant);
  if (merchant === '0x0000000000000000000000000000000000000000') {
    return fail(400, 'invalid_merchant');
  }
  // forwarder は merchant == feeReceiver / forwarder を revert する。会計の前に止める
  // (会社の @handle = FEE_RECEIVER の店はこの経路を使えない)。
  if (merchant === getAddress(feeReceiver)) return fail(400, 'merchant_is_fee_receiver');
  if (merchant === getAddress(forwarder)) return fail(400, 'merchant_is_forwarder');
  const amount = parseWei(body.amount);
  if (amount === null || !isStoreDeviceAmount(amount, deps.maxValue - STORE_DEVICE_FEE_WEI)) {
    return fail(400, 'invalid_amount');
  }

  // 秘密値が無ければ id もトークンも作れない → 受け渡しを止める (偽の成功を出さない)。
  const id = newHandoffId(deps);
  const token = id ? handoffTokenFor(id, deps.mac) : null;
  if (!id || !token) return fail(503, 'handoff_unavailable');
  const now = deps.nowSec();
  const session: HandoffSession = {
    v: 1,
    chainId,
    merchant,
    amount: amount.toString(),
    createdAt: now,
    expiresAt: now + STORE_HANDOFF_TTL_SEC,
  };
  const put = await deps.store.putSession(id, session, STORE_HANDOFF_TTL_SEC);
  // KV 障害・id 衝突 (乱数 10 byte = 80 bit でまず起きない) は作れなかったとして返す (偽の成功を出さない)。
  if (put !== true) return fail(503, 'handoff_unavailable');
  return { ok: true, id, token, expiresAt: session.expiresAt };
}

// ---------------------------------------------------------------------------
// 2. 署名を受け取る (お客様のスマホ)
// ---------------------------------------------------------------------------

export type AcceptedAuth = { ok: true; idempotent: boolean; nonce: Hex };

export async function submitHandoffAuth(
  id: string,
  body: Record<string, unknown>,
  deps: HandoffDeps,
): Promise<AcceptedAuth | HandoffFailure> {
  if (!isGenuineHandoffId(id, deps.mac)) return fail(404, 'not_found');
  // 形の検証は KV を読む前に (壊れた本文で KV の読み取りを消費させない)。
  const merchantValue = parseWei(body.merchantValue);
  const feeValue = parseWei(body.feeValue);
  const validAfter = parseWei(body.validAfter);
  const validBefore = parseWei(body.validBefore);
  if (
    typeof body.from !== 'string' ||
    !isAddress(body.from, { strict: false }) ||
    merchantValue === null ||
    feeValue === null ||
    validAfter === null ||
    validBefore === null ||
    typeof body.intentSalt !== 'string' ||
    !isHex(body.intentSalt) ||
    body.intentSalt.length !== 66 ||
    typeof body.signature !== 'string' ||
    !isHex(body.signature) ||
    body.signature.length !== 132
  ) {
    return fail(400, 'invalid_body');
  }
  const snap = await deps.store.read(id);
  if (snap === null) return fail(503, 'handoff_unavailable');
  const session = snap.session;
  if (!session) return fail(404, 'not_found');
  // お店の端末が締め切ったセッション (QR の出し直し等) は期限切れと同じに扱う (お客様は出し直しを頼む)。
  if (snap.closed) return fail(410, 'expired');

  if (typeof body.merchant === 'string' && body.merchant.toLowerCase() !== session.merchant.toLowerCase()) {
    return fail(400, 'merchant_mismatch');
  }
  if (merchantValue !== BigInt(session.amount)) return fail(400, 'amount_mismatch');

  const feeReceiver = deps.feeReceiverFor(session.chainId);
  const forwarder = deps.forwarderFor(session.chainId);
  if (!feeReceiver || !forwarder) return fail(400, 'unsupported_chain');
  const params: ForwarderSettleParams = {
    from: getAddress(body.from),
    merchant: session.merchant,
    merchantValue,
    feeReceiver,
    feeValue,
    validAfter,
    validBefore,
    intentSalt: body.intentSalt as Hex,
  };

  // 既に預かっている署名と同じなら、RPC より先に冪等に受ける (応答を受け取れずに再送したお客様が、
  // 端末の送信後・期限後・RPC 障害時に「失敗」を見ないように)。別の署名は枠が埋まっている。
  if (snap.auth) {
    const nonce = buildForwarderNonce(params, session.chainId, forwarder);
    return snap.auth.nonce.toLowerCase() === nonce.toLowerCase() &&
      snap.auth.signature.toLowerCase() === (body.signature as string).toLowerCase()
      ? { ok: true, idempotent: true, nonce }
      : fail(409, 'slot_taken');
  }
  if (session.expiresAt <= deps.nowSec()) return fail(410, 'expired');
  // 署名の期限はセッションの期限以内 (預かりが先に消えて署名だけが生き残らないように)。
  if (validBefore > BigInt(session.expiresAt)) return fail(400, 'validity_beyond_session');
  // 端末が受け取って送れるだけの残り時間がない署名で枠を占有させない。
  if (validBefore < BigInt(deps.nowSec() + STORE_DEVICE_MIN_CLAIM_REMAINING_SEC)) {
    return fail(400, 'validity_too_short');
  }
  const verified = await verifyForwarderSettle(
    { chainId: session.chainId, params, signature: body.signature as Hex, rateLimitKeys: [] },
    { ...deps, expectedFeeValue: STORE_DEVICE_FEE_WEI, maxValidityWindowSec: STORE_DEVICE_MAX_VALIDITY_SEC },
  );
  if (!verified.ok) {
    const r = verified.result;
    return fail(r.kind === 'rejected' ? r.httpStatus : 400, r.kind === 'rejected' ? r.reason : 'invalid_body');
  }

  let used: boolean;
  try {
    used = await deps.readAuthorizationUsed(session.chainId, verified.jpyc, params.from, verified.nonce);
  } catch {
    return fail(503, 'handoff_unavailable');
  }
  if (used) return fail(409, 'authorization_used');

  const auth: HandoffAuth = {
    v: 1,
    from: params.from,
    merchantValue: merchantValue.toString(),
    feeValue: feeValue.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    intentSalt: params.intentSalt,
    signature: body.signature as Hex,
    nonce: verified.nonce,
    at: deps.nowSec(),
  };
  // 検証 (RPC) の間にセッションが切れていたら預からない (孤立した署名を置いて成功を返さない)。
  const ttl = session.expiresAt - deps.nowSec();
  if (ttl <= 0) return fail(410, 'expired');
  const claimed = await deps.store.claimAuth(id, auth, ttl);
  if (claimed === null) return fail(503, 'handoff_unavailable');
  // 検証 (RPC) の間にお店の端末が締め切った → 預かっていない。
  if (claimed.closed) return fail(410, 'expired');
  if (claimed.existing) {
    // 同じ署名の再送 (応答を受け取れなかった等) は冪等に受ける。別の署名は枠が埋まっている。
    return claimed.existing.nonce.toLowerCase() === verified.nonce.toLowerCase()
      ? { ok: true, idempotent: true, nonce: verified.nonce }
      : fail(409, 'slot_taken');
  }
  return { ok: true, idempotent: false, nonce: verified.nonce };
}

// ---------------------------------------------------------------------------
// 3. 状態を読む (お客様: 公開項目だけ / お店の端末: トークンで署名まで)
// ---------------------------------------------------------------------------

export type HandoffPublicView = {
  ok: true;
  state: 'open' | 'signed' | 'sent' | 'closed';
  expiresAt: number;
  txHash: Hex | null;
};

export type HandoffDeviceView = HandoffPublicView & {
  chainId: number;
  merchant: Address;
  amount: string;
  auth: Omit<HandoffAuth, 'v' | 'at'> | null;
};

export async function readHandoff(
  id: string,
  token: string | null,
  deps: Pick<HandoffDeps, 'store' | 'nowSec' | 'mac'>,
): Promise<HandoffPublicView | HandoffDeviceView | HandoffFailure> {
  if (!isGenuineHandoffId(id, deps.mac)) return fail(404, 'not_found');
  // トークン付きの読み取りは KV に触れる前に照合する。
  if (token !== null && !tokenMatches(token, id, deps.mac)) return fail(403, 'bad_token');
  const snap = await deps.store.read(id);
  if (snap === null) return fail(503, 'handoff_unavailable');
  const session = snap.session;
  if (!session) return fail(404, 'not_found');
  const view: HandoffPublicView = {
    ok: true,
    state: snap.txHash ? 'sent' : snap.auth ? 'signed' : snap.closed ? 'closed' : 'open',
    expiresAt: session.expiresAt,
    txHash: snap.txHash,
  };
  if (token === null) return view;
  return {
    ...view,
    chainId: session.chainId,
    merchant: session.merchant,
    amount: session.amount,
    auth: snap.auth ? deviceAuth(snap.auth) : null,
  };
}

function deviceAuth(auth: HandoffAuth): Omit<HandoffAuth, 'v' | 'at'> {
  return {
    from: auth.from,
    merchantValue: auth.merchantValue,
    feeValue: auth.feeValue,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
    intentSalt: auth.intentSalt,
    signature: auth.signature,
    nonce: auth.nonce,
  };
}

// ---------------------------------------------------------------------------
// 4. 端末が送った tx を記録する (お客様の画面の完了表示を早めるための付帯情報)
// ---------------------------------------------------------------------------

export async function recordHandoffTx(
  id: string,
  token: string | null,
  body: Record<string, unknown>,
  deps: Pick<HandoffDeps, 'store' | 'nowSec' | 'mac'>,
): Promise<{ ok: true; txHash: Hex } | HandoffFailure> {
  if (!isGenuineHandoffId(id, deps.mac)) return fail(404, 'not_found');
  if (!tokenMatches(token, id, deps.mac)) return fail(403, 'bad_token');
  const txHash = body.txHash;
  if (typeof txHash !== 'string' || !isHex(txHash) || txHash.length !== 66) {
    return fail(400, 'invalid_tx');
  }
  const snap = await deps.store.read(id);
  if (snap === null) return fail(503, 'handoff_unavailable');
  const session = snap.session;
  if (!session) return fail(404, 'not_found');
  if (!snap.auth) return fail(409, 'not_signed');
  const ttl = Math.max(1, session.expiresAt - deps.nowSec());
  // 記録は最初の 1 件だけ (NX)。別の hash が先にあればそれを返す (端末が別の送信に気づけるように)。
  const recorded = await deps.store.putTx(id, txHash as Hex, ttl);
  return recorded ? { ok: true, txHash: recorded } : fail(503, 'handoff_unavailable');
}

// ---------------------------------------------------------------------------
// 5. 締め切る (お店の端末が使わなくなったセッション・QR の出し直し / 別の会計)
// ---------------------------------------------------------------------------

export type ClosedHandoff =
  | { ok: true; closed: true }
  // 締め切る前に署名が入っていた → 端末はこれを受け取って送る (お客様は署名済みで待っている)
  | { ok: true; closed: false; auth: Omit<HandoffAuth, 'v' | 'at'>; txHash: Hex | null };

export async function closeHandoff(
  id: string,
  token: string | null,
  deps: Pick<HandoffDeps, 'store' | 'nowSec' | 'mac'>,
): Promise<ClosedHandoff | HandoffFailure> {
  if (!isGenuineHandoffId(id, deps.mac)) return fail(404, 'not_found');
  if (!tokenMatches(token, id, deps.mac)) return fail(403, 'bad_token');
  const snap = await deps.store.read(id);
  if (snap === null) return fail(503, 'handoff_unavailable');
  const session = snap.session;
  if (!session) return fail(404, 'not_found');
  if (snap.auth) return { ok: true, closed: false, auth: deviceAuth(snap.auth), txHash: snap.txHash };
  if (snap.closed) return { ok: true, closed: true };
  const ttl = Math.max(1, session.expiresAt - deps.nowSec());
  const r = await deps.store.closeSlot(id, { v: 1, closed: true, at: deps.nowSec() }, ttl);
  if (r === null) return fail(503, 'handoff_unavailable');
  return r.closed
    ? { ok: true, closed: true }
    : { ok: true, closed: false, auth: deviceAuth(r.existing), txHash: snap.txHash };
}
