// x402 facilitator の加盟店登録 + discovery の KV ストア (merchants / resources / settlements)。
// KV-only (Upstash・lib/kv)。OpenPay は他機能と同じく KV を単一データストアにする (RDB なし)。
//
// キー:
//   x402:resource:<id>            → JSON (1 resource)
//   x402:resources:index          → list of resource id (discovery 列挙)
//   x402:merchant:<wallet>:resources → list of resource id (owner の一覧)
//   x402:settlement:<id>          → JSON (1 settlement・会計用)
//   x402:settlements:index        → list of settlement id
//
// resource は公開カタログ (誰でも GET /api/discovery で列挙)。登録は SIWE 認証で owner=接続ウォレット。

import { isAddress, getAddress } from 'viem';
import { kvGet, kvSet, kvLpush, kvLrange } from '@/lib/kv';
import { caip2ForChainId } from './network';
import { x402FacilitatorConfig } from './facilitatorConfig';

export const RESOURCES_INDEX = 'x402:resources:index';
export const SETTLEMENTS_INDEX = 'x402:settlements:index';
export const MAX_RESOURCES_PER_MERCHANT = 100;
const LIST_FETCH_CAP = 500; // 列挙の安全上限 (index の暴走防止)。

export function resourceKey(id: string): string {
  return `x402:resource:${id}`;
}
export function merchantResourcesKey(wallet: string): string {
  return `x402:merchant:${wallet.toLowerCase()}:resources`;
}
export function settlementKey(id: string): string {
  return `x402:settlement:${id}`;
}

export type X402Resource = {
  id: string;
  merchant: string; // owner wallet (SIWE・checksum)
  url: string;
  description: string;
  priceJpyc: string; // human JPYC 整数 (表示価格・seller 受領額)
  category: string;
  payTo: string; // seller 受取先 (既定 = merchant)
  network: string; // CAIP-2 (facilitator の対象 chain)
  active: boolean;
  createdAt: number;
};

export type X402ResourceInput = {
  merchant: string;
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  payTo: string;
};

export type X402Settlement = {
  id: string;
  resourceId?: string;
  payer: string;
  payTo: string;
  amount: string; // atomic JPYC (merchantValue)
  fee: string; // atomic JPYC (feeValue)
  txHash: string;
  network: string;
  receiptSig?: string;
  createdAt: number;
};

const MAX_URL = 2048;
const MAX_DESC = 280;
const MAX_CATEGORY = 40;
const MAX_PRICE_DIGITS = 9; // ≤ 999,999,999 JPYC (fat-finger 上限)

export type ParseResourceResult =
  | { ok: true; input: X402ResourceInput }
  | { ok: false; reason: string };

// 登録リクエストの検証 (純・route から呼ぶ)。owner = SIWE セッションのウォレット (checksum)。
// payTo 未指定は owner を既定にする。reason は invalidReason にそのまま使う。
export function parseResourceInput(
  raw: unknown,
  owner: string,
): ParseResourceResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'invalid_body' };
  }
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!/^https?:\/\//.test(url) || url.length > MAX_URL) {
    return { ok: false, reason: 'invalid_url' };
  }
  const description = typeof r.description === 'string' ? r.description.trim() : '';
  if (description.length < 1 || description.length > MAX_DESC) {
    return { ok: false, reason: 'invalid_description' };
  }
  const priceJpyc = typeof r.priceJpyc === 'string' ? r.priceJpyc.trim() : '';
  if (!/^[1-9][0-9]*$/.test(priceJpyc) || priceJpyc.length > MAX_PRICE_DIGITS) {
    return { ok: false, reason: 'invalid_price' };
  }
  const category = typeof r.category === 'string' ? r.category.trim() : '';
  if (category.length < 1 || category.length > MAX_CATEGORY) {
    return { ok: false, reason: 'invalid_category' };
  }
  let payTo = getAddress(owner);
  if (r.payTo !== undefined && r.payTo !== '') {
    if (!isAddress(r.payTo as string)) {
      return { ok: false, reason: 'invalid_pay_to' };
    }
    payTo = getAddress(r.payTo as string);
  }
  return {
    ok: true,
    input: { merchant: getAddress(owner), url, description, priceJpyc, category, payTo },
  };
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// resource を作成して KV に保存する。id は採番 (uuid)。network は facilitator の対象 chain。
// KV 書込失敗時は null (route が 503 を返す)。nowMs を引数化して testable に。
export async function createResource(
  input: X402ResourceInput,
  id: string,
  nowMs: number,
): Promise<X402Resource | null> {
  const resource: X402Resource = {
    id,
    merchant: input.merchant,
    url: input.url,
    description: input.description,
    priceJpyc: input.priceJpyc,
    category: input.category,
    payTo: input.payTo,
    network: caip2ForChainId(x402FacilitatorConfig.chainId),
    active: true,
    createdAt: nowMs,
  };
  const set = await kvSet(resourceKey(id), JSON.stringify(resource));
  if (!set.ok) return null;
  // index への push は best-effort (resource 本体は保存済)。失敗しても resource は引けるが
  // 列挙に出ない → warn は呼び元 route で。ここでは push 結果を見て resource は返す。
  await kvLpush(RESOURCES_INDEX, id);
  await kvLpush(merchantResourcesKey(input.merchant), id);
  return resource;
}

export async function getResource(id: string): Promise<X402Resource | null> {
  const r = await kvGet(resourceKey(id));
  if (!r.ok) return null;
  return safeParse<X402Resource>(r.value);
}

async function resolveIds(ids: string[]): Promise<X402Resource[]> {
  const out: X402Resource[] = [];
  for (const id of ids) {
    const r = await getResource(id);
    if (r) out.push(r);
  }
  return out;
}

// owner の resource 一覧 (登録 UI 用)。
export async function listResourcesForMerchant(
  wallet: string,
): Promise<X402Resource[]> {
  const r = await kvLrange(merchantResourcesKey(wallet), 0, LIST_FETCH_CAP);
  if (!r.ok) return [];
  return resolveIds(r.value);
}

// 公開カタログ (discovery)。active のみ。新しい順 (LPUSH なので index は新しい順)。
export async function listActiveResources(): Promise<X402Resource[]> {
  const r = await kvLrange(RESOURCES_INDEX, 0, LIST_FETCH_CAP);
  if (!r.ok) return [];
  const all = await resolveIds(r.value);
  return all.filter((x) => x.active);
}

// settle 成功の settlement を記録 (会計用)。fail-quiet (money-path を壊さない・bool を返す)。
export async function recordSettlement(s: X402Settlement): Promise<boolean> {
  const set = await kvSet(settlementKey(s.id), JSON.stringify(s));
  if (!set.ok) return false;
  await kvLpush(SETTLEMENTS_INDEX, s.id);
  return true;
}
