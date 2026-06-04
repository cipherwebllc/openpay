// freee「取引(収入)」一括同期の純粋コア (HTTP/KV を注入する DI 設計)。
//
// 履歴は localStorage 側なのでクライアントが income-sale entries を送る → サーバは
// ここで isIncomeSaleEntry を**再検証** (改竄・幽霊売上を弾く) + 円換算 + freee deals
// payload へ写像し、冪等キーで二重計上を防ぎつつ createDeal する。
//
// 冪等性: entry ごとに安定キー (wallet + txHash||id) を SET NX で claim。
//   fresh    → createDeal → finalize(key, dealId)。失敗時は release(key) で claim 解放 (再試行可)。
//   in-flight→ 別送信が処理中 (skip)。
//   done     → 既に同期済 (skip・既存 dealId を返す)。
// これにより「freee に同期」を再クリックしても重複取引を作らない。

import { isIncomeSaleEntry } from './historyFilters';
import { entryYenValue } from './historyYen';
import {
  entryLineItems,
  HISTORY_ASSET_DISPLAY,
  type HistoryEntry,
} from './history';
import { shortAddress } from './format';
import { pad } from './pad';

/** freee deals に必要な会社・勘定科目・税区分 ID (名前でなく ID 指定が必須)。 */
export type FreeeMapping = {
  companyId: number;
  accountItemId: number;
  taxCode: number;
};

export type FreeeDealBody = {
  company_id: number;
  issue_date: string; // YYYY-MM-DD
  type: 'income';
  details: Array<{
    account_item_id: number;
    tax_code: number;
    amount: number;
    description: string;
  }>;
};

/** 発生日 (ローカル tz・YYYY-MM-DD)。会計 CSV の ymd と同じ規約。 */
export function freeeIssueDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 摘要: OpenPay 由来である事 + 記帳補助メタ (商品名/管理番号/メモ) + 追跡情報。
 *  freee には deal の tax_code は mapping の単一値を使うため、税率以外の補助情報 (商品名・
 *  管理番号・メモ) は反映できる範囲で摘要にまとめる (freee に draft 状態が無いため明記しレビューを促す)。 */
export function freeeDescription(e: HistoryEntry): string {
  const parts = [`OpenPay ${HISTORY_ASSET_DISPLAY[e.asset]}/${e.chainSlug}`];
  // 売上明細サマリ「商品名 x数量 / …」(複数商品も摘要に。freee deal は 1 取引=1 行で
  // tax_code は mapping の単一値・明細は摘要にまとめる=二重計上回避優先)。
  const items = entryLineItems(e);
  if (items.length > 0) {
    const summary = items
      .slice(0, 5)
      .map((li) => `${li.name} x${li.quantity}`)
      .join(' / ');
    parts.push(items.length > 5 ? `${summary} ほか` : summary);
  }
  if (e.txHash) parts.push(`tx:${shortAddress(e.txHash)}`);
  if (e.anchorAmount != null && e.anchorSymbol) {
    parts.push(`元:${e.anchorAmount} ${HISTORY_ASSET_DISPLAY[e.anchorSymbol]}`);
  }
  if (e.receiptNo) parts.push(`No:${e.receiptNo}`);
  if (e.memo) parts.push(e.memo);
  return parts.join(' / ');
}

/** entry + 円額 + mapping → freee deals(収入) payload。 */
export function buildFreeeDeal(
  e: HistoryEntry,
  yen: number,
  mapping: FreeeMapping,
): FreeeDealBody {
  return {
    company_id: mapping.companyId,
    issue_date: freeeIssueDate(e.ts),
    type: 'income',
    details: [
      {
        account_item_id: mapping.accountItemId,
        tax_code: mapping.taxCode,
        amount: yen,
        description: freeeDescription(e),
      },
    ],
  };
}

/** 冪等キー: wallet + (txHash があれば txHash・無ければ entry.id)。wallet は小文字に正規化。 */
export function freeeIdempotencyKey(wallet: string, e: HistoryEntry): string {
  return `freee:synced:${wallet.toLowerCase()}:${e.txHash ?? e.id}`;
}

