'use client';

import type { Address, Hex } from 'viem';

export const RELAY_INTENT_STORAGE_KEY = 'openpay:relay-intent:v1';
export const STANDARD_INTENT_STORAGE_KEY = 'openpay:standard-intent:v1';

export type RelayIntentMetadata = {
  chainId: number;
  from: Address;
  merchant: Address;
  merchantValue: string;
  feeValue: string;
  nonce: Hex;
  validBefore: string;
  routeKind: 'free' | 'recover';
  issuedAt: number;
};

export type StandardIntentStage = 'merchant' | 'fee' | 'fee-awaiting';

export type StandardPaymentIntentParams = {
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: bigint;
  feeReceiver: Address;
  feeAmount: bigint;
  chainId: number;
  saleAmount?: bigint;
  contextKey?: Hex;
  // レジ standard fee だけを EIP-3009 authorization + server claim 経路へ分岐する。
  registerFee?: true;
};

export type StandardIntentMetadata = {
  version: 1;
  chainId: number;
  from?: Address;
  tokenAddress: Address;
  merchant: Address;
  merchantValue: string;
  feeReceiver: Address;
  feeValue: string;
  saleValue?: string;
  stage: StandardIntentStage;
  merchantTxHash: Hex;
  feeTxHash?: Hex;
  merchantBlockNumber?: string;
  contextKey?: Hex;
  registerFee?: true;
  issuedAt: number;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^\d+$/;

function isAddressText(value: unknown): value is Address {
  return typeof value === 'string' && ADDRESS.test(value);
}

function isHex32(value: unknown): value is Hex {
  return typeof value === 'string' && HEX_32.test(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value);
}

function isIssuedAt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function parseRelayIntent(value: unknown): RelayIntentMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    typeof o.chainId !== 'number' ||
    !Number.isInteger(o.chainId) ||
    !isAddressText(o.from) ||
    !isAddressText(o.merchant) ||
    !isDecimal(o.merchantValue) ||
    !isDecimal(o.feeValue) ||
    !isHex32(o.nonce) ||
    !isDecimal(o.validBefore) ||
    (o.routeKind !== 'free' && o.routeKind !== 'recover') ||
    !isIssuedAt(o.issuedAt)
  ) {
    return null;
  }
  return {
    chainId: o.chainId,
    from: o.from,
    merchant: o.merchant,
    merchantValue: o.merchantValue,
    feeValue: o.feeValue,
    nonce: o.nonce,
    validBefore: o.validBefore,
    routeKind: o.routeKind,
    issuedAt: o.issuedAt,
  };
}

function parseStandardIntent(value: unknown): StandardIntentMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    o.version !== 1 ||
    typeof o.chainId !== 'number' ||
    !Number.isInteger(o.chainId) ||
    (o.from !== undefined && !isAddressText(o.from)) ||
    !isAddressText(o.tokenAddress) ||
    !isAddressText(o.merchant) ||
    !isDecimal(o.merchantValue) ||
    !isAddressText(o.feeReceiver) ||
    !isDecimal(o.feeValue) ||
    (o.saleValue !== undefined && !isDecimal(o.saleValue)) ||
    (o.stage !== 'merchant' &&
      o.stage !== 'fee' &&
      o.stage !== 'fee-awaiting') ||
    !isHex32(o.merchantTxHash) ||
    (o.feeTxHash !== undefined && !isHex32(o.feeTxHash)) ||
    (o.merchantBlockNumber !== undefined &&
      !isDecimal(o.merchantBlockNumber)) ||
    (o.contextKey !== undefined && !isHex32(o.contextKey)) ||
    (o.registerFee !== undefined && o.registerFee !== true) ||
    !isIssuedAt(o.issuedAt)
  ) {
    return null;
  }
  if (
    (o.stage === 'fee' && !o.feeTxHash) ||
    (o.stage !== 'merchant' &&
      (o.merchantBlockNumber === undefined || o.feeValue === '0'))
  ) {
    return null;
  }
  return {
    version: 1,
    chainId: o.chainId,
    ...(o.from ? { from: o.from } : {}),
    tokenAddress: o.tokenAddress,
    merchant: o.merchant,
    merchantValue: o.merchantValue,
    feeReceiver: o.feeReceiver,
    feeValue: o.feeValue,
    ...(o.saleValue !== undefined ? { saleValue: o.saleValue } : {}),
    stage: o.stage,
    merchantTxHash: o.merchantTxHash,
    ...(o.feeTxHash ? { feeTxHash: o.feeTxHash } : {}),
    ...(o.merchantBlockNumber !== undefined
      ? { merchantBlockNumber: o.merchantBlockNumber }
      : {}),
    ...(o.contextKey ? { contextKey: o.contextKey } : {}),
    ...(o.registerFee === true ? { registerFee: true as const } : {}),
    issuedAt: o.issuedAt,
  };
}

