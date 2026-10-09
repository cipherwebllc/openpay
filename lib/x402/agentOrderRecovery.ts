import 'server-only';

import { getAddress, isAddress, type Address } from 'viem';
import { decodeAgentCart } from '@/lib/agentOrder';
import { isValidHandleFormat, normalizeHandle } from '@/lib/handle';
import {
  declaredItemsTotalMinor,
  ORDER_ITEMS_MAX,
  ORDER_ITEM_NAME_MAX,
  ORDER_ITEM_QTY_MAX,
  sanitizeOrderItems,
  sanitizeTable,
  type StoredOrderItem,
} from '@/lib/orderRelay';
import { resolveDeployment } from '@/lib/tokens';
import { parseFacilitatorRequest } from '@/lib/x402/facilitatorSettle';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { caip2ForChainId } from '@/lib/x402/network';
import {
  paymentRedeliveryIdentity,
  type PaymentRedeliveryIdentity,
} from '@/lib/x402/paymentRedelivery';

const SNAPSHOT_VERSION = 1;
const PRICE_MAX = 80;
const TOTAL_MINOR_MAX = 80;
const ITEM_KEYS = ['name', 'price', 'qty'] as const;
const SNAPSHOT_KEYS = [
  'chainId',
  'decimals',
  'handle',
  'items',
  'merchant',
  'payer',
  'pickupAt',
  'resource',
  'table',
  'totalMinor',
  'version',
] as const;
// 受取時刻を店舗の候補枠へ正規化したときだけ持つ任意キー (第 7 回レビュー B12)。正規化が無い snapshot は
// 従来の形のまま (= 旧予約の digest と一致する・feeModel を足した #761 と同じ流儀)。
const SNAPSHOT_KEYS_WITH_REQUESTED = [...SNAPSHOT_KEYS, 'pickupAtRequested'].sort();

export type AgentOrderSnapshot = Record<string, unknown> & {
  version: typeof SNAPSHOT_VERSION;
  handle: string;
  merchant: Address;
  payer: Address;
  chainId: number;
  decimals: number;
  items: StoredOrderItem[];
  totalMinor: string;
  resource: string;
  table: string | null;
  // 受注・予約・応答で使う受取時刻 (ms)。preorder 店の候補枠へ正規化済み (正規化した場合は pickupAtRequested が
  // エージェントの指定値 = resource の pickupAt を保持し、resource との照合はそちらで行う)。
  pickupAt: number | null;
  pickupAtRequested?: number;
};

export type AgentOrderSettlement = Record<string, unknown> & {
  success: true;
  transaction: string;
  network: string;
  payer: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function parseItems(value: unknown): StoredOrderItem[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ORDER_ITEMS_MAX
  ) {
    return null;
  }
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, ITEM_KEYS)) return null;
    if (
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > ORDER_ITEM_NAME_MAX ||
      item.name.trim() !== item.name
    ) {
      return null;
    }
    if (
      typeof item.qty !== 'number' ||
      !Number.isInteger(item.qty) ||
      item.qty < 1 ||
      item.qty > ORDER_ITEM_QTY_MAX
    ) {
      return null;
    }
    if (
      typeof item.price !== 'string' ||
      item.price.length < 1 ||
      item.price.length > PRICE_MAX ||
      !/^(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9])$/.test(item.price)
    ) {
      return null;
    }
  }
  return value as StoredOrderItem[];
}

export function parseAgentOrderSnapshot(
  value: unknown,
): AgentOrderSnapshot | null {
  if (
    !isRecord(value) ||
    !(hasExactKeys(value, SNAPSHOT_KEYS) || hasExactKeys(value, SNAPSHOT_KEYS_WITH_REQUESTED)) ||
    value.version !== SNAPSHOT_VERSION
  ) {
    return null;
  }

  if (
    typeof value.handle !== 'string' ||
    normalizeHandle(value.handle) !== value.handle ||
    !isValidHandleFormat(value.handle)
  ) {
    return null;
  }
  if (
    typeof value.merchant !== 'string' ||
    !isAddress(value.merchant) ||
    typeof value.payer !== 'string' ||
    !isAddress(value.payer)
  ) {
    return null;
  }
  let merchant: Address;
  let payer: Address;
  try {
    merchant = getAddress(value.merchant);
    payer = getAddress(value.payer);
  } catch {
    return null;
  }
  if (merchant !== value.merchant || payer !== value.payer) return null;

  if (
    typeof value.chainId !== 'number' ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0 ||
    typeof value.decimals !== 'number' ||
    !Number.isInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 36
  ) {
    return null;
  }
  if (
    typeof value.totalMinor !== 'string' ||
    value.totalMinor.length < 1 ||
    value.totalMinor.length > TOTAL_MINOR_MAX ||
    !/^[1-9]\d*$/.test(value.totalMinor)
  ) {
    return null;
  }
  if (typeof value.resource !== 'string' || value.resource.length === 0) {
    return null;
  }

  const items = parseItems(value.items);
  const deployment = resolveDeployment('jpyc', value.chainId);
  if (
    !deployment ||
    deployment.decimals !== value.decimals ||
    items === null ||
    declaredItemsTotalMinor(items, value.decimals) !== BigInt(value.totalMinor)
  ) {
    return null;
  }

  const table =
    value.table === null ||
    (typeof value.table === 'string' && sanitizeTable(value.table) === value.table)
      ? value.table
      : undefined;
  if (table === undefined) return null;
  const pickupAt =
    value.pickupAt === null ||
    (typeof value.pickupAt === 'number' &&
      Number.isSafeInteger(value.pickupAt) &&
      value.pickupAt > 0)
      ? value.pickupAt
      : undefined;
  if (pickupAt === undefined) return null;
  // pickupAtRequested は「正規化で値が変わった」ときだけ存在する: 正の整数で、正規化後の pickupAt とは別の値。
  const hasRequested = 'pickupAtRequested' in value;
  if (
    hasRequested &&
    (pickupAt === null ||
      typeof value.pickupAtRequested !== 'number' ||
      !Number.isSafeInteger(value.pickupAtRequested) ||
      value.pickupAtRequested <= 0 ||
      value.pickupAtRequested === pickupAt)
  ) {
    return null;
  }

  return {
    version: SNAPSHOT_VERSION,
    handle: value.handle,
    merchant,
    payer,
    chainId: value.chainId,
    decimals: value.decimals,
    items,
    totalMinor: value.totalMinor,
    resource: value.resource,
    table,
    pickupAt,
    ...(hasRequested ? { pickupAtRequested: value.pickupAtRequested as number } : {}),
  };
}

