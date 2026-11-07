'use client';

import type { Address, Hex } from 'viem';

export const RELAY_INTENT_STORAGE_KEY = 'openpay:relay-intent:v1';
export const STANDARD_INTENT_STORAGE_KEY = 'openpay:standard-intent:v1';
export const USAGE_FEE_INTENT_STORAGE_KEY = 'openpay:usage-fee-intent:v1';

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
  // 注文リンクの支払いの指紋 (lib/checkoutIntentContext の orderLinkContextFingerprint・公開の注文文脈だけから作る
  // digest)。CheckoutForm が注文リンクの支払いにだけ付け、読み直した後の完了を「この注文リンク」の支払いにだけ結び付ける
  // (第 9 回レビュー G-1)。署名・relay POST には載せない。
  orderLinkKey?: Hex;
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
  // 注文リンクの支払いの指紋 (RelayIntentMetadata.orderLinkKey と同じ)。注文リンクの支払いにだけ付く。
  orderLinkKey?: Hex;
};

// hooks/useStandardPayment の mutate 引数 (型だけ)。lib/standardPaymentLog も使うため lib に置く
// (lib/ は hooks/ を import できない・F-4)。hook は既存の import 先を保つため再エクスポートする。
export type StandardPaymentParams = StandardPaymentIntentParams & {
  customer?: Address;
  tip?: true;
  chainSlug?: import('@/lib/chains').ChainSlug;
  mode?: 'standard';
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
  orderLinkKey?: Hex;
  issuedAt: number;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^\d+$/;
// EIP-712 署名 (65 byte = 132 文字) だが、wallet 実装差を許容するため長さは緩く bound する。
const SIGNATURE = /^0x[0-9a-fA-F]{100,600}$/;

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
    // 形の崩れた指紋は落とすだけで intent は残す (指紋は「注文を送る」と払った記録にしか使わない。intent ごと捨てて
    // 未解決の支払いの復旧 latch を外し、再署名 = 二重払いへ波及させない)。
    ...(isHex32(o.orderLinkKey) ? { orderLinkKey: o.orderLinkKey } : {}),
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
    // 注文リンクの指紋は contextKey と違い、崩れていても intent ごとは捨てない (relay と同じ理由・receipt 照会の
    // latch を外して二重送金へ波及させない)。指紋だけ落とす。
    ...(isHex32(o.orderLinkKey) ? { orderLinkKey: o.orderLinkKey } : {}),
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
    ...(isHex32(intent.orderLinkKey) ? { orderLinkKey: intent.orderLinkKey } : {}),
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
    ...(intent.orderLinkKey ? { orderLinkKey: intent.orderLinkKey } : {}),
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
    ...(params.orderLinkKey ? { orderLinkKey: params.orderLinkKey } : {}),
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
    ...(isHex32(intent.orderLinkKey) ? { orderLinkKey: intent.orderLinkKey } : {}),
    issuedAt: intent.issuedAt,
  });
}

export function clearStandardIntent(): void {
  clear(STANDARD_INTENT_STORAGE_KEY);
}

// --- OpenPay 利用料 (a1) のガスレス支払い ---
// relay intent (顧客決済) と違い署名まで保存する。理由: 利用料の応答不明後の再試行は
// **同じ nonce の同一 payload を再 POST** して server 冪等キー (chainId+from+nonce) に当てる
// 必要があり、公開 metadata だけでは payload を再構成できない (再署名 = 新 nonce = 二重課金)。
// 露出範囲は sessionStorage (同一タブ・同一 origin) に限定され、authorization 自体も
// to=FEE_RECEIVER / 固定額 / 単発 nonce に縛られる。確定応答で必ず破棄する。
export type UsageFeeIntentMetadata = {
  version: 1;
  chainId: number;
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
  issuedAt: number;
};

function parseUsageFeeIntent(value: unknown): UsageFeeIntentMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    o.version !== 1 ||
    typeof o.chainId !== 'number' ||
    !Number.isInteger(o.chainId) ||
    !isAddressText(o.from) ||
    !isAddressText(o.to) ||
    !isDecimal(o.value) ||
    !isDecimal(o.validAfter) ||
    !isDecimal(o.validBefore) ||
    !isHex32(o.nonce) ||
    typeof o.signature !== 'string' ||
    !SIGNATURE.test(o.signature) ||
    !isIssuedAt(o.issuedAt)
  ) {
    return null;
  }
  return {
    version: 1,
    chainId: o.chainId,
    from: o.from,
    to: o.to,
    value: o.value,
    validAfter: o.validAfter,
    validBefore: o.validBefore,
    nonce: o.nonce,
    signature: o.signature as Hex,
    issuedAt: o.issuedAt,
  };
}

