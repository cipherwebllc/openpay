// A1: burn-intent marker と再開判定のテスト。
//
// classifyBurnState は純粋関数なので決定表 (設計 §4) の全行を RPC mock 無しで網羅する。
// scanForBurnLog は getLogs / getTransaction / getTransactionReceipt の 3 本だけを mock し、
// 「過去の同額 burn を拾わない」「複数一致は manual に渡す」「範囲は有界」を検証する。

import { describe, it, expect, vi } from 'vitest';
import { encodeAbiParameters, getAddress, pad, type Address, type Hex } from 'viem';
import {
  blockTimeMs,
  buildBurnMarker,
  burnScanCapBlocks,
  classifyBurnState,
  isRangeError,
  isRateLimitError,
  minGapBlocks,
  normalizeBurnTxHash,
  reorgMarginBlocks,
  scanForBurnLog,
  verifyBurnTxHash,
  MAX_SCAN_CALLS,
  MIN_GAP_MS,
  type BurnIntentMarker,
  type BurnScanResult,
  type ClassifyBurnStateInput,
} from '@/lib/crossChain/burnMarker';
import { CCTP_V2_DEPOSIT_FOR_BURN_TOPIC0 } from '@/lib/crossChain/cctp';

const DEPOSITOR = getAddress('0x1234567890123456789012345678901234567890');
const BURN_TOKEN = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const RECIPIENT = getAddress('0x000000000000000000000000000000000000aBcd');
const OTHER_RECIPIENT = getAddress('0x000000000000000000000000000000000000bEEf');
const MESSENGER = getAddress('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
const HASH_A = '0xaaaa' as Hex;
const HASH_B = '0xbbbb' as Hex;
const HASH_OLD = '0xcccc' as Hex;

function marker(over: Partial<BurnIntentMarker> = {}): BurnIntentMarker {
  return {
    v: 1,
    chainId: 84532, // Base Sepolia (2s block)
    block: '1000',
    nonceLatest: 5,
    noncePending: 5,
    at: 0,
    depositor: DEPOSITOR,
    burnToken: BURN_TOKEN,
    mintRecipient: RECIPIENT,
    amount: '9900000',
    destinationDomain: 7,
    ...over,
  };
}

const ok = (matches: Hex[]): BurnScanResult => ({ status: 'ok', matches });
const RANGE: BurnScanResult = { status: 'range' };

function classify(over: Partial<ClassifyBurnStateInput>): ReturnType<typeof classifyBurnState> {
  return classifyBurnState({
    marker: marker(),
    hash: undefined,
    receipt: undefined,
    pendingAhead: false,
    nonceAdvanced: false,
    gapSatisfied: false,
    // 既定は「marker から十分時間が経った」= 二段確認の時間条件は満たす状態。
    timeGapSatisfied: true,
    scan: ok([]),
    autoReburnEnabled: true, // 決定表そのものの検証では flag ON (OFF の効果は別 describe)
    allowManualReburn: false,
    ...over,
  });
}

describe('lib/crossChain/burnMarker: classifyBurnState 決定表 (設計 §4)', () => {
  // 表の 1 行 = 1 ケース。row 21 (transport 障害 → throw) は probe 側の責務なのでここには無い。
  const rows: Array<{
    row: number;
    name: string;
    input: Partial<ClassifyBurnStateInput>;
    expect: { action: string; hash?: Hex };
  }> = [
    {
      row: 1,
      name: '初回 (marker も hash も無い) → burn',
      input: { marker: undefined, hash: undefined, scan: undefined },
      expect: { action: 'burn' },
    },
    {
      row: 2,
      name: '旧 state (marker 無し) + hash success → proceed',
      input: { marker: undefined, hash: HASH_A, receipt: 'success', scan: undefined },
      expect: { action: 'proceed', hash: HASH_A },
    },
    {
      row: 3,
      name: '旧 state + hash reverted → manual (走査範囲不明)',
      input: { marker: undefined, hash: HASH_A, receipt: 'reverted', scan: undefined },
      expect: { action: 'manual' },
    },
    {
      row: 4,
      name: 'marker.block=null → manual (走査範囲不明)',
      input: { marker: marker({ block: null }), scan: undefined },
      expect: { action: 'manual' },
    },
    {
      row: 5,
      name: 'marker のみ + mempool 有り → wait (絶対に再 burn しない)',
      input: { pendingAhead: true, scan: undefined },
      expect: { action: 'wait' },
    },
    {
      row: 6,
      name: 'marker のみ + 一致 log 2 件 → manual (同定不能)',
      input: { scan: ok([HASH_A, HASH_B]) },
      expect: { action: 'manual' },
    },
    {
      row: 7,
      name: 'marker のみ + 一致 log 1 件 → adopt',
      input: { scan: ok([HASH_A]) },
      expect: { action: 'adopt', hash: HASH_A },
    },
    {
      row: 8,
      name: 'marker のみ + nonce 進行 + log 無し → manual',
      input: { nonceAdvanced: true, gapSatisfied: true },
      expect: { action: 'manual' },
    },
    {
      row: 9,
      name: 'marker のみ + nonce 不変 + mempool 空 + log 無し + gap 充足 → burn (唯一の auto 再 burn)',
      input: { gapSatisfied: true },
      expect: { action: 'burn' },
    },
    {
      row: 10,
      name: 'marker のみ + gap 未充足 → wait',
      input: { gapSatisfied: false },
      expect: { action: 'wait' },
    },
    {
      row: 11,
      name: 'marker + hash success → proceed',
      input: { hash: HASH_A, receipt: 'success', scan: undefined },
      expect: { action: 'proceed', hash: HASH_A },
    },
    {
      row: 12,
      name: 'marker + hash reverted + mempool 空 + log 無し → burn',
      input: { hash: HASH_A, receipt: 'reverted' },
      expect: { action: 'burn' },
    },
    {
      row: 13,
      name: 'marker + hash reverted + 一致 log 1 件 → adopt (別 nonce の再送が成功)',
      input: { hash: HASH_A, receipt: 'reverted', scan: ok([HASH_B]) },
      expect: { action: 'adopt', hash: HASH_B },
    },
    {
      row: 14,
      name: 'marker + hash reverted + mempool 有り → wait',
      input: { hash: HASH_A, receipt: 'reverted', pendingAhead: true, scan: undefined },
      expect: { action: 'wait' },
    },
    {
      row: 15,
      name: 'marker + hash reverted + 一致 log 2 件 → manual',
      input: { hash: HASH_A, receipt: 'reverted', scan: ok([HASH_A, HASH_B]) },
      expect: { action: 'manual' },
    },
    {
      row: 16,
      name: 'marker + hash notfound + 一致 log 1 件 → adopt (speed-up で hash が変わった)',
      input: { hash: HASH_A, receipt: 'notfound', scan: ok([HASH_B]) },
      expect: { action: 'adopt', hash: HASH_B },
    },
    {
      row: 17,
      name: 'marker + hash notfound + mempool 有り → wait (未 mine)',
      input: { hash: HASH_A, receipt: 'notfound', pendingAhead: true, scan: undefined },
      expect: { action: 'wait' },
    },
    {
      row: 18,
      name: 'marker + hash notfound + nonce 不変 + gap 充足 + log 無し → burn (dropped)',
      input: { hash: HASH_A, receipt: 'notfound', gapSatisfied: true },
      expect: { action: 'burn' },
    },
    {
      row: 19,
      name: 'marker + hash notfound + nonce 進行 + log 無し → manual',
      input: { hash: HASH_A, receipt: 'notfound', nonceAdvanced: true, gapSatisfied: true },
      expect: { action: 'manual' },
    },
    {
      row: 20,
      name: '走査範囲 cap 超過 → manual (throw しない)',
      input: { hash: HASH_A, receipt: 'notfound', scan: RANGE },
      expect: { action: 'manual' },
    },
  ];

  for (const r of rows) {
    it(`row ${r.row}: ${r.name}`, () => {
      const d = classify(r.input);
      expect(d.action).toBe(r.expect.action);
      expect(d.row).toBe(r.row);
      if (r.expect.hash) {
        expect((d as { hash: Hex }).hash).toBe(r.expect.hash);
      }
    });
  }

  it('決定表 20 行すべてを網羅している (行の取りこぼし検出)', () => {
    expect(rows.map((r) => r.row)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });
});

describe('lib/crossChain/burnMarker: mempool (P=true) は決して burn にならない', () => {
  // 残存リスクの核心。pending nonce が latest より先行している間は、どの入力の組合せでも
  // 再 burn を出してはいけない (row 5 / 14 / 17)。
  const receipts: Array<'reverted' | 'notfound' | undefined> = [
    undefined,
    'reverted',
    'notfound',
  ];
  for (const receipt of receipts) {
    for (const gapSatisfied of [true, false]) {
      for (const nonceAdvanced of [true, false]) {
        it(`receipt=${receipt ?? 'none'} gap=${gapSatisfied} nonce=${nonceAdvanced} → burn ではない`, () => {
          const d = classify({
            hash: receipt ? HASH_A : undefined,
            receipt,
            pendingAhead: true,
            gapSatisfied,
            nonceAdvanced,
            scan: undefined,
            allowManualReburn: true, // 二段確認済みでも mempool 有りなら拒否する
          });
          expect(d.action).toBe('wait');
        });
      }
    }
  }

  // D1: row 3 (旧 state) / row 4 (marker.block=null) は決定表の上で pendingAhead 判定より
  // **前** に返るため、「二段確認 (allowManualReburn) さえ通れば burn」を許すと mempool に
  // burn が居ても再 burn してしまう。marker の有無・block の有無に関わらず、mempool 有りの
  // 間は burn を出さないことを固定する。
  const preemptiveRows: Array<{ name: string; input: Partial<ClassifyBurnStateInput> }> = [
    {
      name: 'row 3 (marker 無し + hash reverted)',
      input: { marker: undefined, hash: HASH_A, receipt: 'reverted' as const },
    },
    {
      name: 'row 3 (marker 無し + hash notfound)',
      input: { marker: undefined, hash: HASH_A, receipt: 'notfound' as const },
    },
    {
      name: 'row 4 (marker.block=null)',
      input: { marker: marker({ block: null }) },
    },
    {
      name: 'row 4 (marker.nonceLatest=null)',
      input: { marker: marker({ nonceLatest: null }) },
    },
  ];
  for (const { name, input } of preemptiveRows) {
    it(`${name} + mempool 有り + 二段確認済み → burn ではない`, () => {
      const d = classify({
        ...input,
        pendingAhead: true,
        scan: undefined,
        allowManualReburn: true,
        autoReburnEnabled: true,
      });
      expect(d.action).not.toBe('burn');
      expect((d as { reburnable?: boolean }).reburnable ?? false).toBe(false);
    });
  }

  it('pendingAhead が未計測 (undefined) なら二段確認でも burn しない', () => {
    // 「計測していない」を「mempool は空」に潰さない (D1)。
    const d = classify({
      marker: undefined,
      hash: HASH_A,
      receipt: 'reverted',
      pendingAhead: undefined,
      scan: undefined,
      allowManualReburn: true,
      autoReburnEnabled: true,
    });
    expect(d.action).toBe('manual');
    expect((d as { reburnable: boolean }).reburnable).toBe(false);
  });
});

describe('lib/crossChain/burnMarker: 二段確認で開ける条件 (D1)', () => {
  it('row 3 (旧 state) は mempool 実測が取れていれば開く', () => {
    const d = classify({
      marker: undefined,
      hash: HASH_A,
      receipt: 'reverted',
      pendingAhead: false,
      scan: undefined,
      allowManualReburn: false,
    });
    expect(d).toMatchObject({ action: 'manual', row: 3, reburnable: true });
  });

  it('row 4 は marker からの最小経過時間が未達なら開かない', () => {
    const d = classify({
      marker: marker({ block: null }),
      scan: undefined,
      timeGapSatisfied: false,
      allowManualReburn: true,
    });
    expect(d.action).toBe('manual');
    expect((d as { reburnable: boolean }).reburnable).toBe(false);
  });

  it('row 4 は mempool 実測 + gap 経過なら開く', () => {
    const d = classify({
      marker: marker({ block: null }),
      scan: undefined,
      pendingAhead: false,
      timeGapSatisfied: true,
      allowManualReburn: true,
    });
    expect(d).toMatchObject({ action: 'burn', row: 4 });
  });

  it('row 20 (走査 cap 超過) は「見ていない」ので二段確認でも開かない', () => {
    const d = classify({
      hash: HASH_A,
      receipt: 'notfound',
      scan: RANGE,
      allowManualReburn: true,
    });
    expect(d.action).toBe('manual');
    expect(d.row).toBe(20);
    expect((d as { reburnable: boolean }).reburnable).toBe(false);
  });

  it('row 22: 走査が rate limit で失敗 → manual ではなく wait (一過性)', () => {
    const d = classify({
      hash: HASH_A,
      receipt: 'notfound',
      scan: { status: 'ratelimited' },
      allowManualReburn: true,
    });
    expect(d).toMatchObject({ action: 'wait', row: 22 });
  });
});

describe('lib/crossChain/burnMarker: auto 再 burn flag (既定 OFF)', () => {
  const autoRows = [
    { row: 9, input: { gapSatisfied: true } },
    { row: 12, input: { hash: HASH_A, receipt: 'reverted' as const } },
    {
      row: 18,
      input: { hash: HASH_A, receipt: 'notfound' as const, gapSatisfied: true },
    },
  ];

  for (const { row, input } of autoRows) {
    it(`row ${row}: flag ON なら burn`, () => {
      expect(classify({ ...input, autoReburnEnabled: true }).action).toBe('burn');
    });
    it(`row ${row}: flag OFF なら manual (再 burn しない)`, () => {
      const d = classify({ ...input, autoReburnEnabled: false });
      expect(d.action).toBe('manual');
      expect((d as { reburnable: boolean }).reburnable).toBe(true);
    });
    it(`row ${row}: flag OFF + 二段確認済みなら burn`, () => {
      const d = classify({
        ...input,
        autoReburnEnabled: false,
        allowManualReburn: true,
      });
      expect(d.action).toBe('burn');
    });
  }

  it('一致 log 2 件の manual は二段確認でも開かない (人間の申告より on-chain を優先)', () => {
    const d = classify({
      scan: ok([HASH_A, HASH_B]),
      autoReburnEnabled: false,
      allowManualReburn: true,
    });
    expect(d.action).toBe('manual');
    expect((d as { reburnable: boolean }).reburnable).toBe(false);
  });

  it('一致 log 1 件は flag に関係なく adopt (再 burn しない)', () => {
    expect(classify({ scan: ok([HASH_A]), autoReburnEnabled: false }).action).toBe(
      'adopt',
    );
    expect(classify({ scan: ok([HASH_A]), autoReburnEnabled: true }).action).toBe(
      'adopt',
    );
  });

  it('marker.nonceLatest=null も走査条件を欠くので manual (block=null と同じ扱い)', () => {
    const d = classify({ marker: marker({ nonceLatest: null }), scan: undefined });
    expect(d.action).toBe('manual');
    expect(d.row).toBe(4);
  });
});

// ---- chain 別パラメータ ------------------------------------------------------

describe('lib/crossChain/burnMarker: chain 別の走査 cap / gap', () => {
  it('設計 §5 の表どおりの cap (2h 相当・24,000 block で clamp)', () => {
    expect(burnScanCapBlocks(1)).toBe(600); // Ethereum 12s
    expect(burnScanCapBlocks(137)).toBe(3_600); // Polygon 2s
    expect(burnScanCapBlocks(8453)).toBe(3_600); // Base 2s
    expect(burnScanCapBlocks(130)).toBe(7_200); // Unichain 1s
    expect(burnScanCapBlocks(1329)).toBe(18_000); // Sei 0.4s
    expect(burnScanCapBlocks(42161)).toBe(24_000); // Arbitrum 0.25s → clamp
  });

  it('未知 chainId は 2s 既定 (fail-closed 側: cap が小さく manual に倒れる)', () => {
    expect(blockTimeMs(999_999)).toBe(2_000);
    expect(burnScanCapBlocks(999_999)).toBe(3_600);
  });

  it('MIN_GAP_BLOCKS は 60 秒相当で 3〜500 に clamp、REORG_MARGIN は 120 秒相当で 8〜600', () => {
    expect(minGapBlocks(1)).toBe(5);
    expect(minGapBlocks(8453)).toBe(30);
    expect(minGapBlocks(42161)).toBe(240);
    expect(reorgMarginBlocks(1)).toBe(10);
    expect(reorgMarginBlocks(8453)).toBe(60);
    expect(reorgMarginBlocks(42161)).toBe(480);
    expect(MIN_GAP_MS).toBe(90_000);
  });
});

// ---- marker 生成 -------------------------------------------------------------

describe('lib/crossChain/burnMarker: buildBurnMarker', () => {
  it('head / nonce を取り込み、bigint は 10 進文字列で持つ (JSON 化可能)', async () => {
    const client = {
      getBlockNumber: vi.fn(async () => 12_345n),
      getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) =>
        blockTag === 'pending' ? 8 : 7,
      ),
    };
    const m = await buildBurnMarker({
      client: client as never,
      chainId: 84532,
      depositor: DEPOSITOR,
      burnToken: BURN_TOKEN,
      mintRecipient: RECIPIENT,
      amount: 9_900_000n,
      destinationDomain: 7,
      now: () => 1_700_000_000_000,
    });
    expect(m).toEqual({
      v: 1,
      chainId: 84532,
      block: '12345',
      nonceLatest: 7,
      noncePending: 8,
      at: 1_700_000_000_000,
      depositor: DEPOSITOR,
      burnToken: BURN_TOKEN,
      mintRecipient: RECIPIENT,
      amount: '9900000',
      destinationDomain: 7,
    });
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('RPC 障害でも marker は書く (block/nonce=null → 再開時は manual に倒れる)', async () => {
    const client = {
      getBlockNumber: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      getTransactionCount: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    };
    const m = await buildBurnMarker({
      client: client as never,
      chainId: 84532,
      depositor: DEPOSITOR,
      burnToken: BURN_TOKEN,
      mintRecipient: RECIPIENT,
      amount: 1n,
      destinationDomain: 7,
      now: () => 1,
    });
    expect(m.block).toBeNull();
    expect(m.nonceLatest).toBeNull();
    expect(classifyBurnState({
      marker: m,
      hash: undefined,
      receipt: undefined,
      pendingAhead: false,
      nonceAdvanced: false,
      gapSatisfied: true,
      timeGapSatisfied: true,
      scan: undefined,
      autoReburnEnabled: true,
      allowManualReburn: false,
    }).action).toBe('manual');
  });
});

// ---- log 走査 ----------------------------------------------------------------

interface FakeLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
}

// DepositForBurn の non-indexed 部分を実 ABI レイアウトで組み立てる (decodeEventLog が
// 通ることまで含めて検証したいので、手書きの偽 data は使わない)。
function makeLog(opts: {
  hash: Hex;
  blockNumber: bigint;
  amount?: bigint;
  mintRecipient?: Address;
  destinationDomain?: number;
  depositor?: Address;
  burnToken?: Address;
  address?: Address;
}): FakeLog {
  const data = encodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'destinationTokenMessenger', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
    [
      opts.amount ?? 9_900_000n,
      pad(opts.mintRecipient ?? RECIPIENT, { size: 32 }),
      opts.destinationDomain ?? 7,
      pad('0x00', { size: 32 }),
      pad('0x00', { size: 32 }),
      1000n,
      '0x',
    ],
  );
  return {
    address: opts.address ?? MESSENGER,
    topics: [
      CCTP_V2_DEPOSIT_FOR_BURN_TOPIC0,
      pad(opts.burnToken ?? BURN_TOKEN, { size: 32 }),
      pad(opts.depositor ?? DEPOSITOR, { size: 32 }),
      pad('0x03e8', { size: 32 }),
    ],
    data,
    transactionHash: opts.hash,
    blockNumber: opts.blockNumber,
  };
}