export function createAgentOrderSnapshot(input: {
  handle: string;
  merchant: Address;
  payer: Address;
  chainId: number;
  decimals: number;
  items: StoredOrderItem[];
  totalMinor: bigint;
  resource: string;
  table: string | null;
  pickupAt: number | null;
  /** resource に書かれたエージェントの指定値。pickupAt と同じなら (正規化が無ければ) snapshot に残さない。 */
  pickupAtRequested?: number | null;
}): AgentOrderSnapshot | null {
  const normalized =
    input.pickupAtRequested !== undefined &&
    input.pickupAtRequested !== null &&
    input.pickupAtRequested !== input.pickupAt;
  const value: AgentOrderSnapshot = {
    version: SNAPSHOT_VERSION,
    handle: input.handle,
    merchant: input.merchant,
    payer: input.payer,
    chainId: input.chainId,
    decimals: input.decimals,
    items: sanitizeOrderItems(input.items),
    totalMinor: input.totalMinor.toString(),
    resource: input.resource,
    table: sanitizeTable(input.table) ?? null,
    pickupAt: input.pickupAt,
    ...(normalized ? { pickupAtRequested: input.pickupAtRequested as number } : {}),
  };
  return parseAgentOrderSnapshot(value);
}

export function parseBoundAgentOrderSnapshot(input: {
  context: unknown;
  facilitatorBody: unknown;
  resource: string;
  identity: PaymentRedeliveryIdentity;
}): AgentOrderSnapshot | null {
  const snapshot = parseAgentOrderSnapshot(input.context);
  if (
    snapshot === null ||
    snapshot.resource !== input.resource ||
    !isRecord(input.facilitatorBody)
  ) {
    return null;
  }
  const bodyIdentity = paymentRedeliveryIdentity(
    input.facilitatorBody.paymentPayload,
  );
  if (
    bodyIdentity === null ||
    bodyIdentity.keyIdentity !== input.identity.keyIdentity ||
    bodyIdentity.credential !== input.identity.credential
  ) {
    return null;
  }
  const requirements = input.facilitatorBody.paymentRequirements;
  if (!isRecord(requirements) || requirements.resource !== input.resource) {
    return null;
  }
  const parsed = parseFacilitatorRequest(input.facilitatorBody);
  if (
    !parsed.ok ||
    parsed.parsed.chainId !== snapshot.chainId ||
    parsed.parsed.params.from !== snapshot.payer ||
    parsed.parsed.params.merchant !== snapshot.merchant ||
    parsed.parsed.params.merchantValue !== BigInt(snapshot.totalMinor)
  ) {
    return null;
  }
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(snapshot.resource);
  } catch {
    return null;
  }
  if (
    resourceUrl.origin !== OPENPAY_CANONICAL_ORIGIN ||
    resourceUrl.pathname !== '/api/agent-order/pay' ||
    resourceUrl.searchParams.get('h') !== snapshot.handle ||
    sanitizeTable(resourceUrl.searchParams.get('table')) !== snapshot.table ||
    // resource の pickupAt はエージェントの指定値。正規化した snapshot は pickupAtRequested で照合する。
    pickupAtForAgentOrderSnapshot(
      resourceUrl.searchParams.get('pickupAt'),
    ) !== (snapshot.pickupAtRequested ?? snapshot.pickupAt)
  ) {
    return null;
  }
  const cart = decodeAgentCart(resourceUrl.searchParams.get('cart') ?? '');
  if (
    cart === null ||
    cart.length !== snapshot.items.length ||
    cart.some((item, index) => item.qty !== snapshot.items[index]?.qty)
  ) {
    return null;
  }
  return snapshot;
}

export function parseAgentOrderSettlement(
  value: unknown,
  snapshot: AgentOrderSnapshot,
): AgentOrderSettlement | null {
  if (
    !isRecord(value) ||
    value.success !== true ||
    typeof value.transaction !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.transaction) ||
    value.network !== caip2ForChainId(snapshot.chainId) ||
    typeof value.payer !== 'string' ||
    !isAddress(value.payer)
  ) {
    return null;
  }
  try {
    if (getAddress(value.payer) !== snapshot.payer) return null;
  } catch {
    return null;
  }
  return value as AgentOrderSettlement;
}

export function pickupAtForAgentOrderSnapshot(
  raw: string | null,
): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
