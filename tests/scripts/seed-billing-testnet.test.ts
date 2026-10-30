// @vitest-environment node
// scripts/seed-billing-testnet.mjs は meter:{前月}:{店主} を DEL してから testnet の 1 件を積み直す。
// SEED_TESTNET_OK=1 は運用者の自己申告でしかないので、既存の行に testnet (chainId 80002) 以外があれば
// 何も消さずに止まることを固定する (第 8 回レビュー F-3)。KV はローカルの偽 Upstash REST で、本物には触れない。
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SEED_TESTNET_CHAIN_ID,
  checkSeedMeterReplaceable,
  describeBlockingRows,
} from '@/scripts/lib/seedBillingGuard.mjs';

const script = resolve('scripts/seed-billing-testnet.mjs');
const MERCHANT = '0xAbCdEf0000000000000000000000000000000001';
const row = (c: unknown) => JSON.stringify({ v: '10000000000000000000000', c, t: 1_760_000_000_000 });

describe('checkSeedMeterReplaceable (DEL してよいかの判定)', () => {
  it('seed の chainId は Polygon Amoy (80002)', () => {
    expect(SEED_TESTNET_CHAIN_ID).toBe(80002);
  });

  it('空 (key が無い) なら消してよい', () => {
    expect(checkSeedMeterReplaceable([])).toEqual({ ok: true, total: 0, blocking: [] });
  });

  it('全行が chainId 80002 (前回の seed) なら消してよい = 再実行しても冪等', () => {
    expect(checkSeedMeterReplaceable([row(80002), row(80002)])).toEqual({ ok: true, total: 2, blocking: [] });
  });

  it('本番の chainId の行が 1 つでもあれば止める (Polygon 137 / Kaia 8217)', () => {
    const result = checkSeedMeterReplaceable([row(80002), row(137), row(8217), row(137)]);
    expect(result.ok).toBe(false);
    expect(result.total).toBe(4);
    expect(result.blocking).toEqual([
      { index: 1, chainId: 137 },
      { index: 2, chainId: 8217 },
      { index: 3, chainId: 137 },
    ]);
    expect(describeBlockingRows(result.blocking)).toBe('chainId 137 ×2・chainId 8217 ×1');
  });

  it('chain を確かめられない行 (JSON でない・c が無い・c が文字列・null) も止める', () => {
    const result = checkSeedMeterReplaceable([
      '{v:1,c:80002}',
      JSON.stringify({ v: '1', t: 1 }),
      row('80002'),
      'null',
    ]);
    expect(result.ok).toBe(false);
    expect(result.blocking.map((b) => b.chainId)).toEqual([null, null, null, null]);
    expect(describeBlockingRows(result.blocking)).toBe('読めない行 ×4');
  });

  it('LRANGE の応答が配列でなければ止める (中身を確かめられない)', () => {
    expect(checkSeedMeterReplaceable(null)).toEqual({ ok: false, total: 0, blocking: [] });
    expect(checkSeedMeterReplaceable('WRONGTYPE')).toEqual({ ok: false, total: 0, blocking: [] });
  });
});

describe('seed-billing-testnet.mjs の配線 (ローカルの偽 Upstash REST)', () => {
  let server: Server;
  let commands: string[][];
  let meterRows: string[];

  beforeEach(() => {
    commands = [];
    meterRows = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const command = (JSON.parse(body) as unknown[]).map(String);
        commands.push(command);
        const name = command[0];
        const result = name === 'LRANGE' ? meterRows : name === 'LLEN' ? meterRows.length : 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result }));
      });
    });
  });
  afterEach(async () => {
    await new Promise((done) => server.close(done));
  });

  function listen(): Promise<string> {
    return new Promise((done) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        done(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
      });
    });
  }

  function run(url: string, args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: resolve('.'),
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH ?? '',
          KV_REST_API_URL: url,
          KV_REST_API_TOKEN: 'test-token',
          SEED_TESTNET_OK: '1',
        },
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => done({ code, out }));
    });
  }

  const writes = () => commands.filter(([name]) => name === 'DEL' || name === 'LPUSH');

  it('--apply でも、本番の chainId の行があるメーターは DEL せずに exit 1', async () => {
    meterRows = [row(137), row(80002)];
    const { code, out } = await run(await listen(), [MERCHANT, '--apply']);
    expect(code).toBe(1);
    expect(out).toContain('何も消さずに止めます');
    expect(out).toContain('chainId 137 ×1');
    expect(commands.map(([name]) => name)).toEqual(['LRANGE']);
    expect(commands[0][1]).toMatch(new RegExp(`^meter:\\d{4}-\\d{2}:${MERCHANT.toLowerCase()}$`));
    expect(writes()).toEqual([]);
  });

  it('dry-run でも同じ判定で exit 1 (--apply すると止まることを先に知らせる)', async () => {
    meterRows = ['not json'];
    const { code, out } = await run(await listen(), [MERCHANT]);
    expect(code).toBe(1);
    expect(out).toContain('読めない行 ×1');
    expect(writes()).toEqual([]);
  });

  it('前回の seed (chainId 80002) だけなら従来どおり DEL → LPUSH で積み直す', async () => {
    meterRows = [row(80002)];
    const { code, out } = await run(await listen(), [MERCHANT, '--apply']);
    expect(code).toBe(0);
    expect(out).toContain('seeded meter:');
    const meterKey = commands[0][1];
    expect(commands.slice(0, 4).map(([name, key]) => [name, key])).toEqual([
      ['LRANGE', meterKey],
      ['DEL', meterKey],
      ['LPUSH', meterKey],
      ['LPUSH', expect.stringMatching(/^billing:merchants:\d{4}-\d{2}$/)],
    ]);
    expect(JSON.parse(commands[2][2])).toMatchObject({ c: 80002 });
  });
});