export type ClaimState =
  | { kind: 'fresh' }
  | { kind: 'in-flight' }
  | { kind: 'done'; dealId: number };

export type FreeeSyncDeps = {
  /** SIWE 検証済の店主 wallet (冪等キーの名前空間)。 */
  wallet: string;
  /** USDC・anchor 無しの円換算に使う現レート (未取得は undefined)。 */
  usdcJpy: number | undefined;
  mapping: FreeeMapping;
  /** key を SET NX で claim し、既存なら状態を返す。 */
  claim: (key: string) => Promise<ClaimState>;
  /** freee に取引を作成し deal id を返す。 */
  createDeal: (body: FreeeDealBody) => Promise<number>;
  /** claim を成功確定 (dealId を恒久記録)。書込成功で true。false なら synced 扱い不可。 */
  finalize: (key: string, dealId: number) => Promise<boolean>;
  /** createDeal 失敗時に claim を解放 (再試行可能にする)。 */
  release: (key: string) => Promise<void>;
};

export type FreeeSyncStatus =
  | 'synced'
  | 'skipped'
  | 'error'
  | 'rate-unavailable'
  | 'not-income';

export type FreeeSyncItem = {
  id: string;
  status: FreeeSyncStatus;
  dealId?: number;
  error?: string;
};

export type FreeeSyncSummary = {
  items: FreeeSyncItem[];
  synced: number;
  skipped: number;
  errored: number;
  rateUnavailable: number;
};

/**
 * income-sale entries を freee に冪等同期する。各 entry を順次処理し per-entry の
 * 結果を集計する (1 件の失敗で全体を止めない — 残りは継続)。
 */
export async function runFreeeSync(
  entries: ReadonlyArray<HistoryEntry>,
  deps: FreeeSyncDeps,
): Promise<FreeeSyncSummary> {
  const items: FreeeSyncItem[] = [];

  for (const e of entries) {
    // サーバ側 re-validation: 成功売上のみ (失敗/revert/手数料 leg/改竄を弾く)。
    if (!isIncomeSaleEntry(e)) {
      items.push({ id: e.id, status: 'not-income' });
      continue;
    }
    // entryYenValue は total (非数値 merchantAmount は 0 に潰す・throw しない) なので
    // untrusted client JSON でも安全に評価できる。
    const yv = entryYenValue(e, deps.usdcJpy);
    if (yv.kind === 'unavailable') {
      items.push({ id: e.id, status: 'rate-unavailable' });
      continue;
    }
    // untrusted client JSON ガード: 不正な発生日 (NaN/Inf) や 0 以下の金額で
    // garbage な取引 (NaN 日付・0 円) を freee に作らない。
    if (!Number.isFinite(e.ts) || yv.yen <= 0) {
      items.push({ id: e.id, status: 'error', error: 'invalid_entry' });
      continue;
    }

    const key = freeeIdempotencyKey(deps.wallet, e);
    const claim = await deps.claim(key);
    if (claim.kind === 'done') {
      items.push({ id: e.id, status: 'skipped', dealId: claim.dealId });
      continue;
    }
    if (claim.kind === 'in-flight') {
      items.push({ id: e.id, status: 'skipped' });
      continue;
    }

    // fresh: 取引を作成。失敗したら claim を解放して再試行できるようにする。
    try {
      const dealId = await deps.createDeal(buildFreeeDeal(e, yv.yen, deps.mapping));
      const persisted = await deps.finalize(key, dealId);
      if (persisted) {
        items.push({ id: e.id, status: 'synced', dealId });
      } else {
        // deal は freee に作成済だが冪等記録の永続化に失敗。**release しない** (claim を
        // pending のまま残し TTL 内の二重作成を防ぐ) + synced と偽らず error で露出する。
        // dealId は返すので運用者が freee 上で照合できる。
        items.push({ id: e.id, status: 'error', dealId, error: 'deal_created_unrecorded' });
      }
    } catch (err) {
      await deps.release(key);
      items.push({
        id: e.id,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    items,
    synced: items.filter((i) => i.status === 'synced').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    errored: items.filter((i) => i.status === 'error').length,
    rateUnavailable: items.filter((i) => i.status === 'rate-unavailable').length,
  };
}
