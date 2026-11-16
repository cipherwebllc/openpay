// lib/orderFeedReceipt.ts の実物 (tests/setup.ts の既定のスタブを外して読む)。
// RPC へは 1 回だけ (送り直さない)・読めなければ throw・返すのは status / blockNumber / logs だけ。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Hex } from 'viem';
import { deploymentForSlug } from '@/lib/tokens';

const JPYC = deploymentForSlug('jpyc', 'polygon');
const TX = `0x${'a'.repeat(64)}` as Hex;

async function loadActual() {
  return vi.importActual<typeof import('@/lib/orderFeedReceipt')>('@/lib/orderFeedReceipt');
}

const rpcReceipt = {
  transactionHash: TX,
  transactionIndex: '0x1',
  blockHash: `0x${'b'.repeat(64)}`,
  blockNumber: '0x309',
  from: '0x1111111111111111111111111111111111111111',
  to: JPYC.address,
  cumulativeGasUsed: '0x5208',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x1',
  contractAddress: null,
  logsBloom: `0x${'0'.repeat(512)}`,
  status: '0x1',
  type: '0x2',
  logs: [
    {
      address: JPYC.address,
      topics: [`0x${'c'.repeat(64)}`],
      data: '0x',
      blockNumber: '0x309',
      transactionHash: TX,
      transactionIndex: '0x1',
      blockHash: `0x${'b'.repeat(64)}`,
      logIndex: '0x0',
      removed: false,
    },
  ],
};

let calls: { method: string; params: unknown[] }[] = [];

beforeEach(() => {
  calls = [];
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

describe('readOrderReceipt', () => {
  it('eth_getTransactionReceipt を 1 回読み、status・blockNumber・logs を返す', async () => {
    stubRpc((body) => Response.json({ jsonrpc: '2.0', id: body.id, result: rpcReceipt }));
    const { readOrderReceipt } = await loadActual();
    const receipt = await readOrderReceipt(JPYC.chainId, TX);
    expect(receipt.status).toBe('success');
    expect(receipt.blockNumber).toBe(777n);
    expect(receipt.logs).toHaveLength(1);
    expect(receipt.logs[0]).toMatchObject({ address: JPYC.address, topics: [`0x${'c'.repeat(64)}`], data: '0x' });
    expect(calls).toEqual([{ method: 'eth_getTransactionReceipt', params: [TX] }]);
  });

  it('RPC が失敗したら throw する。送り直しはしない (回数は書き手が数える)', async () => {
    stubRpc(() => new Response('upstream down', { status: 503 }));
    const { readOrderReceipt } = await loadActual();
    await expect(readOrderReceipt(JPYC.chainId, TX)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('receipt がまだ無い (null) ときも throw する', async () => {
    stubRpc((body) => Response.json({ jsonrpc: '2.0', id: body.id, result: null }));
    const { readOrderReceipt } = await loadActual();
    await expect(readOrderReceipt(JPYC.chainId, TX)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('chain の表に無い chainId は、RPC を呼ばずに throw する', async () => {
    stubRpc(() => Response.json({}));
    const { readOrderReceipt } = await loadActual();
    await expect(readOrderReceipt(999_999, TX)).rejects.toThrow('order_receipt_unsupported_chain');
    expect(calls).toHaveLength(0);
  });
});
