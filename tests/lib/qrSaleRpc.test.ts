// lib/qrSaleRpc.ts の実物 (tests/setup.ts の既定のスタブを外して読む)。
// RPC へは 1 回ずつ (送り直さない)・読めなければ throw・Settled の絞り込みは forwarder の address と受取先の topic。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeEventTopics, keccak256, pad, parseAbi, toHex, type Address } from 'viem';
import { deploymentForSlug } from '@/lib/tokens';
import { settledRpcLog } from '../_helpers/qrSale';

const JPYC = deploymentForSlug('jpyc', 'polygon');
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER_SHOP: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const TX = `0x${'a'.repeat(64)}`;

async function loadActual() {
  return vi.importActual<typeof import('@/lib/qrSaleRpc')>('@/lib/qrSaleRpc');
}

let calls: { method: string; params: unknown[] }[] = [];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubRpc(respond: (body: { id: number; method: string }) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      calls.push({ method: body.method, params: body.params });
      return respond(body);
    }),
  );
}
const ok = (result: unknown) => (body: { id: number }) => Response.json({ jsonrpc: '2.0', id: body.id, result });

describe('tests/setup.ts の既定のスタブ', () => {
  it('どのテストも、差し替えなければ「読めない」(外の RPC を叩かない)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const stub = await import('@/lib/qrSaleRpc');
    await expect(stub.readChainHead(JPYC.chainId)).rejects.toThrow('qr_sale_rpc_stubbed_in_tests');
    await expect(stub.readSettledLogs(JPYC.chainId, FORWARDER, [SHOP], 1n, 2n)).rejects.toThrow('qr_sale_rpc_stubbed_in_tests');
    await expect(stub.readBlockTime(JPYC.chainId, 1n)).rejects.toThrow('qr_sale_rpc_stubbed_in_tests');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stub.QR_SALE_RPC_TIMEOUT_MS).toBe((await loadActual()).QR_SALE_RPC_TIMEOUT_MS);
  });
});

