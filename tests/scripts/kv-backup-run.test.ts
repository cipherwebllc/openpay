// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveIdentity, captureKey, captureRecords, main, parseArgs, probeTypes, runBackup, scanKeys } from '@/scripts/kv-backup.mjs';
import { LIMITS, PREFIXES, verifyArchive } from '@/scripts/lib/kv-backup-core.mjs';
import { createUpstashClient } from '@/scripts/lib/upstash-rest.mjs';
import { createR2Client, fileDigest } from '@/scripts/lib/r2.mjs';

type Argv = (string | number)[];
function wire(value: unknown): unknown {
  if (typeof value === 'string' || value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(wire);
  return value;
}
function redis(handler: (argv: Argv, transaction: number, phase: string) => unknown, keys = ['store:k']) {
  let transaction = 0;
  const requests: { phase: string; commands: Argv[] }[] = [];
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    const phase = new URL(url).pathname;
    const batch = phase === '/pipeline' || phase === '/multi-exec';
    const commands: Argv[] = batch ? JSON.parse(init.body) : [JSON.parse(init.body)];
    requests.push({ phase, commands });
    if (phase === '/multi-exec') transaction++;
    const results = commands.map((argv) => {
      let value = argv[0] === 'SCAN' ? ['0', keys.filter((key) => key.startsWith(String(argv[3]).slice(0, -1)))] : handler(argv, transaction, phase);
      if (value instanceof Response) return value;
      if (value instanceof Error) return { error: value.message };
      value = wire(value);
      return { result: value };
    });
    const failure = results.find((result) => result instanceof Response);
    return failure instanceof Response ? failure : new Response(JSON.stringify(batch ? results : results[0]));
  });
  return { client: createUpstashClient({ url: 'https://kv.test', token: 'PRIVATE_TOKEN', fetch }), fetch, requests };
}
const env = { KV_BACKUP_KEY: 'ab'.repeat(32), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const now = () => new Date('2026-09-15T03:17:00Z');
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'kv-run-test-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function all(records: AsyncIterable<unknown>) { const result = []; for await (const record of records) result.push(record); return result; }

describe('SCAN and TYPE phases', () => {
  it('scans and captures payer indexes and bindings with their original expiries', async () => {
    const keys = ['x402:settle:payer:buyer', 'agent:bound:buyer', 'agent:owner:owner'];
    const ttl = 400 * 24 * 60 * 60 * 1000;
    const fixture = redis((cmd) => {
      const payer = cmd[1] === keys[0];
      if (cmd[0] === 'TYPE') return payer ? 'list' : 'string';
      if (cmd[0] === 'PTTL') return payer ? ttl : -1;
      if (cmd[0] === 'LLEN') return 2;
      if (cmd[0] === 'LRANGE') return ['new purchase', 'old purchase'];
      if (cmd[0] === 'GET') return cmd[1] === keys[1] ? '{"owner":"owner"}' : '["buyer"]';
      throw new Error('unexpected command');
    }, keys);
    const records = await all(captureRecords(fixture.client, { now: () => 100 }));
    expect(records).toEqual([
      { k: keys[0], t: 'list', capturedAt: 100, expiresAt: 100 + ttl, l: ['new purchase', 'old purchase'] },
      { k: keys[1], t: 'string', capturedAt: 100, expiresAt: null, s: '{"owner":"owner"}' },
      { k: keys[2], t: 'string', capturedAt: 100, expiresAt: null, s: '["buyer"]' },
    ]);
  });
  it('handles duplicates, empty nonfinal pages, allowlist and denylist families', async () => {
    let scans = 0;
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const cmd = JSON.parse(init.body);
      expect(cmd[0]).toBe('SCAN'); expect(cmd[2]).toBe('MATCH'); expect(cmd.slice(-2)).toEqual(['COUNT', 500]);
      let result: unknown = ['0', []];
      if (cmd[3] === 'store:*') {
        scans++;
        result = scans === 1 ? ['9', []] : scans === 2 ? ['11', ['store:a', 'store:a', 'store:quote:rl', 'store:quote:rl:ip', 'session:a']]
          : ['0', ['store:a', 'store:quote:rlx', 'store:b']];
      }
      return new Response(JSON.stringify({ result: wire(result) }));
    });
    const client = createUpstashClient({ url: 'https://kv.test', token: 'token', fetch });
    expect((await scanKeys(client)).map((key: Uint8Array) => Buffer.from(key).toString())).toEqual(['store:a', 'store:quote:rlx', 'store:b']);
    expect(scans).toBe(3); expect(fetch).toHaveBeenCalledTimes(PREFIXES.length + 2);
  });
  it('halves SCAN count after a limit even on initial cursor 0', async () => {
    const counts: number[] = [];
    const client = createUpstashClient({ url: 'https://kv.test', token: 'token', fetch: async (_url: string, init: { body: string }) => {
      const cmd = JSON.parse(init.body); counts.push(cmd[5]);
      return cmd[5] > 250 ? new Response('', { status: 413 }) : new Response(JSON.stringify({ result: wire(['0', []]) }));
    } });
    expect(await scanKeys(client)).toEqual([]);
    expect(counts).toEqual(PREFIXES.flatMap(() => [500, 250]));
  });
  it('uses TYPE batches of 500 and preserves per-command errors', async () => {
    const fixture = redis((cmd) => cmd[1] === 'store:2' ? new Error('NOPERM denied') : 'string');
    const keys = Array.from({ length: 1001 }, (_, i) => Buffer.from(`store:${i}`));
    const types = await probeTypes(fixture.client, keys);
    expect(fixture.requests.map((r) => r.commands.length)).toEqual([500, 500, 1]);
    expect(types.get(keys[2].toString('base64'))).toBeInstanceOf(Error);
    expect(types.get(keys[3].toString('base64'))).toBe('string');
  });
  it('retries smaller TYPE batches on request budget failures', async () => {
    const sizes: number[] = [];
    const client = createUpstashClient({ url: 'https://kv.test', token: 'token', fetch: async (_url: string, init: { body: string }) => {
      const cmds = JSON.parse(init.body); sizes.push(cmds.length);
      return cmds.length > 250 ? new Response('', { status: 413 }) : new Response(JSON.stringify(cmds.map(() => ({ result: wire('string') }))));
    } });
    const types = await probeTypes(client, Array.from({ length: 501 }, (_, i) => Buffer.from(`store:${i}`)));
    expect(types.size).toBe(501); expect(sizes).toEqual([500, 250, 250, 1]);
  });
});

