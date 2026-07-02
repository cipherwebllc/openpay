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
import { kvGet, kvSet, kvLpush, kvLrange, kvEval } from '@/lib/kv';
import { caip2ForChainId } from './network';
import { x402FacilitatorConfig } from './facilitatorConfig';
import { isPrivateHost } from './moderation';

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
  opts: { requireAttestation?: boolean } = {},
): ParseResourceResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'invalid_body' };
  }
  const r = raw as Record<string, unknown>;
  // 出品の正当性表明: 登録者が当該リソースを提供・課金する正当な権利を有し、支払いゲート
  // (HTTP 402 等) を実装していることの表明。新規登録 (POST・requireAttestation) でのみ必須。
  if (opts.requireAttestation && r.attested !== true) {
    return { ok: false, reason: 'attestation_required' };
  }
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!/^https?:\/\//.test(url) || url.length > MAX_URL) {
    return { ok: false, reason: 'invalid_url' };
  }
  // SSRF ガード: private/loopback/link-local 宛は登録不可 (モデレーション probe 先を public host に
  // 限定する + そもそも公開 API ではない)。URL パース不能も弾く。
  try {
    if (isPrivateHost(new URL(url).hostname)) {
      return { ok: false, reason: 'invalid_url' };
    }
  } catch {
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

// cap 判定 + 保存 + 両 index 登録を 1 script で原子化する。LLEN(merchant index) >= cap なら -2
// (作成しない = 並列 POST が cap を擦り抜けるレースを塞ぐ)。それ以外は SET(resource) + LPUSH(discovery
// index) + LPUSH(merchant index) を実行 (Redis Lua は原子的なので「SET 成功・LPUSH 失敗」の orphan も
// 起きない)。戻り: 1=作成 / -2=cap 超過。
const CAS_CREATE =
  'local cap=tonumber(ARGV[3]); ' +
  "if redis.call('LLEN',KEYS[3])>=cap then return -2 end; " +
  "redis.call('SET',KEYS[1],ARGV[1]); " +
  "redis.call('LPUSH',KEYS[2],ARGV[2]); " +
  "redis.call('LPUSH',KEYS[3],ARGV[2]); return 1";

export type CreateResourceResult =
  | { ok: true; resource: X402Resource }
  | { ok: false; reason: 'too_many' | 'storage' };

// resource を作成して KV に保存する。id は採番 (uuid)。network は facilitator の対象 chain。
// cap 判定・保存・両 index 登録を CAS_CREATE で原子化する (cap race / orphan を防ぐ)。nowMs を引数化
// して testable に。戻り: too_many=登録上限 (429) / storage=KV エラー (503) / ok=作成。
export async function createResource(
  input: X402ResourceInput,
  id: string,
  nowMs: number,
): Promise<CreateResourceResult> {
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
  const cas = await kvEval<number>(
    CAS_CREATE,
    [resourceKey(id), RESOURCES_INDEX, merchantResourcesKey(input.merchant)],
    [JSON.stringify(resource), id, String(MAX_RESOURCES_PER_MERCHANT)],
  );
  if (!cas.ok) return { ok: false, reason: 'storage' };
  if (cas.value === -2) return { ok: false, reason: 'too_many' };
  if (cas.value !== 1) return { ok: false, reason: 'storage' };
  return { ok: true, resource };
}

export async function getResource(id: string): Promise<X402Resource | null> {
  const r = await kvGet(resourceKey(id));
  if (!r.ok) return null;
  return safeParse<X402Resource>(r.value);
}

// 同時 KV GET 上限。公開カタログ (discovery) は最大 LIST_FETCH_CAP(500) 件を解決しうるため、
// 無制限 Promise.all で 500 並列を一度に発射すると Upstash のバースト制限に当たり getResource が
// 失敗 → null 除外でカタログ項目が無言で欠落しうる。バッチ単位で並列化して同時数を抑える。
const RESOLVE_CONCURRENCY = 25;

// index の id 群を chunk 並列で active resource に解決する。直列 N+1 を避けつつ同時数を
// RESOLVE_CONCURRENCY に制限する (Upstash バースト回避)。バッチは順次・バッチ内は並列なので index の
// 新しい順 (LPUSH) は維持。**1 件でも KV 取得失敗なら null** (outage を「空」と誤認させない・呼び元は
// 503)。malformed/欠落/inactive は黙ってスキップ (self-heal は別 op)。公開カタログ (listActiveResources)
// と owner 一覧 (listResourcesForMerchant) で共有する。
async function resolveActiveByIds(ids: string[]): Promise<X402Resource[] | null> {
  const out: X402Resource[] = [];
  for (let i = 0; i < ids.length; i += RESOLVE_CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(i, i + RESOLVE_CONCURRENCY).map((id) => kvGet(resourceKey(id))),
    );
    for (const got of batch) {
      if (!got.ok) return null; // 取得失敗を「空」と誤認しない
      const res = safeParse<X402Resource>(got.value);
      if (res && res.active) out.push(res); // malformed/欠落/inactive は skip
    }
  }
  return out;
}