function makeScanClient(opts: {
  logs: FakeLog[];
  txByHash?: Record<string, { nonce: number; from: Address }>;
  receiptByHash?: Record<string, { status: 'success' | 'reverted' }>;
  /** chunk が this より大きい getLogs は range error を投げる (公開 RPC の挙動を模す) */
  maxChunk?: bigint;
  getLogsCalls?: Array<{ fromBlock: bigint; toBlock: bigint }>;
}) {
  return {
    getLogs: vi.fn(async (a: { fromBlock: bigint; toBlock: bigint }) => {
      opts.getLogsCalls?.push({ fromBlock: a.fromBlock, toBlock: a.toBlock });
      if (opts.maxChunk !== undefined && a.toBlock - a.fromBlock + 1n > opts.maxChunk) {
        throw new Error('query returned more than 10000 results: block range too large');
      }
      return opts.logs.filter(
        (l) => l.blockNumber >= a.fromBlock && l.blockNumber <= a.toBlock,
      );
    }),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const tx = opts.txByHash?.[hash];
      if (!tx) throw new Error(`test: no tx for ${hash}`);
      return tx;
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      return opts.receiptByHash?.[hash] ?? { status: 'success' };
    }),
  };
}

describe('lib/crossChain/burnMarker: scanForBurnLog', () => {
  it('marker と完全一致する成功 burn を 1 件だけ返す', async () => {
    const client = makeScanClient({
      logs: [makeLog({ hash: HASH_A, blockNumber: 1_010n })],
      txByHash: { [HASH_A]: { nonce: 5, from: DEPOSITOR } },
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [HASH_A] });
  });

  it('REORG_MARGIN 内に入ってきた過去 burn は nonce 下限で除外される (oldest-match 事故の封鎖)', async () => {
    // marker.block=1000、margin=60 → fromBlock=940。過去 burn (block 950・nonce 3) は
    // 範囲には入るが nonce < marker.nonceLatest(5) なので候補にならない。
    const client = makeScanClient({
      logs: [makeLog({ hash: HASH_OLD, blockNumber: 950n })],
      txByHash: { [HASH_OLD]: { nonce: 3, from: DEPOSITOR } },
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [] });
    // 走査は marker.block − margin から始まる
    expect(client.getLogs.mock.calls[0][0].fromBlock).toBe(940n);
  });

  it('marker.block より前の同額 burn は fromBlock の外なら getLogs に載らない', async () => {
    const client = makeScanClient({
      logs: [makeLog({ hash: HASH_OLD, blockNumber: 500n })],
      txByHash: { [HASH_OLD]: { nonce: 4, from: DEPOSITOR } },
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [] });
  });

  it('一致 2 件はそのまま 2 件返す (最古を採るような選択をしない)', async () => {
    const client = makeScanClient({
      logs: [
        makeLog({ hash: HASH_A, blockNumber: 1_005n }),
        makeLog({ hash: HASH_B, blockNumber: 1_010n }),
      ],
      txByHash: {
        [HASH_A]: { nonce: 5, from: DEPOSITOR },
        [HASH_B]: { nonce: 6, from: DEPOSITOR },
      },
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r.status).toBe('ok');
    expect((r as { matches: Hex[] }).matches).toEqual([HASH_A, HASH_B]);
    // 決定表に渡すと manual (再 burn しない)
    expect(classify({ scan: r }).action).toBe('manual');
  });

  it('revert した burn は候補から外れる (receipt 検証)', async () => {
    const client = makeScanClient({
      logs: [makeLog({ hash: HASH_A, blockNumber: 1_010n })],
      txByHash: { [HASH_A]: { nonce: 5, from: DEPOSITOR } },
      receiptByHash: { [HASH_A]: { status: 'reverted' } },
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [] });
  });

  it('fee slot の走査は merchant burn を拾わない (金額違い / 宛先違いの 2 経路)', async () => {
    const feeMarker = marker({
      mintRecipient: OTHER_RECIPIENT,
      amount: '100000',
      nonceLatest: 6,
    });
    const client = makeScanClient({
      logs: [
        // merchant burn: 金額も宛先も違う
        makeLog({ hash: HASH_A, blockNumber: 1_005n }),
        // 宛先だけ fee と同じで金額が merchant のもの
        makeLog({
          hash: HASH_B,
          blockNumber: 1_006n,
          mintRecipient: OTHER_RECIPIENT,
          amount: 9_900_000n,
        }),
      ],
      txByHash: {
        [HASH_A]: { nonce: 5, from: DEPOSITOR },
        [HASH_B]: { nonce: 5, from: DEPOSITOR },
      },
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: feeMarker,
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [] });
  });

  it('merchant burn と fee burn が同額・同宛先でも nonce で分離される', async () => {
    // 病的ケース: merchant burn (nonce 5) の後に fee marker (nonceLatest 6) を採るので、
    // merchant burn は fee 側の候補にならない。
    const feeMarker = marker({ nonceLatest: 6 });
    const client = makeScanClient({
      logs: [
        makeLog({ hash: HASH_A, blockNumber: 1_005n }), // merchant burn (nonce 5)
        makeLog({ hash: HASH_B, blockNumber: 1_008n }), // fee burn (nonce 6)
      ],
      txByHash: {
        [HASH_A]: { nonce: 5, from: DEPOSITOR },
        [HASH_B]: { nonce: 6, from: DEPOSITOR },
      },
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: feeMarker,
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [HASH_B] });
  });

  it('chunk 分割: span 5,000 block で境界が [from, +1999] [+2000, +3999] [+4000, head]', async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const client = makeScanClient({ logs: [], getLogsCalls: calls });
    // Sei (0.4s・cap 18,000・margin 300)。marker.block=4000 → fromBlock=3700、
    // head=8699 で span=5000。
    await scanForBurnLog({
      client: client as never,
      marker: marker({ chainId: 1329, block: '4000' }),
      head: 8_699n,
      tokenMessenger: MESSENGER,
    });
    expect(calls).toEqual([
      { fromBlock: 3_700n, toBlock: 5_699n },
      { fromBlock: 5_700n, toBlock: 7_699n },
      { fromBlock: 7_700n, toBlock: 8_699n },
    ]);
  });

  it('range error で chunk を 2000→1000→…→100 に縮小して再試行する', async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const client = makeScanClient({ logs: [], maxChunk: 100n, getLogsCalls: calls });
    // Sei (margin 300): marker.block=1000 → fromBlock=700、head=2699 で span=2000。
    // 縮小 4 回 + 100 block × 20 = 24 call ちょうど (MAX_SCAN_CALLS の内側)。
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker({ chainId: 1329, block: '1000' }),
      head: 2_699n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [] });
    // 最初の 4 回は範囲エラーで縮小、5 回目 (100 block) で成功して残りを 100 刻みで走査
    expect(calls.slice(0, 5).map((c) => c.toBlock - c.fromBlock + 1n)).toEqual([
      2_000n,
      1_000n,
      500n,
      250n,
      100n,
    ]);
    // 縮小しても走査開始点は変わらない (同じ cursor から小さい chunk で再試行)
    expect(calls.slice(0, 5).every((c) => c.fromBlock === 700n)).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(MAX_SCAN_CALLS);
  });

  it('range error が最小 chunk でも解消しなければ RANGE (throw しない)', async () => {
    const client = makeScanClient({ logs: [], maxChunk: 10n });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_100n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'range' });
  });

  it('100 block 刻みでも走査しきれない span は call 上限で打ち切って RANGE', async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const client = makeScanClient({ logs: [], maxChunk: 100n, getLogsCalls: calls });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker({ chainId: 1329, block: '1000' }),
      head: 11_000n, // span ≈ 10,300 → 100 block 刻みでは 24 call に収まらない
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'range' });
    expect(calls.length).toBeLessThanOrEqual(MAX_SCAN_CALLS);
  });

  it('range 以外の RPC error は throw する (「log 無し = 未 burn」に潰さない)', async () => {
    const client = {
      getLogs: vi.fn(async () => {
        throw new Error('fetch failed: ECONNRESET');
      }),
    };
    await expect(
      scanForBurnLog({
        client: client as never,
        marker: marker(),
        head: 1_020n,
        tokenMessenger: MESSENGER,
      }),
    ).rejects.toThrow('ECONNRESET');
  });

  it('head − marker.block が chain 別 cap を超えたら走査せず RANGE', async () => {
    const client = makeScanClient({ logs: [] });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker({ block: '1000' }),
      // Base Sepolia cap = 3,600 block
      head: 1_000n + BigInt(burnScanCapBlocks(84532)) + 1n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'range' });
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('marker.block=null は走査せず RANGE (呼出側は manual に倒す)', async () => {
    const client = makeScanClient({ logs: [] });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker({ block: null }),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'range' });
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('getLogs 呼び出し数は MAX_SCAN_CALLS を超えない', async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    // Sei (0.4s) は cap 18,000 = 2000 chunk で 9 回
    const client = makeScanClient({ logs: [], getLogsCalls: calls });
    await scanForBurnLog({
      client: client as never,
      marker: marker({ chainId: 1329, block: '100000' }),
      head: 118_000n,
      tokenMessenger: MESSENGER,
    });
    expect(calls.length).toBeLessThanOrEqual(MAX_SCAN_CALLS);
  });

  it('TokenMessenger 以外の address / 別 topic0 の log は無視する', async () => {
    const client = makeScanClient({
      logs: [
        makeLog({
          hash: HASH_A,
          blockNumber: 1_010n,
          address: getAddress('0x00000000000000000000000000000000deadbeef'),
        }),
      ],
      txByHash: { [HASH_A]: { nonce: 5, from: DEPOSITOR } },
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [] });
  });
});

