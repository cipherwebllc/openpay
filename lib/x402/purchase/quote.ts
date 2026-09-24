import 'server-only';

// creator-store hosted purchase の quote 段 (R3b): quoted intent の SET NX 保存・quote rate limit・anchor block。
// 公開 API は facade (lib/x402/purchaseIntent.ts) が re-export する。KEYS/ARGV の順序は
// tests/lib/x402/purchaseIntentCompatibility.test.ts が分割前の snapshot で固定している。
import {
  isSafeTimestamp,
  parseHex32,
} from '@/lib/x402/storeWire';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import { licenseNftEnabled } from '@/lib/license/config';
import {
  createPublicClient,
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
} from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { kvEval, kvSet } from '@/lib/kv';
import { FORWARDER_COMMIT_VERSION } from '@/lib/relay/forwarderIntent';
import {
  hostedContentKey,
  type HostedPurchaseMetadata,
} from '@/lib/x402/hostedStore';
import {
  MAX_UINT256,
  PURCHASE_DEPLOYMENT_VERSION,
  PURCHASE_INTENT_VERSION,
  PURCHASE_QUOTE_GRACE_SEC,
  PURCHASE_QUOTE_IP_MAX,
  PURCHASE_QUOTE_RATE_WINDOW_SEC,
  PURCHASE_QUOTE_RESOURCE_MAX,
  PURCHASE_QUOTE_TTL_SEC,
  PURCHASE_QUOTE_WALLET_MAX,
  type QuotedPurchaseIntent,
} from './types';
import {
  isPurchaseIntentSalt,
  newPurchaseIntentSalt,
  purchaseIntentKey,
} from './keys';
import { lowerHex, parseMetadata, quoteBinding } from './parse';
import { QUOTE_RATE_LIMIT } from './lua';

export type CreateQuotedPurchaseIntentInput = {
  resourceId: string;
  contentRevision: number;
  metadata: HostedPurchaseMetadata;
  payer: Address;
  token: Address;
  chainId: number;
  forwarder: Address;
  merchant: Address;
  merchantValue: bigint;
  feeReceiver: Address;
  feeValue: bigint;
  anchorBlock: bigint;
  now?: number;
  intentSalt?: Hex;
  commitVersion?: Hex;
  deploymentVersion?: string;
};

export type CreateQuotedPurchaseIntentResult =
  | { ok: true; intent: QuotedPurchaseIntent }
  | { ok: false; reason: 'storage' | 'conflict' | 'invalid' };

