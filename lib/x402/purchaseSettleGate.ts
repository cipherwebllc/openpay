import 'server-only';

// creator-store v4 実装契約 A「全 settle 入口 fail-closed」の choke point。
//
// hosted PurchaseIntent の intentSalt は server 発行で、署名の nonce にコミットされる。
// その署名が hosted paid route の CAS (quoted→signed→settling) を経ずに、汎用の
// /api/facilitator/settle や recover relay (/api/relay/jpyc) から直接 broadcast されると、
// 「支払いだけ成立して entitlement 遷移が始まらない」状態を作れてしまう
// (reconciler で最終的に収束はするが、fail-closed 契約と応答の一貫性が壊れる)。
//
// この gate は settle 入口が broadcast する直前に呼び、intentSalt が hosted intent として
// 存在する場合は「hosted route が settling へ CAS した本人の再送」だけを通す。
// store intent が存在しない salt (recover / first-party の client 生成 salt) は 1 回の
// KV GET だけで素通しになり、既存経路の挙動は変わらない。
//
// 依存を kv / forwarderIntent / paymentRedelivery に限定し、purchaseIntent 本体は import
// しない: あちらは chains / hostedStore / tokens を module-load で引き、settle 入口
// (relay route) の依存 graph を肥大させる。ここで読むのは gate 判定に必要な最小 field のみで、
// record 全体の schema 検証は hosted route / reconciler 側 (parsePurchaseIntent) の責務。
// key 形式・状態名の drift は tests/lib/x402/purchaseSettleGate.test.ts が実 purchaseIntent
// と突き合わせて固定する。
//
// ⚠️ settleViaForwarder を呼ぶ入口を新設したら、この gate も必ず配線すること
// (現在の入口: app/api/facilitator/settle・app/api/relay/jpyc)。

import { isKvConfigured, kvGet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { paymentSignatureFingerprint } from '@/lib/x402/paymentRedelivery';

export type HostedSettleAdmission = 'allow' | 'denied' | 'storage';

const INTENT_SALT_RE = /^0x[0-9a-f]{64}$/;
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** purchaseIntent.purchaseIntentKey と同一 (drift はテストで実物と突き合わせ固定)。 */
export function hostedSettleGateIntentKey(intentSalt: string): string {
  return `store:intent:${intentSalt.toLowerCase()}`;
}

type GateRecord = {
  state: string;
  chainId: number;
  forwarder: `0x${string}`;
  nonce: string | null;
  signatureFingerprint: string | null;
};

function parseGateRecord(raw: string): GateRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.state !== 'string' ||
    typeof record.chainId !== 'number' ||
    !Number.isSafeInteger(record.chainId) ||
    record.chainId <= 0 ||
    typeof record.forwarder !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(record.forwarder)
  ) {
    return null;
  }
  const claim =
    typeof record.claim === 'object' &&
    record.claim !== null &&
    !Array.isArray(record.claim)
      ? (record.claim as Record<string, unknown>)
      : null;
  const nonce =
    claim && typeof claim.nonce === 'string' && HEX32_RE.test(claim.nonce)
      ? claim.nonce.toLowerCase()
      : null;
  const signatureFingerprint =
    claim &&
    typeof claim.signatureFingerprint === 'string' &&
    FINGERPRINT_RE.test(claim.signatureFingerprint)
      ? claim.signatureFingerprint
      : null;
  return {
    state: record.state,
    chainId: record.chainId,
    forwarder: record.forwarder as `0x${string}`,
    nonce,
    signatureFingerprint,
  };
}

/**
 * hosted intent に紐づく settle broadcast の可否。
 * - 'allow'   = hosted intent ではない、または settling/settled の claim と署名まで完全一致
 * - 'denied'  = hosted intent だが hosted route の CAS を経ていない (または別署名/別 params)
 * - 'storage' = KV 障害・record 破損。fail-open にすると迂回がそのまま通るため呼出側は 503。
 */
export async function checkHostedIntentSettleAdmission(input: {
  params: ForwarderSettleParams;
  chainId: number;
  signature: unknown;
}): Promise<HostedSettleAdmission> {
  const salt = input.params.intentSalt.toLowerCase();
  if (!INTENT_SALT_RE.test(salt)) {
    // 形式外の salt は forwarder 側の検証に委ねる (hosted intent ではあり得ない)。
    return 'allow';
  }
  if (!isKvConfigured()) {
    // KV 全体が未構成の環境 (ローカル testnet 等) では hosted intent 自体が作成不能。
    // 存在し得ない record の照合で既存 relay を止めない (何の波及を断つか: dev/testnet の
    // KV なし運用への回帰)。KV 構成済みで read が失敗した場合は下で fail-closed。
    return 'allow';
  }
  const read = await kvGet(hostedSettleGateIntentKey(salt));
  if (!read.ok) return 'storage';
  if (read.value === null) return 'allow';
  const record = parseGateRecord(read.value);
  if (!record) {
    // hosted intent の key に破損 record: 素通しすると CAS 迂回になるため fail-closed。
    return 'storage';
  }
  if (record.state === 'settling' || record.state === 'settled') {
    const fingerprint = paymentSignatureFingerprint(input.signature);
    const nonce = buildForwarderNonce(
      input.params,
      record.chainId,
      record.forwarder,
    ).toLowerCase();
    const matches =
      fingerprint !== null &&
      record.nonce !== null &&
      record.signatureFingerprint !== null &&
      input.chainId === record.chainId &&
      nonce === record.nonce &&
      fingerprint === record.signatureFingerprint;
    if (matches) {
      // settling = hosted route が CAS 済みの本人 broadcast。
      // settled = 完全一致の再送で、下流の冪等 cache が既存応答を返すだけ。
      return 'allow';
    }
  }
  logger.warn('creator_store.settle_gate_denied', {
    intentSalt: salt,
    state: record.state,
  });
  return 'denied';
}