describe('lib/crossChain/burnMarker: isRangeError / isRateLimitError (D6)', () => {
  it('範囲超過の代表的な message を拾う', () => {
    expect(isRangeError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeError(new Error('eth_getLogs block range too large'))).toBe(true);
    expect(isRangeError({ message: 'x', cause: { message: 'limit exceeded' } })).toBe(
      true,
    );
  });

  // provider 3 種の実文面。範囲超過 (manual に倒す) と rate limit (wait に倒す) の
  // 取り違えは、①一過性の障害で買い手に explorer 確認を強いる ②範囲超過を永遠に
  // 再試行させる、の両方向で実害になる。
  it('QuickNode の "limited to a 10,000 blocks range" を範囲超過として拾う', () => {
    const e = Object.assign(new Error('RPC Request failed.'), {
      metaMessages: [
        'eth_getLogs is limited to a 10,000 blocks range. Please check the parameter requirements at ...',
      ],
    });
    expect(isRangeError(e)).toBe(true);
    expect(isRateLimitError(e)).toBe(false);
  });

  it('viem の details / metaMessages に入った provider 文面も見る', () => {
    const e = { message: 'HTTP request failed.', details: 'block range is too large' };
    expect(isRangeError(e)).toBe(true);
  });

  it('rate limit (-32005 / "limit exceeded") は範囲超過ではなく rate limit', () => {
    const e = {
      message: 'RPC Request failed.',
      cause: { code: -32005, message: 'limit exceeded' },
    };
    expect(isRateLimitError(e)).toBe(true);
    // 'limit exceeded' は範囲超過の文面でもあるが、rate limit 判定が優先される
    expect(isRangeError(e)).toBe(false);
  });

  it('Alchemy の compute unit 超過 / HTTP 429 も rate limit', () => {
    expect(
      isRateLimitError(
        new Error('Your app has exceeded its compute units per second capacity'),
      ),
    ).toBe(true);
    expect(isRateLimitError({ status: 429, message: 'Too Many Requests' })).toBe(true);
  });

  it('transport 障害は範囲エラーとしても rate limit としても扱わない', () => {
    expect(isRangeError(new Error('ECONNRESET'))).toBe(false);
    expect(isRangeError(new Error('HTTP 503 Service Unavailable'))).toBe(false);
    expect(isRangeError(undefined)).toBe(false);
    expect(isRateLimitError(new Error('ECONNRESET'))).toBe(false);
  });
});

