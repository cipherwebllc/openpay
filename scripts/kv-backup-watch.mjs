#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackupError } from './lib/kv-backup-core.mjs';
import { createR2Client } from './lib/r2.mjs';

const ARCHIVE_SUFFIX = '-full.jsonl.gz.enc';
const META_SUFFIX = '-full.meta.json';
const OBJECT = /^openpay-kv\/\d{4}\/\d{8}T\d{6}Z-r\d+-a(?:\d+|[a-f0-9]{8})-full\.(?:jsonl\.gz\.enc|meta\.json)$/;

export function validateMeta(meta, key) {
  const archiveKey = key.replace(/\.meta\.json$/, '.jsonl.gz.enc');
  const name = archiveKey.split('/').at(-1).slice(0, -ARCHIVE_SUFFIX.length);
  const counts = meta?.counts;
  const start = Date.parse(meta?.capture?.startedAt), finish = Date.parse(meta?.capture?.finishedAt);
  if (!OBJECT.test(key) || meta?.v !== 1 || meta.name !== name || meta.archiveKey !== archiveKey
    || !/^[a-f0-9]{64}$/.test(meta.ciphertextSha256 ?? '') || !/^[a-f0-9]{16}$/.test(meta.source?.hostSha256Hex16 ?? '')
    || !Number.isSafeInteger(meta.size) || meta.size < 42 || !Number.isFinite(start) || !Number.isFinite(finish) || finish < start
    || !counts || ['keys', 'errors', 'uncertain'].some((k) => !Number.isSafeInteger(counts[k]) || counts[k] < 0)
    || counts.errors + counts.uncertain > counts.keys || meta.status !== (counts.errors ? 'partial' : 'complete')) {
    throw new BackupError('invalid_meta');
  }
  return meta;
}

export async function watchBackups({ r2, env = process.env, now = new Date() } = {}) {
  r2 ??= createR2Client({ env });
  const year = now.getUTCFullYear();
  const years = now.getUTCMonth() === 0 ? [year, year - 1] : [year];
  const objects = [];
  for (const value of years) objects.push(...await r2.listObjects(`openpay-kv/${value}/`));
  const keys = [...new Set(objects.map((object) => object.key).filter((key) => OBJECT.test(key)))].sort().reverse();
  const metas = keys.filter((key) => key.endsWith(META_SUFFIX));
  if (!metas.length) throw new BackupError('no_meta');
  const directory = await mkdtemp(join(tmpdir(), 'openpay-kv-watch-'));
  const captured = new Map(), digests = new Map();
  let latest = -Infinity;
  try {
    for (let i = 0; i < metas.length; i++) {
      const file = join(directory, `${i}.json`);
      const digest = await r2.getObjectToFile(metas[i], file, { maxBytes: 1024 * 1024 });
      let meta;
      try { meta = JSON.parse(await readFile(file, 'utf8')); } catch { throw new BackupError('invalid_meta'); }
      validateMeta(meta, metas[i]);
      captured.set(metas[i], meta);
      digests.set(metas[i], digest);
      if (meta.status === 'complete') latest = Math.max(latest, Date.parse(meta.capture.finishedAt));
      await rm(file);
    }
    // Use both archive/meta identities so an archive-only failed run is visible too.
    const bases = [...new Set(keys.map((key) => key.replace(/-full\.(?:jsonl\.gz\.enc|meta\.json)$/, '')))];
    for (const base of bases.slice(0, 3)) {
      const archiveKey = `${base}${ARCHIVE_SUFFIX}`, metaKey = `${base}${META_SUFFIX}`;
      const archiveHead = await r2.headObject(archiveKey);
      await r2.headObject(metaKey, digests.get(metaKey));
      const meta = captured.get(metaKey);
      if (meta && archiveHead.size !== meta.size) throw new BackupError('archive_size_mismatch');
    }
    const ageMs = now.getTime() - latest;
    if (!Number.isFinite(latest) || ageMs > 26 * 60 * 60 * 1000 || ageMs < 0) throw new BackupError('stale_complete_backup');
    return { completeFinishedAt: new Date(latest).toISOString(), ageMs, metaCount: metas.length };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function main(args = process.argv.slice(2), { log = console.log, error = console.error, ...options } = {}) {
  try {
    if (args.length) throw new BackupError('invalid_arguments');
    log(JSON.stringify(await watchBackups(options)));
    return 0;
  } catch {
    error('::error::KV backup watch failed: no fresh complete backup or archive/meta storage check failed.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
