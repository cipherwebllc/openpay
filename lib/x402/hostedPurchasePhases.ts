// Creator Store hosted 商品の buyer hook (useHostedStorePurchase) が使う純粋な応答 parser と
// phase 対応表 (R15b で hook から抽出)。React・wagmi・env に依存しない browser-safe module。
//
// session/product scope・署名済み request の保持・古い完了の破棄は hook (単一 controller) に残す。
// ここにあるのは入力だけで結果が決まる関数と、その戻り値の型だけ。
// isRecord / responseJson は hosted 購入の応答解釈のための最小限の helper で、汎用 utility ではない
// (JSON の null 本文を非 JSON と同じに扱う等の癖をそのまま持つ)。他所からは使わない。

import type { Hex } from 'viem';

export type HostedStorePurchasePhase =
  | 'idle'
  | 'loading-quote'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'indeterminate'
  | 'indeterminate-exhausted'
  | 'provisioning'
  | 'ready'
  | 'needs-support'
  | 'failed-prebroadcast'
  | 'error';

export type HostedStorePaymentStatus =
  | 'not-started'
  | 'not-executed'
  | 'unknown'
  | 'confirmed';

export type HostedStoreAccessStatus =
  | 'none'
  | 'provisioning'
  | 'ready'
  | 'needs-support';

export type HostedPurchasedContent = {
  ok: true;
  state: 'ready';
  resourceId: string;
  intentSalt: Hex;
  title: string;
  contentRevision: number;
  kind: 'url' | 'text';
  value: string;
};

export type HostedProvidedEnded = {
  ok: true;
  state: 'provided-ended';
  resourceId: string;
  intentSalt: Hex;
  title: string;
  contentRevision: number;
};

export type PurchaseStatusResponse =
  | { ok: true; state: 'pending' }
  | { ok: true; state: 'failed' }
  | { ok: true; state: 'settled'; txHash: Hex };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function purchaseStatusFrom(value: unknown): PurchaseStatusResponse {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error('purchase_status_invalid');
  }
  if (value.state === 'pending' || value.state === 'failed') {
    return { ok: true, state: value.state };
  }
  if (
    value.state === 'settled' &&
    typeof value.txHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(value.txHash)
  ) {
    return {
      ok: true,
      state: 'settled',
      txHash: value.txHash as Hex,
    };
  }
  throw new Error('purchase_status_invalid');
}

export function contentReadBackFrom(
  value: unknown,
  resourceId: string,
  intentSalt: Hex,
): HostedPurchasedContent | HostedProvidedEnded {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.resourceId !== resourceId ||
    typeof value.intentSalt !== 'string' ||
    value.intentSalt.toLowerCase() !== intentSalt.toLowerCase() ||
    typeof value.title !== 'string' ||
    !Number.isSafeInteger(value.contentRevision) ||
    (value.contentRevision as number) <= 0
  ) {
    throw new Error('store_content_invalid');
  }
  if (value.state === 'provided-ended') {
    return {
      ok: true,
      state: 'provided-ended',
      resourceId,
      intentSalt,
      title: value.title,
      contentRevision: value.contentRevision as number,
    };
  }
  if (
    value.state === 'ready' &&
    (value.kind === 'url' || value.kind === 'text') &&
    typeof value.value === 'string'
  ) {
    return {
      ok: true,
      state: 'ready',
      resourceId,
      intentSalt,
      title: value.title,
      contentRevision: value.contentRevision as number,
      kind: value.kind,
      value: value.value,
    };
  }
  throw new Error('store_content_invalid');
}

export function paymentStatusForPhase(
  phase: HostedStorePurchasePhase,
): HostedStorePaymentStatus {
  if (
    phase === 'provisioning' ||
    phase === 'ready' ||
    phase === 'needs-support'
  ) {
    return 'confirmed';
  }
  if (phase === 'submitting' || phase === 'indeterminate') return 'unknown';
  if (phase === 'indeterminate-exhausted') return 'unknown';
  if (phase === 'failed-prebroadcast' || phase === 'error') {
    return 'not-executed';
  }
  return 'not-started';
}

export function accessStatusForPhase(
  phase: HostedStorePurchasePhase,
): HostedStoreAccessStatus {
  if (phase === 'ready') return 'ready';
  if (phase === 'needs-support') return 'needs-support';
  if (phase === 'indeterminate-exhausted') return 'needs-support';
  if (
    phase === 'submitting' ||
    phase === 'indeterminate' ||
    phase === 'provisioning'
  ) {
    return 'provisioning';
  }
  return 'none';
}