// ---- D5: 候補 tx の読み取りも call 予算に載せ、notfound は候補を飛ばす ----------

function notFound(name: string): Error {
  const e = new Error(`${name}: not found`);
  e.name = name;
  return e;
}

describe('lib/crossChain/burnMarker: 候補 tx 読み取りの隔離 (D5)', () => {
  it('候補 tx が notfound (reorg) なら走査を throw せずその候補だけ飛ばす', async () => {
    const client = makeScanClient({
      logs: [
        makeLog({ hash: HASH_A, blockNumber: 1_005n }),
        makeLog({ hash: HASH_B, blockNumber: 1_010n }),
      ],
      txByHash: { [HASH_B]: { nonce: 6, from: DEPOSITOR } },
    });
    client.getTransaction = vi.fn(async ({ hash }: { hash: Hex }) => {
      if (hash === HASH_A) throw notFound('TransactionNotFoundError');
      return { nonce: 6, from: DEPOSITOR };
    }) as never;
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [HASH_B] });
  });

  it('候補 receipt が notfound でもその候補だけ飛ばす', async () => {
    const client = makeScanClient({
      logs: [makeLog({ hash: HASH_A, blockNumber: 1_005n })],
      txByHash: { [HASH_A]: { nonce: 5, from: DEPOSITOR } },
    });
    client.getTransactionReceipt = vi.fn(async () => {
      throw notFound('TransactionReceiptNotFoundError');
    }) as never;
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ok', matches: [] });
  });

  it('候補読み取りの transport 障害は throw する (未 burn に潰さない)', async () => {
    const client = makeScanClient({
      logs: [makeLog({ hash: HASH_A, blockNumber: 1_005n })],
      txByHash: { [HASH_A]: { nonce: 5, from: DEPOSITOR } },
    });
    client.getTransaction = vi.fn(async () => {
      throw new Error('fetch failed: ECONNRESET');
    }) as never;
    await expect(
      scanForBurnLog({
        client: client as never,
        marker: marker(),
        head: 1_020n,
        tokenMessenger: MESSENGER,
      }),
    ).rejects.toThrow('ECONNRESET');
  });

  it('候補 tx / receipt の読み取りも MAX_SCAN_CALLS に載る (打ち切って RANGE)', async () => {
    // 1 chunk (getLogs 1 call) で候補 20 件 → 候補読み取りは 2 call/件。予算 24 を
    // 超えた時点で走査を打ち切り、範囲不明として RANGE を返す。
    const hashes = Array.from(
      { length: 20 },
      (_, i) => (`0x${(i + 1).toString(16).padStart(4, '0')}`) as Hex,
    );
    const client = makeScanClient({
      logs: hashes.map((h, i) => makeLog({ hash: h, blockNumber: 1_001n + BigInt(i) })),
      txByHash: Object.fromEntries(
        hashes.map((h) => [h, { nonce: 9, from: DEPOSITOR }]),
      ),
    });
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_100n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'range' });
    const reads =
      client.getTransaction.mock.calls.length +
      client.getTransactionReceipt.mock.calls.length;
    expect(client.getLogs.mock.calls.length + reads).toBeLessThanOrEqual(
      MAX_SCAN_CALLS,
    );
  });

  it('getLogs が rate limit で失敗したら ratelimited (chunk 縮小もしない)', async () => {
    const client = {
      getLogs: vi.fn(async () => {
        throw Object.assign(new Error('RPC Request failed.'), {
          cause: { code: -32005, message: 'limit exceeded' },
        });
      }),
    };
    const r = await scanForBurnLog({
      client: client as never,
      marker: marker(),
      head: 1_020n,
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ status: 'ratelimited' });
    expect(client.getLogs).toHaveBeenCalledTimes(1);
  });
});

