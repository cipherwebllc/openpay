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
import { stripControlChars, truncateSafe } from '@/lib/sanitize';
import { normalizeHost } from '@/lib/net/privateHost';
import { caip2ForChainId } from './network';
import { x402FacilitatorConfig } from './facilitatorConfig';
import { OPENPAY_CANONICAL_ORIGIN } from './firstParty';
import {
  hiddenUrlLedgerKey,
  HIDDEN_URL_LEDGER_TTL_SEC,
  HIDDEN_URL_LEDGER_VALUE,
} from './hiddenUrlLedger';
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

export type X402Verification = {
  lastOkAt?: string;
  lastCheckedAt: string;
  failures: number;
  // 401/403/別 origin への redirect が連続した回数 (cloaking 検出・B8)。既存レコードには存在しない
  // ため **欠落 = 0** として読む (後方互換)。0 のときは書かない = 従来と同じ JSON 形を保つ。
  authFailures?: number;
  lastRunId: string;
  probedUrl: string;
};

// dual-rail (JPYC + USDC/Base) 出品の USDC 面。指定した resource だけが CDP リレー
// (/api/x402/relay/*) を使える。payTo は出品者の受取先 (OpenPay は USDC 側の手数料を取らない)。
export type X402ResourceUsdc = {
  payTo: string; // USDC (Base) 受取先 (checksum)
  priceUsd: string; // "0.005" 形式 (USD・$ なし・小数 6 桁まで)
  serviceName?: string; // CDP Bazaar の検索・カード表示名 (任意・≤60 字)
};

export type X402Resource = {
  id: string;
  merchant: string; // owner wallet (SIWE・checksum)
  url: string;
  description: string;
  priceJpyc: string; // human JPYC 整数 (表示価格・seller 受領額)
  category: string;
  docsUrl?: string;
  license?: string;
  payTo: string; // seller 受取先 (既定 = merchant)
  network: string; // CAIP-2 (facilitator の対象 chain)
  active: boolean;
  createdAt: number;
  updatedAt?: number;
  verification?: X402Verification;
  hidden?: boolean;
  usdc?: X402ResourceUsdc;
};

export type X402ResourceInput = {
  merchant: string;
  url: string;
  description: string;
  priceJpyc: string;
  category: string;
  docsUrl?: string;
  license?: string;
  payTo: string;
  usdc?: X402ResourceUsdc;
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
export const MAX_RESOURCE_DOCS_URL = 512;
export const MAX_RESOURCE_LICENSE = 60;
export const MAX_USDC_SERVICE_NAME = 60;
const MAX_PRICE_DIGITS = 9; // ≤ 999,999,999 JPYC (fat-finger 上限)
// USD 価格 ("0.005" 形式・$ なし)。整数部 ≤6 桁 (≤ $999,999)・小数 ≤6 桁 (USDC decimals)。
// vanillaGate.usdPriceToAtomic が受理する形の部分集合 (先頭 $ を許さない = 保存形を一意に)。
const USDC_PRICE_RE = /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,6})?$/;

export type ParseResourceResult =
  | { ok: true; input: X402ResourceInput }
  | { ok: false; reason: string };

const OPENPAY_CANONICAL_URL = new URL(OPENPAY_CANONICAL_ORIGIN);

export function isOpenPayCanonicalOriginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === OPENPAY_CANONICAL_URL.protocol &&
      normalizeHost(url.hostname.toLowerCase()) ===
        normalizeHost(OPENPAY_CANONICAL_URL.hostname.toLowerCase()) &&
      url.port === OPENPAY_CANONICAL_URL.port
    );
  } catch {
    return false;
  }
}

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
  // 限定する + そもそも公開 API ではない)。canonical OpenPay origin は運営生成の first-party
  // カタログだけに予約し、第三者の payTo / Docs を公式リソースへ重ねる経路を断つ。
  // URL パース不能も弾く。
  try {
    const parsedUrl = new URL(url);
    if (isPrivateHost(parsedUrl.hostname) || isOpenPayCanonicalOriginUrl(url)) {
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
  let docsUrl: string | undefined;
  if (r.docsUrl !== undefined && r.docsUrl !== '') {
    if (typeof r.docsUrl !== 'string') {
      return { ok: false, reason: 'invalid_docs_url' };
    }
    const cleaned = stripControlChars(r.docsUrl);
    if (
      cleaned.length === 0 ||
      cleaned.length > MAX_RESOURCE_DOCS_URL ||
      !URL.canParse(cleaned) ||
      new URL(cleaned).protocol !== 'https:'
    ) {
      return { ok: false, reason: 'invalid_docs_url' };
    }
    docsUrl = cleaned;
  }
  let license: string | undefined;
  if (r.license !== undefined && r.license !== '') {
    if (typeof r.license !== 'string') {
      return { ok: false, reason: 'invalid_license' };
    }
    const cleaned = stripControlChars(r.license);
    if (cleaned.length > 0) {
      license = truncateSafe(cleaned, MAX_RESOURCE_LICENSE);
    }
  }
  let payTo = getAddress(owner);
  if (r.payTo !== undefined && r.payTo !== '') {
    if (!isAddress(r.payTo as string)) {
      return { ok: false, reason: 'invalid_pay_to' };
    }
    payTo = getAddress(r.payTo as string);
  }
  // dual-rail (USDC/Base) 面 (任意)。未指定 = JPYC のみ (これまで通り)。指定時は 3 項目を検証:
  // priceUsd は保存形を一意にする ($ なし・"0" 単独は不可 = 0 額 settle を作らない)。
  // payTo 未指定は JPYC 側の payTo (= 出品者) を既定にする。
  let usdc: X402ResourceUsdc | undefined;
  if (r.usdc !== undefined && r.usdc !== null && r.usdc !== '') {
    if (typeof r.usdc !== 'object' || Array.isArray(r.usdc)) {
      return { ok: false, reason: 'invalid_usdc' };
    }
    const u = r.usdc as Record<string, unknown>;
    const priceUsd = typeof u.priceUsd === 'string' ? u.priceUsd.trim() : '';
    if (!USDC_PRICE_RE.test(priceUsd) || !/[1-9]/.test(priceUsd)) {
      return { ok: false, reason: 'invalid_usdc_price' };
    }
    let usdcPayTo = payTo;
    if (u.payTo !== undefined && u.payTo !== '') {
      if (!isAddress(u.payTo as string)) {
        return { ok: false, reason: 'invalid_usdc_pay_to' };
      }
      usdcPayTo = getAddress(u.payTo as string);
    }
    let serviceName: string | undefined;
    if (u.serviceName !== undefined && u.serviceName !== '') {
      if (typeof u.serviceName !== 'string') {
        return { ok: false, reason: 'invalid_usdc_service_name' };
      }
      const cleaned = stripControlChars(u.serviceName).trim();
      if (cleaned.length < 1 || cleaned.length > MAX_USDC_SERVICE_NAME) {
        return { ok: false, reason: 'invalid_usdc_service_name' };
      }
      serviceName = cleaned;
    }
    usdc = { payTo: usdcPayTo, priceUsd, ...(serviceName ? { serviceName } : {}) };
  }
  return {
    ok: true,
    input: {
      merchant: getAddress(owner),
      url,
      description,
      priceJpyc,
      category,
      docsUrl,
      license,
      payTo,
      usdc,
    },
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
// N-5: KEYS[4] = hidden URL 台帳。台帳に載っている URL は hidden 済 (ARGV[4]) の JSON で作成し、
// 「DELETE → 同一 URL で再登録」でモデレーション状態を洗い流す経路を塞ぐ。判定と保存を同じ
// script に閉じるので、削除と再登録を並走させても台帳を跨げない。戻り: 1=作成 / 3=hidden 継承で
// 作成 / -2=cap 超過。
const CAS_CREATE =
  'local cap=tonumber(ARGV[3]); ' +
  "if redis.call('LLEN',KEYS[3])>=cap then return -2 end; " +
  "local doc=ARGV[1]; local code=1; " +
  "if redis.call('EXISTS',KEYS[4])==1 then doc=ARGV[4]; code=3 end; " +
  "redis.call('SET',KEYS[1],doc); " +
  "redis.call('LPUSH',KEYS[2],ARGV[2]); " +
  "redis.call('LPUSH',KEYS[3],ARGV[2]); return code";

export type CreateResourceResult =
  | { ok: true; resource: X402Resource }
  | { ok: false; reason: 'invalid_url' | 'too_many' | 'storage' };

// resource を作成して KV に保存する。id は採番 (uuid)。network は facilitator の対象 chain。
// cap 判定・保存・両 index 登録を CAS_CREATE で原子化する (cap race / orphan を防ぐ)。nowMs を引数化
// して testable に。parseResourceInput を経由しない内部呼び出しでも OpenPay origin の偽装 record を
// 永続化させない。戻り: invalid_url=予約 origin / too_many=登録上限 / storage=KV エラー / ok=作成。
export async function createResource(
  input: X402ResourceInput,
  id: string,
  nowMs: number,
): Promise<CreateResourceResult> {
  if (isOpenPayCanonicalOriginUrl(input.url)) {
    return { ok: false, reason: 'invalid_url' };
  }
  const resource: X402Resource = {
    id,
    merchant: input.merchant,
    url: input.url,
    description: input.description,
    priceJpyc: input.priceJpyc,
    category: input.category,
    ...(input.docsUrl ? { docsUrl: input.docsUrl } : {}),
    ...(input.license ? { license: input.license } : {}),
    ...(input.usdc ? { usdc: input.usdc } : {}),
    payTo: input.payTo,
    network: caip2ForChainId(x402FacilitatorConfig.chainId),
    active: true,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  const hiddenResource: X402Resource = { ...resource, hidden: true };
  const cas = await kvEval<number>(
    CAS_CREATE,
    [
      resourceKey(id),
      RESOURCES_INDEX,
      merchantResourcesKey(input.merchant),
      hiddenUrlLedgerKey(input.url),
    ],
    [
      JSON.stringify(resource),
      id,
      String(MAX_RESOURCES_PER_MERCHANT),
      JSON.stringify(hiddenResource),
    ],
  );
  if (!cas.ok) return { ok: false, reason: 'storage' };
  if (cas.value === -2) return { ok: false, reason: 'too_many' };
  // 3 = 台帳に載っていた URL なので hidden を継承して作成した (公開カタログには出ない)。
  if (cas.value === 3) return { ok: true, resource: hiddenResource };
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
async function resolveActiveByIds(
  ids: string[],
  opts: { includeHidden: boolean },
): Promise<X402Resource[] | null> {
  const out: X402Resource[] = [];
  for (let i = 0; i < ids.length; i += RESOLVE_CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(i, i + RESOLVE_CONCURRENCY).map((id) => kvGet(resourceKey(id))),
    );
    for (const got of batch) {
      if (!got.ok) return null; // 取得失敗を「空」と誤認しない
      const res = safeParse<X402Resource>(got.value);
      if (res && res.active && (opts.includeHidden || res.hidden !== true)) {
        out.push(res);
      }
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
  return resolveActiveByIds(r.value, { includeHidden: true });
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

// owner 一致時のみ編集可能フィールド (url/description/priceJpyc/category/docsUrl/license/payTo/usdc) を更新する CAS。
// read→write を atomic にし (handleStore と同流儀)、特に soft-delete (active:false) との競合で
// 削除済 resource を復活させない — active/id/merchant/network/createdAt は Lua が現値を保持する。
// soft-delete 済 (active:false) は編集不可 (-3) = 保持した監査データ (settlement が参照する当時の
// payTo/価格) を後から書き換えさせない。
// ⚠️ URL 変更時にリセットするのは **verification (連続失敗カウンタ) だけ**で、`hidden` は残す。
// hidden は cron 再検証 (lib/x402/reverify.ts) が付けたモデレーション状態であり、owner が別 URL へ
// PATCH → 元 URL へ PATCH し直すだけで解除できると自動 hidden が無意味になる (B6)。復帰は
// 「再検証が ok_402_openpay を観測する」正規経路のみ (reverify の CAS が hidden=false に倒す)。
// 戻り: 更新後 JSON 文字列=成功 / -1=未存在 / -2=malformed / -3=削除済 / 0=owner 不一致。
const CAS_UPDATE =
  CAS_OWNER_GUARD +
  'if o.active==false then return -3 end; ' +
  'if o.url~=ARGV[2] then o.verification=nil end; ' +
  'o.url=ARGV[2]; o.description=ARGV[3]; o.priceJpyc=ARGV[4]; o.category=ARGV[5]; o.payTo=ARGV[6]; ' +
  "if ARGV[7]=='' then o.docsUrl=nil else o.docsUrl=ARGV[7] end; " +
  "if ARGV[8]=='' then o.license=nil else o.license=ARGV[8] end; " +
  // usdc (dual-rail 面) は検証済み input を JSON で受け取り丸ごと置換 (空 = 面を外す)。
  "if ARGV[10]=='' then o.usdc=nil else o.usdc=cjson.decode(ARGV[10]) end; " +
  'o.updatedAt=tonumber(ARGV[9]); ' +
  "redis.call('SET',KEYS[1],cjson.encode(o)); return cjson.encode(o)";

// owner 一致時のみ soft-delete (active:false) する CAS。既に無効なら 2 (冪等)。
// discovery index は active 一覧用なので LREM で掃除する。merchant index は登録総数 cap 用に残す。
// 戻り: 1=無効化 / 2=既に無効 / -1=未存在 / -2=malformed / 0=owner 不一致。
const CAS_DEACTIVATE_BODY =
  "if o.active==false then redis.call('LREM',KEYS[2],0,ARGV[2]); return 2 end; " +
  "o.active=false; redis.call('SET',KEYS[1],cjson.encode(o)); " +
  "redis.call('LREM',KEYS[2],0,ARGV[2]); return 1";

const CAS_DEACTIVATE = CAS_OWNER_GUARD + CAS_DEACTIVATE_BODY;

// N-5: hidden 済の掲載を削除するときだけ URL 台帳 (KEYS[3]) に印を残す。owner が
// 「DELETE → 同一 URL で再登録」で hidden を消せないようにする (createResource が継承する)。
// hidden の判定は権威レコード (o.hidden) 側で行うので、呼び元の読取と競合しても誤って印を残さない。
const CAS_DEACTIVATE_WITH_LEDGER =
  CAS_OWNER_GUARD +
  "if o.hidden==true then redis.call('SET',KEYS[3],ARGV[3],'EX',ARGV[4]) end; " +
  CAS_DEACTIVATE_BODY;

export type UpdateResourceResult =
  | { ok: true; resource: X402Resource }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'storage' };

// owner 限定で編集可能フィールド (url/description/priceJpyc/category/docsUrl/license/payTo/usdc) を更新する。
// id/merchant/network/createdAt/active は不変。**merchant !== owner は forbidden** = 他人の掲載や
// payTo (送金先) を書き換えさせない (認可の要)。owner 確認と書込を CAS で原子化し、KV エラー/破損は
// not_found ではなく storage に倒す (outage を「未存在」と誤魔化さない)。input は検証済を渡す。
export async function updateResource(
  id: string,
  owner: string,
  input: X402ResourceInput,
  nowMs = Date.now(),
): Promise<UpdateResourceResult> {
  const cas = await kvEval<number | string>(CAS_UPDATE, [resourceKey(id)], [
    getAddress(owner),
    input.url,
    input.description,
    input.priceJpyc,
    input.category,
    input.payTo,
    input.docsUrl ?? '',
    input.license ?? '',
    String(nowMs),
    input.usdc ? JSON.stringify(input.usdc) : '',
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
  // 台帳キーは URL の sha256 なので Lua 側では作れない (Redis Lua は sha1 のみ)。先に URL を
  // 読んで鍵を渡し、**印を残すか否かの判定 (o.hidden) は Lua が権威レコードで**行う。URL を
  // 読めなかった (未存在 / KV エラー) ときは従来どおりの 2 keys 版に倒す。
  const existing = await getResource(id);
  const ledgerKey = existing?.url ? hiddenUrlLedgerKey(existing.url) : null;
  const cas = ledgerKey
    ? await kvEval<number>(
        CAS_DEACTIVATE_WITH_LEDGER,
        [resourceKey(id), RESOURCES_INDEX, ledgerKey],
        [
          getAddress(owner),
          id,
          HIDDEN_URL_LEDGER_VALUE,
          String(HIDDEN_URL_LEDGER_TTL_SEC),
        ],
      )
    : await kvEval<number>(
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

// 公開カタログ (discovery)。active かつ hidden でないもののみ・新しい順。hidden record は index に
// 残して cron の成功 probe で自動復帰できるようにする。**KV エラーは null**
// (呼び元 discovery は 503 を返し、空カタログと誤認・キャッシュさせない)。
export async function listActiveResources(): Promise<X402Resource[] | null> {
  const r = await kvLrange(RESOURCES_INDEX, 0, LIST_FETCH_CAP - 1);
  if (!r.ok) return null;
  return resolveActiveByIds(r.value, { includeHidden: false });
}

// settle 成功の settlement を記録 (会計用)。fail-quiet (money-path を壊さない・bool を返す)。
export async function recordSettlement(s: X402Settlement): Promise<boolean> {
  const set = await kvSet(settlementKey(s.id), JSON.stringify(s));
  if (!set.ok) return false;
  await kvLpush(SETTLEMENTS_INDEX, s.id);
  return true;
}
