#!/usr/bin/env node
// node scripts/x402-registry-url-claims.mjs           # DRY-RUN, reads only
// node scripts/x402-registry-url-claims.mjs --apply   # backfill unambiguous claims
// Export KV_REST_API_URL / KV_REST_API_TOKEN beforehand (no implicit env loading).
// Run after all registry writers have the claim CAS. SCAN is not a snapshot:
// changed candidates are skipped by CAS, concurrent new claims cannot be replaced.
// Existing active duplicates require operator resolution; never choose a winner.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUpstashClient } from './lib/upstash-rest.mjs';
import { normalizeResourceUrl, resourceUrlClaimKey, URL_CLAIM_GUARD } from '../lib/x402/resourceUrlClaim.mjs';

export const BACKFILL_URL_CLAIM =
  // Compare the entire snapshot so a concurrent URL change/deactivation cannot
  // publish an obsolete claim. No record, index or existing claim is deleted.
  "if redis.call('GET',KEYS[1])~=ARGV[1] then return 'changed' end; " +
  URL_CLAIM_GUARD +
  "local claim=claimAvailable(KEYS[2],ARGV[2]); if claim==-5 then return 'url_taken' end; " +
  "if claim~=1 then return 'storage' end; " +
  "if redis.call('GET',KEYS[2])==ARGV[2] then return 'exists' end; " +
  "redis.call('SET',KEYS[2],ARGV[2]); return 'claimed'";

const text = (value) => value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value;

export async function inventoryUrlClaims(client, { apply = false, log = console.log } = {}) {
  const keys = new Set();
  let cursor = '0';
  do {
    const [next, batch] = await client.command(['SCAN', cursor, 'MATCH', 'x402:resource:*', 'COUNT', '200']);
    cursor = String(text(next));
    for (const rawKey of batch) {
      const key = text(rawKey);
      // Include unindexed, hidden and inactive records; exclude the claim subspace.
      if (/^x402:resource:[^:]+$/.test(key)) keys.add(key);
    }
  } while (cursor !== '0');

  const groups = new Map(), invalid = [];
  let records = 0;
  for (const key of keys) {
    const raw = text(await client.command(['GET', key]));
    if (raw === null) continue; // A record removed during SCAN is no active claimant.
    try {
      const record = JSON.parse(raw);
      if (!record || typeof record.id !== 'string' || key !== 'x402:resource:' + record.id
        || typeof record.url !== 'string' || typeof record.active !== 'boolean'
        || typeof record.merchant !== 'string' || typeof record.payTo !== 'string'
        || typeof record.createdAt !== 'number') throw new Error('invalid_record');
      const url = normalizeResourceUrl(record.url);
      const group = groups.get(url) ?? [];
      group.push({ key, raw, record });
      groups.set(url, group);
      records++;
    } catch {
      // A malformed record could hide a competing active URL. Do not let an
      // incomplete inventory assign ownership to another seller under --apply.
      invalid.push(key);
    }
  }

  const summary = { mode: apply ? 'APPLY' : 'DRY-RUN', records, duplicates: 0, conflicts: 0,
    candidates: 0, claimed: 0, exists: 0, changed: 0, invalid, blocked: apply && invalid.length > 0 };
  log(JSON.stringify({ mode: summary.mode, records, invalid }));
  for (const [url, group] of groups) {
    const active = group.filter(({ record }) => record.active);
    if (group.length > 1) {
      summary.duplicates++;
      log(JSON.stringify({ duplicate: url, activeCount: active.length, records: group.map(({ record: r }) => ({
        id: r.id, merchant: r.merchant, recipient: r.payTo, usdcRecipient: r.usdc?.payTo,
        active: r.active, hidden: r.hidden === true, createdAt: r.createdAt,
      })) }));
    }
    if (active.length > 1) { summary.conflicts++; continue; }
    if (active.length !== 1) continue;
    summary.candidates++;
    if (!apply || summary.blocked) continue;
    const { key, raw, record } = active[0];
    const result = text(await client.command(['EVAL', BACKFILL_URL_CLAIM, 2,
      key, resourceUrlClaimKey(url), raw, record.id]));
    if (result === 'claimed' || result === 'exists' || result === 'changed') summary[result]++;
    else if (result === 'url_taken') summary.conflicts++;
    else throw new Error('claim_storage_error');
    log(JSON.stringify({ url, id: record.id, result }));
  }
  log(JSON.stringify(summary));
  return summary;
}

export async function main(args = process.argv.slice(2), { env = process.env, fetch = globalThis.fetch, log = console.log, error = console.error } = {}) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) {
    error('Usage: node scripts/x402-registry-url-claims.mjs [--apply]');
    return 1;
  }
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) {
    error('Export KV_REST_API_URL / KV_REST_API_TOKEN first');
    return 1;
  }
  try {
    const client = createUpstashClient({ url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN, fetch });
    const summary = await inventoryUrlClaims(client, { apply: args.includes('--apply'), log });
    return summary.invalid.length || summary.conflicts || summary.changed ? 1 : 0;
  } catch {
    // REST failures may contain credentials/server data; keep terminal errors closed.
    error('Registry URL claim inventory failed');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