// owner の resource 一覧 (登録 UI 用)。active のみ — deactivate (soft-delete) 済は owner 画面からも
// 隠す (データは KV に残す: settlement が resourceId を参照・監査)。index には id が残るが filter で除外。
// **KV エラー (index 読取 or 各 record 取得) は null** を返し「空」と区別する (handleStore と同流儀)。
// outage 中に owner へ「登録ゼロ」と誤表示して重複登録や削除誤認を招かないため。呼出側 (GET) は null で 503。
export async function listResourcesForMerchant(
  wallet: string,
): Promise<X402Resource[] | null> {
  const r = await kvLrange(merchantResourcesKey(wallet), 0, LIST_FETCH_CAP - 1);
  if (!r.ok) return null;
  return resolveActiveByIds(r.value);
}

// owner の登録総数 (active + soft-deleted)。登録上限 (濫用ガード) 判定用。index は deactivate でも
// 縮めないので「これまで作成した総数」になり、create→delete の反復で KV を無制限に増やさせない。
// **KV エラーは null** を返し「0 件」と誤認させない (上限 bypass を防ぐ・handleStore と同流儀)。
export async function countMerchantResources(wallet: string): Promise<number | null> {
  const r = await kvLrange(merchantResourcesKey(wallet), 0, LIST_FETCH_CAP - 1);
  if (!r.ok) return null;
  return r.value.length;
}

// owner 認可つき CAS の共通前段: 取得 → decode → 形検査 → owner 一致確認。一致時は decoded table を
// ローカル o に残し、続く本処理 (更新 / 無効化) が o を書き換える。途中脱出の戻り値は両 CAS で共通:
// -1=未存在 / -2=malformed / 0=owner 不一致。
const CAS_OWNER_GUARD =
  "local c=redis.call('GET',KEYS[1]); if not c then return -1 end; " +
  'local ok,o=pcall(cjson.decode,c); if not ok then return -2 end; ' +
  "if type(o)~='table' or type(o.merchant)~='string' then return -2 end; " +
  'if string.lower(o.merchant)~=string.lower(ARGV[1]) then return 0 end; ';

// owner 一致時のみ編集可能フィールド (url/description/priceJpyc/category/payTo) を更新する CAS。
// read→write を atomic にし (handleStore と同流儀)、特に soft-delete (active:false) との競合で
// 削除済 resource を復活させない — active/id/merchant/network/createdAt は Lua が現値を保持する。
// soft-delete 済 (active:false) は編集不可 (-3) = 保持した監査データ (settlement が参照する当時の
// payTo/価格) を後から書き換えさせない。
// 戻り: 更新後 JSON 文字列=成功 / -1=未存在 / -2=malformed / -3=削除済 / 0=owner 不一致。
const CAS_UPDATE =
  CAS_OWNER_GUARD +
  'if o.active==false then return -3 end; ' +
  'o.url=ARGV[2]; o.description=ARGV[3]; o.priceJpyc=ARGV[4]; o.category=ARGV[5]; o.payTo=ARGV[6]; ' +
  "redis.call('SET',KEYS[1],cjson.encode(o)); return cjson.encode(o)";