function load<T>(
  key: string,
  parse: (value: unknown) => T | null,
): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = parse(JSON.parse(raw));
    if (parsed) return parsed;
    window.sessionStorage.removeItem(key);
    return null;
  } catch {
    // sessionStorage/壊れた JSON の障害を決済画面全体へ波及させない。
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sessionStorage の容量・プライバシー制限を進行中の決済送信へ波及させない。
  }
}

function clear(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // sessionStorage の後片付け失敗を確定済みの決済結果へ波及させない。
  }
}

export function loadRelayIntent(): RelayIntentMetadata | null {
  return load(RELAY_INTENT_STORAGE_KEY, parseRelayIntent);
}

export function saveRelayIntent(intent: RelayIntentMetadata): void {
  // 署名や signed payload を誤って混入できないよう、保存値を公開メタデータへ再構成する。
  save(RELAY_INTENT_STORAGE_KEY, {
    chainId: intent.chainId,
    from: intent.from,
    merchant: intent.merchant,
    merchantValue: intent.merchantValue,
    feeValue: intent.feeValue,
    nonce: intent.nonce,
    validBefore: intent.validBefore,
    routeKind: intent.routeKind,
    issuedAt: intent.issuedAt,
  });
}

export function clearRelayIntent(): void {
  clear(RELAY_INTENT_STORAGE_KEY);
}

export function loadStandardIntent(): StandardIntentMetadata | null {
  return load(STANDARD_INTENT_STORAGE_KEY, parseStandardIntent);
}

export function standardParamsFromIntent(
  intent: StandardIntentMetadata,
): StandardPaymentIntentParams {
  return {
    tokenAddress: intent.tokenAddress,
    merchant: intent.merchant,
    merchantAmount: BigInt(intent.merchantValue),
    feeReceiver: intent.feeReceiver,
    feeAmount: BigInt(intent.feeValue),
    chainId: intent.chainId,
    ...(intent.saleValue !== undefined
      ? { saleAmount: BigInt(intent.saleValue) }
      : {}),
    ...(intent.contextKey ? { contextKey: intent.contextKey } : {}),
    ...(intent.registerFee ? { registerFee: true as const } : {}),
  };
}

export function saveStandardPaymentIntent(
  stage: StandardIntentStage,
  params: StandardPaymentIntentParams,
  from: Address | undefined,
  merchantTxHash: Hex,
  values: { feeTxHash?: Hex; merchantBlockNumber?: bigint },
  issuedAt: number,
): void {
  saveStandardIntent({
    version: 1,
    chainId: params.chainId,
    ...(from ? { from } : {}),
    tokenAddress: params.tokenAddress,
    merchant: params.merchant,
    merchantValue: params.merchantAmount.toString(),
    feeReceiver: params.feeReceiver,
    feeValue: params.feeAmount.toString(),
    ...(params.saleAmount !== undefined
      ? { saleValue: params.saleAmount.toString() }
      : {}),
    stage,
    merchantTxHash,
    ...(values.feeTxHash ? { feeTxHash: values.feeTxHash } : {}),
    ...(values.merchantBlockNumber !== undefined
      ? { merchantBlockNumber: values.merchantBlockNumber.toString() }
      : {}),
    ...(params.contextKey ? { contextKey: params.contextKey } : {}),
    ...(params.registerFee ? { registerFee: true as const } : {}),
    issuedAt,
  });
}

export function saveStandardIntent(intent: StandardIntentMetadata): void {
  // txHash と公開支払い metadata だけを whitelist し、呼出側の将来フィールドを意図せず永続化しない。
  save(STANDARD_INTENT_STORAGE_KEY, {
    version: 1,
    chainId: intent.chainId,
    ...(intent.from ? { from: intent.from } : {}),
    tokenAddress: intent.tokenAddress,
    merchant: intent.merchant,
    merchantValue: intent.merchantValue,
    feeReceiver: intent.feeReceiver,
    feeValue: intent.feeValue,
    ...(intent.saleValue !== undefined
      ? { saleValue: intent.saleValue }
      : {}),
    stage: intent.stage,
    merchantTxHash: intent.merchantTxHash,
    ...(intent.feeTxHash ? { feeTxHash: intent.feeTxHash } : {}),
    ...(intent.merchantBlockNumber !== undefined
      ? { merchantBlockNumber: intent.merchantBlockNumber }
      : {}),
    ...(intent.contextKey ? { contextKey: intent.contextKey } : {}),
    ...(intent.registerFee ? { registerFee: true as const } : {}),
    issuedAt: intent.issuedAt,
  });
}

export function clearStandardIntent(): void {
  clear(STANDARD_INTENT_STORAGE_KEY);
}