describe('readChainHead', () => {
  it('eth_blockNumber を 1 回読む (2 回目も読み直す = 前の値を使い回さない)', async () => {
    let head = 0x3e8;
    stubRpc((body) => Response.json({ jsonrpc: '2.0', id: body.id, result: toHex(head) }));
    const { readChainHead } = await loadActual();
    expect(await readChainHead(JPYC.chainId)).toBe(1_000n);
    head = 0x3ea;
    expect(await readChainHead(JPYC.chainId)).toBe(1_002n);
    expect(calls.map((c) => c.method)).toEqual(['eth_blockNumber', 'eth_blockNumber']);
  });

  it('RPC が失敗したら throw する。送り直しはしない', async () => {
    stubRpc(() => new Response('upstream down', { status: 503 }));
    const { readChainHead } = await loadActual();
    await expect(readChainHead(JPYC.chainId)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('chain の表に無い chainId は、RPC を呼ばずに throw する', async () => {
    stubRpc(() => Response.json({}));
    const { readChainHead } = await loadActual();
    expect(() => readChainHead(999_999)).toThrow('qr_sale_unsupported_chain');
    expect(calls).toHaveLength(0);
  });
});

describe('readSettledLogs', () => {
  const SETTLED_TOPIC = keccak256(toHex('Settled(address,bytes32,address,uint256,address,uint256)'));

  it('eth_getLogs を 1 回: forwarder の address・Settled の topic・受取先の topic (複数は OR)・範囲の両端', async () => {
    const log = settledRpcLog({
      forwarder: FORWARDER, from: CUSTOMER, merchant: SHOP, merchantValue: 998n * 10n ** 18n, feeValue: 2n * 10n ** 18n,
      nonce: `0x${'cd'.repeat(32)}`, txHash: TX, blockNumber: 995n,
    });
    stubRpc(
      ok([
        {
          address: log.address, topics: log.topics, data: log.data, blockNumber: '0x3e3', transactionHash: TX,
          transactionIndex: '0x1', blockHash: `0x${'b'.repeat(64)}`, logIndex: '0x7', removed: false,
        },
      ]),
    );
    const { readSettledLogs } = await loadActual();
    const logs = await readSettledLogs(JPYC.chainId, FORWARDER, [SHOP, OTHER_SHOP], 987n, 997n);
    expect(calls).toEqual([
      {
        method: 'eth_getLogs',
        params: [
          {
            address: FORWARDER,
            topics: [SETTLED_TOPIC, null, null, [pad(SHOP).toLowerCase(), pad(OTHER_SHOP).toLowerCase()]],
            fromBlock: '0x3db',
            toBlock: '0x3e5',
          },
        ],
      },
    ]);
    // 絞り込みの topic は、契約の event の形から作ったものと同じ。
    expect(SETTLED_TOPIC).toBe(
      encodeEventTopics({
        abi: parseAbi([
          'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
        ]),
        eventName: 'Settled',
      })[0],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      address: log.address, topics: log.topics, data: log.data, transactionHash: TX, logIndex: 7, blockNumber: 995n,
    });
  });

  it('RPC が失敗したら (範囲の制限・rate limit) throw する。送り直しはしない', async () => {
    stubRpc((body) =>
      Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32005, message: 'query returned more than 10000 results' } }),
    );
    const { readSettledLogs } = await loadActual();
    await expect(readSettledLogs(JPYC.chainId, FORWARDER, [SHOP], 1n, 2n)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  // 見張り (lib/qrSaleWatch.ts) は、getLogs の「範囲が広すぎる」の error だけを見て 10 block ずつ読み直す。その判定が、
  // viem が実際に投げる error (HTTP の status・provider の文面の入れ方) で働くことを、本物の transport で確かめる。
  it.each([
    [
      'Alchemy の無料枠 (HTTP 400・11 block 以上)',
      400,
      {
        code: -32600,
        message:
          'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your ' +
          'parameters, this block range should work: [0x1, 0xa]. Upgrade to PAYG for expanded block range.',
      },
      true,
    ],
    ['JSON-RPC の error (HTTP 200・code -32005・結果が多すぎる)', 200, { code: -32005, message: 'query returned more than 10000 results' }, true],
    ['JSON-RPC の error (HTTP 200・範囲が広すぎる)', 200, { code: -32000, message: 'block range is too large' }, true],
    ['rate limit (HTTP 429)', 429, { code: 429, message: 'Your app has exceeded its compute units per second capacity.' }, false],
    ['関係ない 400', 400, { code: -32602, message: 'invalid argument 0: hex string has length 3' }, false],
  ])('範囲の制限の判定は、viem が投げた error で働く: %s', async (_name, status, error, expected) => {
    stubRpc((body) => Response.json({ jsonrpc: '2.0', id: body.id, error }, { status }));
    const { readSettledLogs } = await loadActual();
    const { isBlockRangeLimitError } = await import('@/lib/qrSaleWatch');
    const thrown = await readSettledLogs(JPYC.chainId, FORWARDER, [SHOP], 1n, 11n).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).not.toBeNull();
    expect(isBlockRangeLimitError(thrown)).toBe(expected);
    expect(calls).toHaveLength(1);
  });
});

describe('readBlockTime', () => {
  it('eth_getBlockByNumber を 1 回読み、block の時刻 (unix 秒) を返す', async () => {
    stubRpc(
      ok({
        number: '0x3e3', hash: `0x${'b'.repeat(64)}`, parentHash: `0x${'c'.repeat(64)}`, timestamp: '0x6ab1f580',
        transactions: [], gasLimit: '0x1', gasUsed: '0x0', size: '0x1', difficulty: '0x0', extraData: '0x',
        logsBloom: `0x${'0'.repeat(512)}`, miner: FORWARDER, nonce: '0x0000000000000000', sha3Uncles: `0x${'d'.repeat(64)}`,
        stateRoot: `0x${'e'.repeat(64)}`, receiptsRoot: `0x${'e'.repeat(64)}`, transactionsRoot: `0x${'e'.repeat(64)}`,
        uncles: [], totalDifficulty: '0x0', mixHash: `0x${'f'.repeat(64)}`,
      }),
    );
    const { readBlockTime } = await loadActual();
    expect(await readBlockTime(JPYC.chainId, 995n)).toBe(BigInt(0x6ab1f580));
    expect(calls).toEqual([{ method: 'eth_getBlockByNumber', params: ['0x3e3', false] }]);
  });

  it('block がまだ無い (null)・RPC の失敗は throw する。送り直しはしない', async () => {
    stubRpc(ok(null));
    const { readBlockTime } = await loadActual();
    await expect(readBlockTime(JPYC.chainId, 995n)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