// owner 一致時のみ soft-delete (active:false) する CAS。既に無効なら 2 (冪等)。
// discovery index は active 一覧用なので LREM で掃除する。merchant index は登録総数 cap 用に残す。
// 戻り: 1=無効化 / 2=既に無効 / -1=未存在 / -2=malformed / 0=owner 不一致。
const CAS_DEACTIVATE =
  CAS_OWNER_GUARD +
  "if o.active==false then redis.call('LREM',KEYS[2],0,ARGV[2]); return 2 end; " +
  "o.active=false; redis.call('SET',KEYS[1],cjson.encode(o)); " +
  "redis.call('LREM',KEYS[2],0,ARGV[2]); return 1";

export type UpdateResourceResult =
  | { ok: true; resource: X402Resource }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'storage' };

// owner 限定で編集可能フィールド (url/description/priceJpyc/category/payTo) を更新する。
// id/merchant/network/createdAt/active は不変。**merchant !== owner は forbidden** = 他人の掲載や
// payTo (送金先) を書き換えさせない (認可の要)。owner 確認と書込を CAS で原子化し、KV エラー/破損は
// not_found ではなく storage に倒す (outage を「未存在」と誤魔化さない)。input は検証済を渡す。
export async function updateResource(
  id: string,
  owner: string,
  input: X402ResourceInput,
): Promise<UpdateResourceResult> {
  const cas = await kvEval<number | string>(CAS_UPDATE, [resourceKey(id)], [
    getAddress(owner),
    input.url,
    input.description,
    input.priceJpyc,
    input.category,
    input.payTo,
  ]);
  if (!cas.ok) return { ok: false, reason: 'storage' };
  // -1=未存在 / -3=削除済 → どちらも「編集可能な resource は無い」= not_found。
  if (cas.value === -1 || cas.value === -3) return { ok: false, reason: 'not_found' };
  if (cas.value === 0) return { ok: false, reason: 'forbidden' };
  if (typeof cas.value !== 'string') return { ok: false, reason: 'storage' }; // -2 (破損 JSON) 等
  const updated = safeParse<X402Resource>(cas.value);
  if (!updated) return { ok: false, reason: 'storage' };
  return { ok: true, resource: updated };
}

export type DeactivateResourceResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'storage' };

// owner 限定で soft-delete (active:false)。公開カタログ + owner 一覧から消えるがデータは KV 保持
// (settlement の resourceId 参照・監査のため)。owner 確認と書込を CAS で原子化。既に無効なら冪等に ok。
export async function deactivateResource(
  id: string,
  owner: string,
): Promise<DeactivateResourceResult> {
  const cas = await kvEval<number>(
    CAS_DEACTIVATE,
    [resourceKey(id), RESOURCES_INDEX],
    [getAddress(owner), id],
  );
  if (!cas.ok) return { ok: false, reason: 'storage' };
  if (cas.value === -1) return { ok: false, reason: 'not_found' };
  if (cas.value === -2) return { ok: false, reason: 'storage' }; // 破損 JSON
  if (cas.value === 0) return { ok: false, reason: 'forbidden' };
  return { ok: true }; // 1 (無効化) / 2 (既に無効・冪等)
}

// 公開カタログ (discovery)。active のみ・新しい順 (LPUSH なので index は新しい順)。**KV エラーは null**
// (呼び元 discovery は 503 を返し、空カタログと誤認・キャッシュさせない)。
export async function listActiveResources(): Promise<X402Resource[] | null> {
  const r = await kvLrange(RESOURCES_INDEX, 0, LIST_FETCH_CAP - 1);
  if (!r.ok) return null;
  return resolveActiveByIds(r.value);
}

// settle 成功の settlement を記録 (会計用)。fail-quiet (money-path を壊さない・bool を返す)。
export async function recordSettlement(s: X402Settlement): Promise<boolean> {
  const set = await kvSet(settlementKey(s.id), JSON.stringify(s));
  if (!set.ok) return false;
  await kvLpush(SETTLEMENTS_INDEX, s.id);
  return true;
}
