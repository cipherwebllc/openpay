import 'server-only';

// creator-store hosted purchase の耐久状態機械。
//
// PurchaseIntent は「商品」ではなく、server が発行した intentSalt に対する完全な
// EIP-3009 authorization tuple の claim を権威にする。quoted だけは短命、署名検証後の
// signed 以降は恒久保存し、paid route / status / cron のどこからでも同じ finalizer へ収束する。
//
// key:
//   store:intent:<intentSalt>                 PurchaseIntent
//   store:intent:pending                      pending intent の ZSET (SCAN 禁止)
//   store:own:<payer>:<resourceId>            全購入 revision の ownership
//   store:lib:<payer>                         resourceId の無制限 ZSET (trim 禁止)
//   store:purchase:<chainId>:<txHash>         authoritative purchase record
//
// R3a: 型・定数・KV key・parser・Lua 本文は lib/x402/purchase/{types,keys,parse,lua}.ts に分割した。
// R3b: 読み取り・quote・claim・状態遷移は lib/x402/purchase/{read,quote,claim,transitions}.ts に分割した。
// R3c: grant/record の builder・settled access の読み取り・finalize は lib/x402/purchase/{records,library,finalize}.ts に分割した。
// R3d: pending の列挙と掃除・reconcile の chain adapter・reconcile 本体は lib/x402/purchase/{pending,reconcileChain,reconcile}.ts に分割した。
// この file は公開 API の facade で、export 名は分割前と同じ。利用側の import と vi.mock は必ず
// `@/lib/x402/purchaseIntent` を通す (lib/x402/purchase/* の deep import は eslint.config.mjs が禁止)。
// 分割先は facade を import しない。分割先同士は直接 import して呼ぶ (facade は re-export だけを持つ)。

import {
  PURCHASE_DEPLOYMENT_VERSION,
  PURCHASE_EXPIRY_SAFETY_SEC,
  PURCHASE_INTENT_VERSION,
  PURCHASE_QUOTE_GRACE_SEC,
  PURCHASE_QUOTE_IP_MAX,
  PURCHASE_QUOTE_RATE_WINDOW_SEC,
  PURCHASE_QUOTE_RESOURCE_MAX,
  PURCHASE_QUOTE_TTL_SEC,
  PURCHASE_QUOTE_WALLET_MAX,
  PURCHASE_RECONCILE_BATCH_SIZE,
  PURCHASE_RECONCILE_LEASE_SEC,
  PURCHASE_RECONCILE_MAX_PAGES,
  PURCHASE_RECONCILE_PAGE_BLOCKS,
  PURCHASE_RECONCILE_RETRY_MS,
  PURCHASE_REVISION_POLICY,
  PURCHASE_SETTLEMENT_LEASE_SEC,
  type FailedPrebroadcastPurchaseIntent,
  type HostedPurchaseRecord,
  type IndeterminatePurchaseIntent,
  type PurchaseAuthorizationClaim,
  type PurchaseGrant,
  type PurchaseIntent,
  type PurchaseOwnership,
  type QuotedPurchaseIntent,
  type SettledPurchaseIntent,
  type SettlingPurchaseIntent,
  type SignedPurchaseIntent,
} from './purchase/types';
import {
  hostedPurchaseRecordKey,
  isPurchaseIntentSalt,
  newPurchaseIntentSalt,
  purchaseIntentKey,
  purchaseLibraryKey,
  purchaseOwnershipKey,
} from './purchase/keys';
import {
  parseHostedPurchaseRecord,
  parsePurchaseIntent,
  parsePurchaseOwnership,
} from './purchase/parse';

// 分割前と同じ公開 API (R3a)。利用側の import と vi.mock は必ずこの facade を通す。
export {
  PURCHASE_DEPLOYMENT_VERSION,
  PURCHASE_EXPIRY_SAFETY_SEC,
  PURCHASE_INTENT_VERSION,
  PURCHASE_QUOTE_GRACE_SEC,
  PURCHASE_QUOTE_IP_MAX,
  PURCHASE_QUOTE_RATE_WINDOW_SEC,
  PURCHASE_QUOTE_RESOURCE_MAX,
  PURCHASE_QUOTE_TTL_SEC,
  PURCHASE_QUOTE_WALLET_MAX,
  PURCHASE_RECONCILE_BATCH_SIZE,
  PURCHASE_RECONCILE_LEASE_SEC,
  PURCHASE_RECONCILE_MAX_PAGES,
  PURCHASE_RECONCILE_PAGE_BLOCKS,
  PURCHASE_RECONCILE_RETRY_MS,
  PURCHASE_REVISION_POLICY,
  PURCHASE_SETTLEMENT_LEASE_SEC,
};
export type {
  FailedPrebroadcastPurchaseIntent,
  HostedPurchaseRecord,
  IndeterminatePurchaseIntent,
  PurchaseAuthorizationClaim,
  PurchaseGrant,
  PurchaseIntent,
  PurchaseOwnership,
  QuotedPurchaseIntent,
  SettledPurchaseIntent,
  SettlingPurchaseIntent,
  SignedPurchaseIntent,
};
export {
  hostedPurchaseRecordKey,
  isPurchaseIntentSalt,
  newPurchaseIntentSalt,
  purchaseIntentKey,
  purchaseLibraryKey,
  purchaseOwnershipKey,
};
export { purchasePendingIndexKey } from './purchase/keys';
export {
  parseHostedPurchaseRecord,
  parsePurchaseIntent,
  parsePurchaseOwnership,
};
export { getPurchaseIntent } from './purchase/read';
export type { PurchaseIntentReadResult } from './purchase/read';
export {
  checkPurchaseQuoteRateLimit,
  createQuotedPurchaseIntent,
  readPurchaseAnchorBlock,
} from './purchase/quote';
export type {
  CreateQuotedPurchaseIntentInput,
  CreateQuotedPurchaseIntentResult,
} from './purchase/quote';
export {
  buildPurchaseAuthorizationClaim,
  claimPurchaseSettlement,
  claimSignedPurchaseIntent,
  extractPurchaseIntentSalt,
  purchaseAuthorizationMatches,
} from './purchase/claim';
export type {
  BuildPurchaseAuthorizationResult,
  ClaimPurchaseSettlementResult,
  ClaimSignedPurchaseResult,
} from './purchase/claim';
export {
  markPurchaseFailedPrebroadcast,
  markPurchaseIndeterminate,
  recordPurchaseTransaction,
} from './purchase/transitions';
export { finalizeHostedPurchase } from './purchase/finalize';
export type { FinalizeHostedPurchaseResult } from './purchase/finalize';
export { readSettledPurchaseAccess } from './purchase/library';
export type { SettledPurchaseAccessResult } from './purchase/library';
export { listPendingPurchaseIntents } from './purchase/pending';
export { defaultPurchaseReconcileChain } from './purchase/reconcileChain';
export type { PurchaseReconcileChain } from './purchase/reconcileChain';
export {
  reconcilePendingPurchases,
  reconcilePurchaseIntent,
} from './purchase/reconcile';
export type {
  ReconcilePendingSummary,
  ReconcilePurchaseIntentResult,
} from './purchase/reconcile';