describe('atomic and chunked capture', () => {
  it.each([-1, 0, 5])('uses request-send time with PTTL=%s and preserves raw string bytes', async (pttl) => {
    let clock = 100;
    const fixture = redis((cmd) => {
      clock = 900;
      return cmd[0] === 'TYPE' ? 'string' : cmd[0] === 'PTTL' ? pttl : Buffer.from('\uFEFF{"raw":  true}\n');
    });
    const result = await captureKey(fixture.client, Buffer.from('store:k'), 'string', { now: () => clock });
    expect(result).toMatchObject({ capturedAt: 100, expiresAt: pttl === -1 ? null : 100 + pttl, s: '\uFEFF{"raw":  true}\n' });
    // 文字列の鍵は TYPE を入れない: 同じ transaction の GET が bytes を返すことが、その瞬間の型の証明になる。
    expect(fixture.requests).toEqual([{ phase: '/multi-exec', commands: [['PTTL', 'store:k'], ['GET', 'store:k']] }]);
  });
  it('counts Upstash commands for a run: one TYPE per key, then 2 per string and 3 per collection transaction', async () => {
    const keys = ['store:s1', 'store:s2', 'store:list'];
    const fixture = redis((cmd) => {
      const list = cmd[1] === 'store:list';
      if (cmd[0] === 'TYPE') return list ? 'list' : 'string';
      if (cmd[0] === 'PTTL') return -1;
      if (cmd[0] === 'LLEN') return 1;
      if (cmd[0] === 'LRANGE') return ['member'];
      if (cmd[0] === 'GET' && !list) return 'value';
      throw new Error('unexpected command');
    }, keys);
    expect((await all(captureRecords(fixture.client, { now: () => 1 }))).map((record) => (record as { t: string }).t)).toEqual(['string', 'string', 'list']);
    const sent = (phase: string) => fixture.requests.filter((request) => request.phase === phase).map((request) => request.commands.map((cmd) => cmd[0]));
    expect(sent('/')).toEqual(PREFIXES.map(() => ['SCAN']));
    expect(sent('/pipeline')).toEqual([['TYPE', 'TYPE', 'TYPE']]);
    // 文字列 2 つ = 2 コマンド × 2・list 1 つ = 3 コマンド × 2 (長さ → 全量)。transaction の数 (EXEC の数) は鍵の型で決まり、変わらない。
    expect(sent('/multi-exec')).toEqual([['PTTL', 'GET'], ['PTTL', 'GET'], ['TYPE', 'PTTL', 'LLEN'], ['TYPE', 'PTTL', 'LRANGE']]);
    expect(fixture.requests.flatMap((request) => request.commands)).toHaveLength(PREFIXES.length + keys.length + 2 * 2 + 3 * 2);
  });
  it.each(['list', 'set', 'zset', 'hash'])('rereads a small %s in one atomic transaction without uncertain', async (type) => {
    const values = type === 'zset' ? ['member', '1.2300'] : type === 'hash' ? ['field', 'value'] : ['member'];
    const fixture = redis((cmd) => cmd[0] === 'TYPE' ? type : cmd[0] === 'PTTL' ? 100 : ['LLEN', 'SCARD', 'ZCARD', 'HLEN'].includes(String(cmd[0])) ? 1 : values);
    const result = await captureKey(fixture.client, Buffer.from('store:k'), type, { now: () => 500 });
    expect(result).toMatchObject({ t: type, capturedAt: 500, expiresAt: 600 });
    expect(result.uncertain).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    const full = { list: ['LRANGE', 'store:k', 0, -1], set: ['SMEMBERS', 'store:k'], zset: ['ZRANGE', 'store:k', 0, -1, 'WITHSCORES'], hash: ['HGETALL', 'store:k'] }[type];
    expect(fixture.requests[1].commands[2]).toEqual(full);
  });
  it.each(['list', 'set', 'zset', 'hash'])('marks every chunked %s uncertain, even with unchanged length; dedupes SCAN members', async (type) => {
    const fixture = redis((cmd) => {
      if (cmd[0] === 'TYPE') return type;
      if (cmd[0] === 'PTTL') return -1;
      if (['LLEN', 'SCARD', 'ZCARD', 'HLEN'].includes(String(cmd[0]))) return 1001;
      if (cmd[0] === 'LRANGE') return [String(cmd[2])];
      if (cmd[0] === 'ZRANGE') { expect(cmd.at(-1)).toBe('WITHSCORES'); return [String(cmd[2]), '123']; }
      if (cmd[0] === 'SSCAN') return cmd[2] === '0' ? ['2', ['same', 'a']] : ['0', ['same', 'b']];
      if (cmd[0] === 'HSCAN') return cmd[2] === '0' ? ['2', ['same', 'old']] : ['0', ['same', 'new', 'b', 'value']];
      throw new Error('unexpected');
    });
    const result = await captureKey(fixture.client, Buffer.from('store:k'), type, { now: () => 10 });
    expect(result).toMatchObject({ t: type, uncertain: true });
    if (type === 'set') expect(result.m).toEqual(['same', 'a', 'b']);
    if (type === 'hash') expect(result.h).toEqual([['same', 'new'], ['b', 'value']]);
    if (type === 'list') expect(result.l).toEqual(['0', '1000']);
  });
  it('discards a large full response and switches to uncertain chunks', async () => {
    const fixture = redis((cmd) => cmd[0] === 'TYPE' ? 'list' : cmd[0] === 'PTTL' ? -1 : cmd[0] === 'LLEN' ? 2
      : [Buffer.alloc(600_000, 97), Buffer.alloc(600_000, 98)]);
    const result = await captureKey(fixture.client, Buffer.from('store:k'), 'list');
    expect(result).toMatchObject({ t: 'list', uncertain: true });
    expect(fixture.requests.map((r) => r.commands[2][0])).toEqual(['LLEN', 'LRANGE', 'LRANGE', 'LLEN']);
  });
  it('halves chunks for 413/max request size down to 50, then records oversized', async () => {
    const counts: number[] = [];
    const fixture = redis((cmd) => {
      if (cmd[0] === 'TYPE') return 'set'; if (cmd[0] === 'PTTL') return -1; if (cmd[0] === 'SCARD') return 1001;
      counts.push(Number(cmd[4])); return new Error('max request size exceeded');
    });
    expect(await captureKey(fixture.client, Buffer.from('store:k'), 'set')).toEqual({ k: 'store:k', error: 'oversized' });
    expect(counts).toEqual([1000, 500, 250, 125, 62, 50]);
  });
  it('can finish after reducing the initial SSCAN chunk', async () => {
    const fixture = redis((cmd) => cmd[0] === 'TYPE' ? 'set' : cmd[0] === 'PTTL' ? -1 : cmd[0] === 'SCARD' ? 1001
      : Number(cmd[4]) > 500 ? new Response('', { status: 413 }) : ['0', ['a']]);
    expect(await captureKey(fixture.client, Buffer.from('store:k'), 'set')).toMatchObject({ uncertain: true, m: ['a'] });
  });
  it('records oversized strings, missing keys, unsupported types and per-key read failures', async () => {
    const cases = [
      { type: 'string', pttl: -1, value: Buffer.alloc(LIMITS.stringMax + 1, 97), error: 'oversized' },
      { type: 'string', pttl: -2, value: null, error: 'missing_during_capture' },
      { type: 'stream', pttl: -1, value: null, error: 'unsupported_type' },
      { type: 'string', pttl: -1, value: new Error('NOPERM PRIVATE_TOKEN'), error: 'read_error' },
    ];
    for (const item of cases) {
      const fixture = redis((cmd) => cmd[0] === 'TYPE' ? item.type : cmd[0] === 'PTTL' ? item.pttl : item.value);
      expect(await captureKey(fixture.client, Buffer.from('store:k'), item.type)).toEqual({ k: 'store:k', error: item.error });
    }
  });
  it('reclassifies type once, discards prior data, and fails a second change', async () => {
    for (const twice of [false, true]) {
      const fixture = redis((cmd, transaction) => {
        if (cmd[0] === 'TYPE') return twice && transaction > 1 ? 'hash' : 'list';
        if (cmd[0] === 'PTTL') return -1;
        if (cmd[0] === 'GET') return new Error('WRONGTYPE');
        if (cmd[0] === 'LLEN') return 1;
        return ['new'];
      });
      const result = await captureKey(fixture.client, Buffer.from('store:k'), 'string');
      expect(result).toMatchObject(twice ? { error: 'type_changed' } : { t: 'list', l: ['new'] });
    }
  });
  it.each(['in position', 'for the whole transaction'])('retakes TYPE once when a string key answers WRONGTYPE %s, then captures the new type atomically', async (shape) => {
    const fixture = redis((cmd) => {
      if (cmd[0] === 'GET') {
        return shape === 'in position' ? new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
          : new Response(JSON.stringify({ error: 'WRONGTYPE Operation against a key holding the wrong kind of value' }));
      }
      if (cmd[0] === 'TYPE') return 'hash';
      if (cmd[0] === 'PTTL') return 700;
      if (cmd[0] === 'HLEN') return 1;
      return ['field', 'value'];
    });
    const result = await captureKey(fixture.client, Buffer.from('store:k'), 'string', { now: () => 300 });
    expect(result).toEqual({ k: 'store:k', t: 'hash', capturedAt: 300, expiresAt: 1000, h: [['field', 'value']] });
    expect(fixture.requests).toEqual([
      { phase: '/multi-exec', commands: [['PTTL', 'store:k'], ['GET', 'store:k']] },
      { phase: '/', commands: [['TYPE', 'store:k']] },
      { phase: '/multi-exec', commands: [['TYPE', 'store:k'], ['PTTL', 'store:k'], ['HLEN', 'store:k']] },
      { phase: '/multi-exec', commands: [['TYPE', 'store:k'], ['PTTL', 'store:k'], ['HGETALL', 'store:k']] },
    ]);
  });
  it('follows the retaken TYPE after WRONGTYPE: none → missing, string → one more atomic string read, failure → read_error', async () => {
    const cases = [
      { retaken: 'none', expected: { k: 'store:k', error: 'missing_during_capture' }, transactions: 1 },
      { retaken: 'string', expected: { k: 'store:k', t: 'string', capturedAt: 5, expiresAt: null, s: 'back again' }, transactions: 2 },
      { retaken: 'stream', expected: { k: 'store:k', error: 'unsupported_type' }, transactions: 1 },
      { retaken: new Error('NOPERM PRIVATE_TOKEN'), expected: { k: 'store:k', error: 'read_error' }, transactions: 1 },
    ];
    for (const item of cases) {
      const fixture = redis((cmd, transaction) => {
        if (cmd[0] === 'TYPE') return item.retaken;
        if (cmd[0] === 'PTTL') return -1;
        return transaction === 1 ? new Error('WRONGTYPE') : 'back again';
      });
      expect(await captureKey(fixture.client, Buffer.from('store:k'), 'string', { now: () => 5 })).toEqual(item.expected);
      expect(fixture.requests.filter((request) => request.phase === '/').map((request) => request.commands)).toEqual([[['TYPE', 'store:k']]]);
      expect(fixture.requests.filter((request) => request.phase === '/multi-exec')).toHaveLength(item.transactions);
    }
  });
  it('ends with type_changed, without another TYPE, when the retried string read answers WRONGTYPE again', async () => {
    // 1 回目: list のつもりで読むと string に変わっていた → 2 回目: string として読むと、また別の型に変わっていた。
    const viaCollection = redis((cmd) => cmd[0] === 'TYPE' ? 'string' : cmd[0] === 'PTTL' ? -1 : cmd[0] === 'GET' ? new Error('WRONGTYPE') : 1);
    expect(await captureKey(viaCollection.client, Buffer.from('store:k'), 'list')).toEqual({ k: 'store:k', error: 'type_changed' });
    expect(viaCollection.requests.map((request) => [request.phase, request.commands.map((cmd) => cmd[0])])).toEqual([
      ['/multi-exec', ['TYPE', 'PTTL', 'LLEN']], ['/multi-exec', ['PTTL', 'GET']],
    ]);
    // 1 回目も 2 回目も string として読んで WRONGTYPE (取り直した TYPE は string): TYPE は 1 回だけ。
    const viaString = redis((cmd) => cmd[0] === 'TYPE' ? 'string' : cmd[0] === 'PTTL' ? -1 : new Error('WRONGTYPE'));
    expect(await captureKey(viaString.client, Buffer.from('store:k'), 'string')).toEqual({ k: 'store:k', error: 'type_changed' });
    expect(viaString.requests.map((request) => [request.phase, request.commands.map((cmd) => cmd[0])])).toEqual([
      ['/multi-exec', ['PTTL', 'GET']], ['/', ['TYPE']], ['/multi-exec', ['PTTL', 'GET']],
    ]);
  });
  it('does not retake TYPE for string read failures other than WRONGTYPE, and reads a vanished key from PTTL alone', async () => {
    const cases = [
      { pttl: -1, value: new Error('NOPERM PRIVATE_TOKEN'), error: 'read_error' },
      { pttl: new Error('NOPERM PRIVATE_TOKEN'), value: 'raw', error: 'read_error' },
      { pttl: -1, value: new Error('max response size exceeded'), error: 'oversized' },
      { pttl: -2, value: null, error: 'missing_during_capture' },
      { pttl: -3, value: 'raw', error: 'read_error' },
      { pttl: -1, value: null, error: 'read_error' },
    ];
    for (const item of cases) {
      const fixture = redis((cmd) => cmd[0] === 'PTTL' ? item.pttl : cmd[0] === 'GET' ? item.value : new Error('unexpected command'));
      expect(await captureKey(fixture.client, Buffer.from('store:k'), 'string')).toEqual({ k: 'store:k', error: item.error });
      expect(fixture.requests.map((request) => request.phase)).toEqual(['/multi-exec']);
    }
    // 送った 2 コマンドと数が合わない応答は、値の位置を信じない。
    const extra = { host: 'kv.test', command: async () => null, pipeline: async () => [],
      multiExec: async () => [-1, Buffer.from('raw'), Buffer.from('extra')] };
    expect(await captureKey(extra, Buffer.from('store:k'), 'string')).toEqual({ k: 'store:k', error: 'read_error' });
    // 期限の error より先に、型が変わったこと (WRONGTYPE) を見る (TYPE を中に入れていたときと同じ順)。
    const both = redis((cmd) => cmd[0] === 'PTTL' ? new Error('NOPERM') : cmd[0] === 'GET' ? new Error('WRONGTYPE') : 'none');
    expect(await captureKey(both.client, Buffer.from('store:k'), 'string')).toEqual({ k: 'store:k', error: 'missing_during_capture' });
  });
  it('detects expiry at final collection check and keeps binary keys as explicit errors', async () => {
    const fixture = redis((cmd, tx) => cmd[0] === 'TYPE' ? (tx >= 3 ? 'none' : 'list') : cmd[0] === 'PTTL' ? (tx >= 3 ? -2 : -1) : cmd[0] === 'LLEN' ? 1001 : ['a']);
    expect(await captureKey(fixture.client, Buffer.from('store:k'), 'list')).toMatchObject({ error: 'missing_during_capture' });
    const binary = Buffer.concat([Buffer.from('store:'), Buffer.from([255])]);
    expect(await captureKey(fixture.client, binary, 'string')).toEqual({ k: { b: binary.toString('base64') }, error: 'read_error' });
  });
});

