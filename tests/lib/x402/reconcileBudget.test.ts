import { describe, expect, it } from 'vitest';
import {
  pageFetchTimeout,
  rpcCallOptions,
  STORE_RECONCILE_CRON_MAX_DURATION_SEC,
  STORE_RECONCILE_CURSOR_RESERVE_MS,
  STORE_RECONCILE_PAGE_RPC_MIN_MS,
  STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS,
  STORE_RECONCILE_TOTAL_BUDGET_MS,
  storeReconcileDeadlines,
} from '@/lib/x402/reconcileBudget';

// 第 7 回レビュー B4 (follow-up): ページ取得の RPC は「残り時間 − cursor 保存の予約」で上限化し、足りなければ始めない。
describe('store-reconcile page fetch budget', () => {
  const now = 1_800_000_000_000;
  it('without a deadline the fetch is unbounded (status route keeps the default transport)', () => {
    expect(pageFetchTimeout(undefined, now)).toBeUndefined();
  });
  it('caps a single fetch at the page RPC timeout while plenty of time remains', () => {
    expect(pageFetchTimeout(now + 25_000, now)).toBe(STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS);
  });
  it('shrinks the fetch to the remaining time minus the cursor-save reserve', () => {
    expect(pageFetchTimeout(now + STORE_RECONCILE_CURSOR_RESERVE_MS + 7_000, now)).toBe(7_000);
  });
  it('refuses to start a fetch that cannot finish before the reserve (null = stop and persist the cursor)', () => {
    expect(pageFetchTimeout(now + STORE_RECONCILE_CURSOR_RESERVE_MS + STORE_RECONCILE_PAGE_RPC_MIN_MS - 1, now)).toBeNull();
    expect(pageFetchTimeout(now + STORE_RECONCILE_CURSOR_RESERVE_MS + STORE_RECONCILE_PAGE_RPC_MIN_MS, now)).toBe(STORE_RECONCILE_PAGE_RPC_MIN_MS);
    expect(pageFetchTimeout(now - 1, now)).toBeNull();
  });
  // B4 follow-up 2: 全 RPC (getLogs・receipt・block・authorizationState) が同じ予算を adapter の options として受ける。
  // deadlineAt = この呼び出しの絶対期限 (開始時刻 + timeoutMs)。transport は RPC ごとに「deadlineAt までの残り時間」から
  // 新しい signal を作るので、同じ client の後続 RPC や fallback 先が作成時の signal で早期に abort されない。
  it('maps the page fetch budget to adapter call options (undefined = unbounded, null = do not start)', () => {
    expect(rpcCallOptions(undefined, now)).toBeUndefined();
    expect(rpcCallOptions(now + 25_000, now)).toEqual({ timeoutMs: STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS, deadlineAt: now + STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS });
    expect(rpcCallOptions(now + STORE_RECONCILE_CURSOR_RESERVE_MS + 7_000, now)).toEqual({ timeoutMs: 7_000, deadlineAt: now + 7_000 });
    expect(rpcCallOptions(now - 1, now)).toBeNull();
  });
  it('keeps the whole budget inside the cron maxDuration with room for the last fetch and the cursor save', () => {
    const { jpyc, usdc } = storeReconcileDeadlines(now);
    expect(jpyc).toBeLessThan(usdc);
    expect(usdc + STORE_RECONCILE_PAGE_RPC_TIMEOUT_MS).toBeLessThanOrEqual(now + STORE_RECONCILE_CRON_MAX_DURATION_SEC * 1000);
    expect(STORE_RECONCILE_TOTAL_BUDGET_MS + STORE_RECONCILE_CURSOR_RESERVE_MS).toBeLessThan(STORE_RECONCILE_CRON_MAX_DURATION_SEC * 1000);
  });
});