// ---- D4: 買い手が貼った tx hash の検証 ----------------------------------------

describe('lib/crossChain/burnMarker: normalizeBurnTxHash / verifyBurnTxHash (D4)', () => {
  const GOOD_HASH = `0x${'ab'.repeat(32)}` as Hex;

  function receiptClient(opts: {
    status?: 'success' | 'reverted';
    logs?: FakeLog[];
    from?: Address;
    nonce?: number;
    notfound?: boolean;
  }) {
    return {
      getTransactionReceipt: vi.fn(async () => {
        if (opts.notfound) throw notFound('TransactionReceiptNotFoundError');
        return {
          status: opts.status ?? 'success',
          from: opts.from ?? DEPOSITOR,
          logs: opts.logs ?? [makeLog({ hash: GOOD_HASH, blockNumber: 1_010n })],
        };
      }),
      getTransaction: vi.fn(async () => ({
        nonce: opts.nonce ?? 5,
        from: opts.from ?? DEPOSITOR,
      })),
    };
  }

  it('書式不正は receipt を引く前に弾く', () => {
    expect(normalizeBurnTxHash('0x1234')).toBeUndefined();
    expect(normalizeBurnTxHash('deadbeef')).toBeUndefined();
    expect(normalizeBurnTxHash(`0x${'zz'.repeat(32)}`)).toBeUndefined();
    expect(normalizeBurnTxHash(`  ${GOOD_HASH}  `)).toBe(GOOD_HASH);
  });

  it('marker と一致する成功 tx は採用する', async () => {
    const client = receiptClient({});
    const r = await verifyBurnTxHash({
      client: client as never,
      hash: GOOD_HASH,
      marker: marker(),
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ ok: true, hash: GOOD_HASH });
  });

  it('金額が違う burn log は採用しない (mismatch)', async () => {
    const client = receiptClient({
      logs: [makeLog({ hash: GOOD_HASH, blockNumber: 1_010n, amount: 1n })],
    });
    const r = await verifyBurnTxHash({
      client: client as never,
      hash: GOOD_HASH,
      marker: marker(),
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('宛先が違う / TokenMessenger 以外の log は採用しない', async () => {
    for (const logs of [
      [makeLog({ hash: GOOD_HASH, blockNumber: 1_010n, mintRecipient: OTHER_RECIPIENT })],
      [
        makeLog({
          hash: GOOD_HASH,
          blockNumber: 1_010n,
          address: getAddress('0x00000000000000000000000000000000deadbeef'),
        }),
      ],
      [],
    ]) {
      const r = await verifyBurnTxHash({
        client: receiptClient({ logs }) as never,
        hash: GOOD_HASH,
        marker: marker(),
        tokenMessenger: MESSENGER,
      });
      expect(r).toEqual({ ok: false, reason: 'mismatch' });
    }
  });

  it('marker より前の nonce (過去の同額 burn) は採用しない', async () => {
    const client = receiptClient({ nonce: 4 }); // marker.nonceLatest = 5
    const r = await verifyBurnTxHash({
      client: client as never,
      hash: GOOD_HASH,
      marker: marker(),
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('別 sender の tx は採用しない', async () => {
    const client = receiptClient({ from: OTHER_RECIPIENT });
    const r = await verifyBurnTxHash({
      client: client as never,
      hash: GOOD_HASH,
      marker: marker(),
      tokenMessenger: MESSENGER,
    });
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('revert した tx / 見つからない tx はそれぞれの理由を返す', async () => {
    expect(
      await verifyBurnTxHash({
        client: receiptClient({ status: 'reverted' }) as never,
        hash: GOOD_HASH,
        marker: marker(),
        tokenMessenger: MESSENGER,
      }),
    ).toEqual({ ok: false, reason: 'reverted' });
    expect(
      await verifyBurnTxHash({
        client: receiptClient({ notfound: true }) as never,
        hash: GOOD_HASH,
        marker: marker(),
        tokenMessenger: MESSENGER,
      }),
    ).toEqual({ ok: false, reason: 'notfound' });
  });

  it('transport 障害は throw する (「一致しなかった」に潰さない)', async () => {
    const client = {
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('fetch failed: ECONNRESET');
      }),
    };
    await expect(
      verifyBurnTxHash({
        client: client as never,
        hash: GOOD_HASH,
        marker: marker(),
        tokenMessenger: MESSENGER,
      }),
    ).rejects.toThrow('ECONNRESET');
  });
});