export async function createQuotedPurchaseIntent(
  input: CreateQuotedPurchaseIntentInput,
): Promise<CreateQuotedPurchaseIntentResult> {
  const normalizedMetadata = parseMetadata(input.metadata);
  const commitVersion = parseHex32(
    input.commitVersion ?? FORWARDER_COMMIT_VERSION,
  );
  const deploymentVersion =
    input.deploymentVersion ?? PURCHASE_DEPLOYMENT_VERSION;
  if (
    !normalizedMetadata ||
    !commitVersion ||
    typeof deploymentVersion !== 'string' ||
    deploymentVersion.length === 0 ||
    commitVersion !== FORWARDER_COMMIT_VERSION ||
    deploymentVersion !== PURCHASE_DEPLOYMENT_VERSION ||
    input.resourceId.length === 0 ||
    !Number.isSafeInteger(input.contentRevision) ||
    input.contentRevision < 1 ||
    !isAddress(input.payer) ||
    !isAddress(input.token) ||
    !isAddress(input.forwarder) ||
    !isAddress(input.merchant) ||
    !isAddress(input.feeReceiver) ||
    input.chainId <= 0 ||
    !Number.isSafeInteger(input.chainId) ||
    input.merchantValue <= 0n ||
    input.merchantValue > MAX_UINT256 ||
    input.feeValue <= 0n ||
    input.feeValue > MAX_UINT256 ||
    input.anchorBlock < 0n ||
    input.anchorBlock > MAX_UINT256 ||
    !isAddressEqual(normalizedMetadata.payTo, input.merchant)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (normalizedMetadata.license && (!isAddressEqual(input.token, JPYC_V3_ASSET.address) || !licenseNftEnabled() || normalizedMetadata.license.contentRef !== hostedContentKey(input.resourceId, input.contentRevision) || normalizedMetadata.license.tokenChainId !== input.chainId || input.merchantValue !== BigInt(normalizedMetadata.priceJpyc) * 10n ** 18n)) return { ok: false, reason: 'invalid' };
  const now = input.now ?? Date.now();
  if (
    !isSafeTimestamp(now) ||
    !Number.isSafeInteger(
      now +
        (PURCHASE_QUOTE_TTL_SEC + PURCHASE_QUOTE_GRACE_SEC) * 1000,
    )
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const intentSalt = lowerHex(input.intentSalt ?? newPurchaseIntentSalt());
  if (!isPurchaseIntentSalt(intentSalt)) {
    return { ok: false, reason: 'invalid' };
  }
  const quoteExpiresAt = now + PURCHASE_QUOTE_TTL_SEC * 1000;
  const authorizationValidBeforeMax = String(
    Math.floor(quoteExpiresAt / 1000),
  );
  const contentRef = hostedContentKey(
    input.resourceId,
    input.contentRevision,
  );
  const bindingInput = {
    intentSalt,
    resourceId: input.resourceId,
    contentRevision: input.contentRevision,
    contentRef,
    metadata: normalizedMetadata,
    payerHint: getAddress(input.payer),
    token: getAddress(input.token),
    chainId: input.chainId,
    forwarder: getAddress(input.forwarder),
    commitVersion,
    deploymentVersion,
    merchant: getAddress(input.merchant),
    merchantValue: input.merchantValue.toString(),
    feeReceiver: getAddress(input.feeReceiver),
    feeValue: input.feeValue.toString(),
    anchorBlock: input.anchorBlock.toString(),
    quoteExpiresAt,
    authorizationValidBeforeMax,
  };
  const intent: QuotedPurchaseIntent = {
    version: PURCHASE_INTENT_VERSION,
    state: 'quoted',
    ...bindingInput,
    createdAt: now,
    bindingHash: quoteBinding(bindingInput),
  };
  const saved = await kvSet(
    purchaseIntentKey(intentSalt),
    JSON.stringify(intent),
    {
      nx: true,
      ttlSec: PURCHASE_QUOTE_TTL_SEC + PURCHASE_QUOTE_GRACE_SEC,
    },
  );
  if (!saved.ok) return { ok: false, reason: 'storage' };
  if (saved.value === null) return { ok: false, reason: 'conflict' };
  return { ok: true, intent };
}

export async function checkPurchaseQuoteRateLimit(input: {
  payer: Address;
  resourceId: string;
  ipHash: string | null;
}): Promise<boolean> {
  const keys = [
    `store:quote:rl:wallet:${input.payer.toLowerCase()}`,
    `store:quote:rl:resource:${input.resourceId}`,
  ];
  const limits = [
    String(PURCHASE_QUOTE_WALLET_MAX),
    String(PURCHASE_QUOTE_RESOURCE_MAX),
  ];
  if (input.ipHash !== null) {
    keys.push(`store:quote:rl:ip:${input.ipHash}`);
    limits.push(String(PURCHASE_QUOTE_IP_MAX));
  }
  try {
    const result = await kvEval<number>(QUOTE_RATE_LIMIT, keys, [
      '1',
      '0',
      '1',
      String(PURCHASE_QUOTE_RATE_WINDOW_SEC),
      ...limits,
      'string',
      'none',
      'table',
      '-1',
    ]);
    // 付帯 limiter の KV 障害を quote 本体へ波及させない。intent 保存自体は別途 fail-closed。
    return !result.ok || result.value !== 0;
  } catch {
    // 何の波及を断つか: rate-limit storage の例外だけで正規購入を停止しない。
    return true;
  }
}

export async function readPurchaseAnchorBlock(
  chainId: number,
): Promise<bigint | null> {
  const chain = chainObjectForId(chainId);
  if (!chain) return null;
  try {
    const client = createPublicClient({
      chain,
      transport: transportForChain(chainId),
    });
    return await client.getBlockNumber();
  } catch {
    return null;
  }
}
