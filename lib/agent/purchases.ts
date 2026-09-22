import 'server-only';

import { createHash } from 'node:crypto';
import { kvLrange } from '@/lib/kv';
import type { SettleLedgerEntry, SettleLedgerSource } from '@/lib/x402/settleLedger';
import { normalizeAgentAddress } from './purchaseAddress';

export const AGENT_PURCHASES_SINCE = '2026-09-23';
export const AGENT_PURCHASES_MAX = 200;
const ORIGINS = {
  'usdc-vanilla': 'first-party',
  'usdc-dual-rail': 'listed',
  'jpyc-facilitator': 'claimed',
} as const;

export type PurchaseItem = Pick<SettleLedgerEntry, 'at' | 'source' | 'network' | 'asset' | 'amount' | 'fee' | 'tx'> & {
  resource: { host: string | null; path: string | null; pathTag?: string };
  resourceOrigin: 'first-party' | 'listed' | 'claimed';
};

// Same URL projection as MCP history.urlFields: query/fragment never leave storage.
function resourceFields(resource: string): PurchaseItem['resource'] {
  try {
    const parsed = new URL(resource);
    if (!parsed.hostname) return { host: null, path: null };
    return {
      host: parsed.hostname.slice(0, 253),
      path: parsed.hostname === 'open-pay.jp' ? parsed.pathname.slice(0, 512) : null,
      ...(parsed.hostname === 'open-pay.jp' ? {} : {
        pathTag: createHash('sha256').update(parsed.pathname).digest('hex').slice(0, 8),
      }),
    };
  } catch {
    // An invalid recorded URL must not expose its raw value or hide other purchases.
    return { host: null, path: null };
  }
}

function parsePurchase(raw: string, address: string): PurchaseItem | null {
  try {
    const row = JSON.parse(raw);
    if (!row || normalizeAgentAddress(row.payer) !== address || typeof row.at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T/.test(row.at) || !Number.isFinite(Date.parse(row.at)) ||
        typeof row.source !== 'string' || !Object.hasOwn(ORIGINS, row.source) || typeof row.network !== 'string' ||
        (row.asset !== 'USDC' && row.asset !== 'JPYC') || typeof row.resource !== 'string' ||
        typeof row.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(row.amount) ||
        (row.fee !== undefined && (typeof row.fee !== 'string' || !/^\d+(?:\.\d+)?$/.test(row.fee))) ||
        (row.tx !== null && typeof row.tx !== 'string')) return null;
    // Explicit projection: neither payTo nor arbitrary stored fields reach the caller.
    return {
      at: row.at, source: row.source, network: row.network, asset: row.asset, amount: row.amount,
      ...(row.fee === undefined ? {} : { fee: row.fee }),
      resource: resourceFields(row.resource), resourceOrigin: ORIGINS[row.source as SettleLedgerSource], tx: row.tx,
    };
  } catch {
    // Corrupt/partial rows are ancillary hints; they must not break the remaining history.
    return null;
  }
}

export async function readPayerPurchases(address: string): Promise<
  { ok: true; since: string; items: PurchaseItem[]; truncated: boolean } | { ok: false; reason: 'storage_error' }
> {
  const normalized = normalizeAgentAddress(address);
  if (!normalized) return { ok: false, reason: 'storage_error' };
  try {
    const result = await kvLrange(`x402:settle:payer:${normalized}`, 0, AGENT_PURCHASES_MAX);
    if (!result.ok) return { ok: false, reason: 'storage_error' };
    const items = result.value.map((line) => parsePurchase(line, normalized))
      .filter((row): row is PurchaseItem => row !== null)
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
      .slice(0, AGENT_PURCHASES_MAX);
    return { ok: true, since: AGENT_PURCHASES_SINCE, items, truncated: result.value.length > AGENT_PURCHASES_MAX };
  } catch {
    // Never present a storage outage as an empty purchase history.
    return { ok: false, reason: 'storage_error' };
  }
}