export function loadUsageFeeIntent(): UsageFeeIntentMetadata | null {
  return load(USAGE_FEE_INTENT_STORAGE_KEY, parseUsageFeeIntent);
}

export function saveUsageFeeIntent(intent: UsageFeeIntentMetadata): void {
  // 呼出側の将来フィールドを意図せず永続化しないよう、保存値を whitelist で再構成する。
  save(USAGE_FEE_INTENT_STORAGE_KEY, {
    version: 1,
    chainId: intent.chainId,
    from: intent.from,
    to: intent.to,
    value: intent.value,
    validAfter: intent.validAfter,
    validBefore: intent.validBefore,
    nonce: intent.nonce,
    signature: intent.signature,
    issuedAt: intent.issuedAt,
  });
}

export function clearUsageFeeIntent(): void {
  clear(USAGE_FEE_INTENT_STORAGE_KEY);
}

// --- 売上をほかのウォレットへ移す (plans/store-sales-move.md §2.2) ---
// お客様の決済の枠 (RELAY_INTENT_STORAGE_KEY) とは別のキー・別の parse。決済の枠は 1 スロットで、PaymentForm /
// CheckoutForm が routeKind === 'recover' で復元するので、そこへ移動を入れると決済の画面が移動の結果を自分の支払いとして
// 読み直してしまう (Fable 2)。中身は決済の枠と同じく公開の metadata だけ (署名は保存しない)。読み直した後は nonce で
// /api/relay/jpyc/status を照会する (recover の形のまま・status は routeKind を見ない)。
export const SALES_MOVE_INTENT_STORAGE_KEY = 'openpay:move-intent:v1';

export type SalesMoveIntentMetadata = {
  version: 1;
  chainId: number;
  from: Address;
  /** 送り先 (relay の payload の merchant)。 */
  merchant: Address;
  /** 送り先に届く額 (wei の 10 進)。 */
  merchantValue: string;
  /** 利用料 (wei の 10 進)。 */
  feeValue: string;
  /** receiveWithAuthorization の nonce (forwarder のコミットメント)。 */
  nonce: Hex;
  validBefore: string;
  issuedAt: number;
};

function parseSalesMoveIntent(value: unknown): SalesMoveIntentMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    o.version !== 1 ||
    typeof o.chainId !== 'number' ||
    !Number.isInteger(o.chainId) ||
    !isAddressText(o.from) ||
    !isAddressText(o.merchant) ||
    !isDecimal(o.merchantValue) ||
    !isDecimal(o.feeValue) ||
    !isHex32(o.nonce) ||
    !isDecimal(o.validBefore) ||
    !isIssuedAt(o.issuedAt)
  ) {
    return null;
  }
  return {
    version: 1,
    chainId: o.chainId,
    from: o.from,
    merchant: o.merchant,
    merchantValue: o.merchantValue,
    feeValue: o.feeValue,
    nonce: o.nonce,
    validBefore: o.validBefore,
    issuedAt: o.issuedAt,
  };
}

export function loadSalesMoveIntent(): SalesMoveIntentMetadata | null {
  return load(SALES_MOVE_INTENT_STORAGE_KEY, parseSalesMoveIntent);
}

export function saveSalesMoveIntent(intent: SalesMoveIntentMetadata): void {
  // 署名や signed payload を誤って混入できないよう、保存値を公開メタデータへ再構成する。
  save(SALES_MOVE_INTENT_STORAGE_KEY, {
    version: 1,
    chainId: intent.chainId,
    from: intent.from,
    merchant: intent.merchant,
    merchantValue: intent.merchantValue,
    feeValue: intent.feeValue,
    nonce: intent.nonce,
    validBefore: intent.validBefore,
    issuedAt: intent.issuedAt,
  });
}

export function clearSalesMoveIntent(): void {
  clear(SALES_MOVE_INTENT_STORAGE_KEY);
}
