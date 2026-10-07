import 'server-only';

// 「お店の端末で送る」の受け渡し (plans/store-gas-wallet.md P2)。お客様のスマホが作った署名を、お店の端末へ
// 短時間 (最長 10 分) だけ渡す。OpenPay は署名を検証して預かるだけで、送信もガスもしない。
//
// 安全の要点:
//   - 署名は「既存 forwarder 経由で、このセッションの店へ、この金額 + 1 wei」にしか使えない (検証で固定)。
//     第三者が読んで送っても店に入るだけ。
//   - 1 セッション 1 枠: 最初の有効な署名で固定 (SET NX)。同じ署名 (from・nonce) の再送は冪等。枠は解放しない
//     (解放すると、まだ生きている 1 枚目と 2 枚目が両方使われる二重払いの種になる)。
//   - 端末だけが読める項目 (署名) は読み取りトークン (ヘッダ) で守る。トークンは sha256 だけを保存する。
//   - KV 障害は fail-closed (受け渡しを止める・偽の成功を返さない)。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import {
  verifyForwarderSettle,
  type ForwarderVerifyDeps,
} from '@/lib/relay/forwarderRecover';
import type { ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import {
  STORE_DEVICE_FEE_WEI,
  STORE_DEVICE_MAX_VALIDITY_SEC,
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
  tokenHash: string;
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

export type HandoffSnapshot = {
  session: HandoffSession | null;
  auth: HandoffAuth | null;
  txHash: Hex | null;
};

/** KV の薄い抽象 (テストで差し替える)。失敗は null / false で返し、呼び出し側が fail-closed にする。 */
export type HandoffStore = {
  /** 新しいセッションを置く (同じ id が既にあれば false)。 */
  putSession(id: string, session: HandoffSession, ttlSec: number): Promise<boolean | null>;
  /** セッション・署名・tx をまとめて読む (1 往復)。KV 障害は null。 */
  read(id: string): Promise<HandoffSnapshot | null>;
  /** 署名の枠を取る。空いていれば置いて existing=null、埋まっていれば既存を返す。KV 障害は null。 */
  claimAuth(
    id: string,
    auth: HandoffAuth,
    ttlSec: number,
  ): Promise<{ existing: HandoffAuth | null } | null>;
  /** 端末が送った tx を記録する。KV 障害は false。 */
  putTx(id: string, txHash: Hex, ttlSec: number): Promise<boolean>;
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
  randomId: () => string;
  randomToken: () => string;
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

export function hashHandoffToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenMatches(token: string | null, tokenHash: string): boolean {
  if (!token || !STORE_HANDOFF_TOKEN_PATTERN.test(token)) return false;
  const a = Buffer.from(hashHandoffToken(token), 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newHandoffId(): string {
  return randomBytes(16).toString('base64url');
}

export function newHandoffToken(): string {
  return randomBytes(32).toString('hex');
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

  const id = deps.randomId();
  const token = deps.randomToken();
  const now = deps.nowSec();
  const session: HandoffSession = {
    v: 1,
    chainId,
    merchant,
    amount: amount.toString(),
    tokenHash: hashHandoffToken(token),
    createdAt: now,
    expiresAt: now + STORE_HANDOFF_TTL_SEC,
  };
  const put = await deps.store.putSession(id, session, STORE_HANDOFF_TTL_SEC);
  // KV 障害・id 衝突 (16 byte 乱数でまず起きない) は作れなかったとして返す (偽の成功を出さない)。
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
  if (!isStoreHandoffId(id)) return fail(404, 'not_found');
  const snap = await deps.store.read(id);
  if (snap === null) return fail(503, 'handoff_unavailable');
  const session = snap.session;
  if (!session) return fail(404, 'not_found');
  if (session.expiresAt <= deps.nowSec()) return fail(410, 'expired');

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
  if (typeof body.merchant === 'string' && body.merchant.toLowerCase() !== session.merchant.toLowerCase()) {
    return fail(400, 'merchant_mismatch');
  }
  if (merchantValue !== BigInt(session.amount)) return fail(400, 'amount_mismatch');

  const feeReceiver = deps.feeReceiverFor(session.chainId);
  if (!feeReceiver) return fail(400, 'unsupported_chain');
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
  const ttl = Math.max(1, session.expiresAt - deps.nowSec());
  const claimed = await deps.store.claimAuth(id, auth, ttl);
  if (claimed === null) return fail(503, 'handoff_unavailable');
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
  state: 'open' | 'signed' | 'sent';
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
  deps: Pick<HandoffDeps, 'store' | 'nowSec'>,
): Promise<HandoffPublicView | HandoffDeviceView | HandoffFailure> {
  if (!isStoreHandoffId(id)) return fail(404, 'not_found');
  const snap = await deps.store.read(id);
  if (snap === null) return fail(503, 'handoff_unavailable');
  const session = snap.session;
  if (!session) return fail(404, 'not_found');
  const view: HandoffPublicView = {
    ok: true,
    state: snap.txHash ? 'sent' : snap.auth ? 'signed' : 'open',
    expiresAt: session.expiresAt,
    txHash: snap.txHash,
  };
  if (token === null) return view;
  if (!tokenMatches(token, session.tokenHash)) return fail(403, 'bad_token');
  const auth = snap.auth;
  return {
    ...view,
    chainId: session.chainId,
    merchant: session.merchant,
    amount: session.amount,
    auth: auth
      ? {
          from: auth.from,
          merchantValue: auth.merchantValue,
          feeValue: auth.feeValue,
          validAfter: auth.validAfter,
          validBefore: auth.validBefore,
          intentSalt: auth.intentSalt,
          signature: auth.signature,
          nonce: auth.nonce,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// 4. 端末が送った tx を記録する (お客様の画面の完了表示を早めるための付帯情報)
// ---------------------------------------------------------------------------

export async function recordHandoffTx(
  id: string,
  token: string | null,
  body: Record<string, unknown>,
  deps: Pick<HandoffDeps, 'store' | 'nowSec'>,
): Promise<{ ok: true } | HandoffFailure> {
  if (!isStoreHandoffId(id)) return fail(404, 'not_found');
  const txHash = body.txHash;
  if (typeof txHash !== 'string' || !isHex(txHash) || txHash.length !== 66) {
    return fail(400, 'invalid_tx');
  }
  const snap = await deps.store.read(id);
  if (snap === null) return fail(503, 'handoff_unavailable');
  const session = snap.session;
  if (!session) return fail(404, 'not_found');
  if (!tokenMatches(token, session.tokenHash)) return fail(403, 'bad_token');
  if (!snap.auth) return fail(409, 'not_signed');
  const ttl = Math.max(1, session.expiresAt - deps.nowSec());
  const ok = await deps.store.putTx(id, txHash as Hex, ttl);
  return ok ? { ok: true } : fail(503, 'handoff_unavailable');
}