describe('run / verify / workflows', () => {
  it.each([false, true])('stores and HEAD-verifies archive then public meta before partial=%s exit status', async (partial) => {
    const fixture = redis((cmd) => cmd[0] === 'TYPE' ? 'string' : cmd[0] === 'PTTL' ? -1 : partial ? new Error('NOPERM') : 'sensitive signed tx');
    const stored = new Map<string, Buffer>();
    const operations: string[] = [];
    const r2 = createR2Client({ env: { R2_ACCOUNT_ID: 'account', R2_BUCKET: 'backup', R2_ACCESS_KEY_ID: 'ACCESS', R2_SECRET_ACCESS_KEY: 'SECRET' },
      fetch: async (url: string, init: { method: string; body?: AsyncIterable<Buffer> }) => {
        const key = new URL(url).pathname; operations.push(`${init.method} ${key}`);
        if (init.body) { const chunks = []; for await (const chunk of init.body) chunks.push(Buffer.from(chunk)); stored.set(key, Buffer.concat(chunks)); }
        const bytes = stored.get(key)!;
        const { createHash } = await import('node:crypto');
        return new Response(null, { headers: { ETag: `"${createHash('md5').update(bytes).digest('hex')}"`, 'Content-Length': String(bytes.length) } });
      } });
    const log = vi.fn(), error = vi.fn();
    expect(await main(['--out', dir], { env, client: fixture.client, r2, now, log, error })).toBe(partial ? 1 : 0);
    expect(operations.map((op) => op.split(' ')[0])).toEqual(['PUT', 'HEAD', 'PUT', 'HEAD']);
    expect(operations[0]).toContain('.jsonl.gz.enc'); expect(operations[2]).toContain('.meta.json');
    const meta = JSON.parse([...stored.values()][1].toString());
    expect(meta.status).toBe(partial ? 'partial' : 'complete');
    expect(JSON.stringify(meta)).not.toContain('sensitive signed tx');
    const archive = join(dir, `${meta.name}-full.jsonl.gz.enc`);
    expect((await verifyArchive(archive, env.KV_BACKUP_KEY)).footer.status).toBe(meta.status);
    const verifyLog = vi.fn();
    expect(await main(['--verify', archive], { env: { KV_BACKUP_KEY: env.KV_BACKUP_KEY }, log: verifyLog, error })).toBe(0);
    expect(verifyLog.mock.calls[0][0]).toContain('"store:":1');
    expect(JSON.stringify([log.mock.calls, error.mock.calls, verifyLog.mock.calls])).not.toContain('sensitive signed tx');
    if (partial) expect(error).toHaveBeenCalledWith(expect.stringContaining('::error::'));
  });
  it('dry-run reads only KV, emits a local archive/meta, and does not initialize R2', async () => {
    const fixture = redis((cmd) => cmd[0] === 'TYPE' ? 'string' : cmd[0] === 'PTTL' ? -1 : 'raw');
    const r2 = { putObject: vi.fn(), headObject: vi.fn() };
    const result = await runBackup({ env, client: fixture.client, r2, dryRun: true, out: dir, now });
    expect(result.exitCode).toBe(0); expect(r2.putObject).not.toHaveBeenCalled();
    expect(await fileDigest(result.archiveFile)).toMatchObject({ sha256: result.meta.ciphertextSha256 });
    expect(JSON.parse(await readFile(result.metaFile, 'utf8'))).toEqual(result.meta);
    expect(fixture.requests.flatMap((request) => request.commands.map((cmd) => cmd[0])).every((cmd) => ['SCAN', 'TYPE', 'PTTL', 'GET'].includes(String(cmd)))).toBe(true);
  });
  it('does not publish meta or report success when archive HEAD fails', async () => {
    const fixture = redis(() => null, []);
    const r2 = { putObject: vi.fn(async (file: string) => fileDigest(file)), headObject: vi.fn(async () => { throw new Error('SECRET'); }) };
    const error = vi.fn();
    expect(await main(['--out', dir], { env, client: fixture.client, r2, now, log: vi.fn(), error })).toBe(1);
    expect(r2.putObject).toHaveBeenCalledTimes(1); expect(error.mock.calls[0][0]).not.toContain('SECRET');
  });
  it('propagates pipeline key errors into partial records, not successful omissions', async () => {
    const fixture = redis(() => new Error('NOPERM denied'));
    expect(await all(captureRecords(fixture.client))).toEqual([{ k: 'store:k', error: 'read_error' }]);
  });
  it('validates CLI options and creates collision-resistant rerun/local names', () => {
    expect(parseArgs(['run', '--dry-run', '--out', '/tmp/output'])).toEqual({ dryRun: true, out: '/tmp/output' });
    for (const args of [['--verify'], ['--out'], ['--force'], ['--dry-run', '--verify', 'x'], ['--out', 'x', '--out', 'y'], ['--verify', 'x', '--out', 'y']]) expect(() => parseArgs(args)).toThrow();
    expect(archiveIdentity(env, now()).archiveKey).toBe('openpay-kv/2026/20260915T031700Z-r123-a1-full.jsonl.gz.enc');
    expect(archiveIdentity({}, now()).name).toMatch(/^20260915T031700Z-r0-a[a-f0-9]{8}$/);
    expect(archiveIdentity({}, now()).name).not.toBe(archiveIdentity({}, now()).name);
    expect(archiveIdentity({ ...env, GITHUB_RUN_ATTEMPT: '2' }, now()).name).not.toBe(archiveIdentity(env, now()).name);
  });
  it('keeps dependency-free workflows, schedules, secrets and operational docs synchronized', async () => {
    const backup = await readFile('.github/workflows/kv-backup.yml', 'utf8');
    const watch = await readFile('.github/workflows/kv-backup-watch.yml', 'utf8');
    expect(backup).toContain("cron: '17 3 * * *'"); expect(watch).toContain("cron: '47 3,9,15,21 * * *'");
    for (const workflow of [backup, watch]) {
      expect(workflow).toContain("node-version: '22'"); expect(workflow).toContain('cancel-in-progress: false');
      expect(workflow).toContain('timeout-minutes: 30'); expect(workflow).toContain('::error::'); expect(workflow).not.toContain('npm ci');
    }
    const example = await readFile('.env.local.example', 'utf8'), readme = await readFile('docs/ENV.md', 'utf8');
    for (const key of ['KV_BACKUP_REST_URL', 'KV_BACKUP_REST_TOKEN', 'KV_BACKUP_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'KV_RESTORE_TARGET_TOKEN']) {
      expect(example).toContain(`# ${key}=`); expect(readme).toContain(`\`${key}\``);
    }
    expect(watch).not.toContain('KV_BACKUP_KEY');
  });
});
