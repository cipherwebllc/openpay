// 注文リンクの「入金を確かめる」: 発送の判断に使うので、数えるのは成功した取引の、その受取チェーンの JPYC の
// Transfer のうち受取ウォレット宛てだけ (別のトークン・別の宛先・失敗した取引は届いた額に入れない)。

import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseUnits,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { checkOrderLinkPayment, extractTxHash, receivedByReceiver, rememberCheckedPayment } from '@/lib/orderLinkVerify';
import { deploymentForSlug } from '@/lib/tokens';

const RECEIVER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const FORWARDER = '0x2222222222222222222222222222222222222222' as Address;
const JPYC = deploymentForSlug('jpyc', 'polygon').address;
const NOT_JPYC = '0x3333333333333333333333333333333333333333' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;

function transfer(token: Address, from: Address, to: Address, jpyc: string): Log {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint256' }], [parseUnits(jpyc, 18)]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as unknown as Log;
}

function client(receipt: { status: 'success' | 'reverted'; logs: Log[] } | Error) {
  return {
    getTransactionReceipt: vi.fn(async () => {
      if (receipt instanceof Error) throw receipt;
      return { ...receipt, blockNumber: 123n } as never;
    }),
    getBlock: vi.fn(async () => ({ timestamp: 1_762_000_000n }) as never),
  };
}

describe('extractTxHash', () => {
  it('貼った文 (お店に知らせるの文や Explorer の URL) から最初の Tx Hash を取り出す', () => {
    expect(extractTxHash(`ご注文 A-001 のお支払いが済みました。\nTx Hash: ${HASH}\nhttps://polygonscan.com/tx/${HASH}`)).toBe(HASH);
    expect(extractTxHash(`https://polygonscan.com/tx/${HASH.toUpperCase().replace('0X', '0x')}`)).toBe(HASH);
    expect(extractTxHash('0x1234')).toBeNull();
    expect(extractTxHash('')).toBeNull();
  });
});

describe('receivedByReceiver', () => {
  it('その JPYC の、受取ウォレット宛ての Transfer だけを足す', () => {
    const logs = [
      transfer(JPYC, OTHER, FORWARDER, '3500'),
      transfer(JPYC, FORWARDER, RECEIVER, '3465'),
      transfer(JPYC, FORWARDER, OTHER, '35'),
      transfer(NOT_JPYC, OTHER, RECEIVER, '9999'),
    ];
    expect(receivedByReceiver(logs, JPYC, RECEIVER)).toBe(parseUnits('3465', 18));
  });
});

describe('checkOrderLinkPayment', () => {
  const base = { chain: 'polygon' as const, receiver: RECEIVER, text: `Tx Hash: ${HASH}` };

  it('受取ウォレットに届いていれば、届いた額・ブロック・時刻を返す', async () => {
    const c = client({ status: 'success', logs: [transfer(JPYC, FORWARDER, RECEIVER, '3465')] });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({
      status: 'paid',
      received: '3465',
      blockNumber: 123n,
      timestamp: 1_762_000_000,
    });
    expect(c.getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it('別の宛先・別のトークンだけの取引は「届いていない」 (偽の Tx Hash で発送させない)', async () => {
    const c = client({
      status: 'success',
      logs: [transfer(JPYC, FORWARDER, OTHER, '3465'), transfer(NOT_JPYC, OTHER, RECEIVER, '3465')],
    });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'notToReceiver' });
  });

  it('失敗した取引は、ログに受取ウォレット宛てがあっても「失敗」', async () => {
    const c = client({ status: 'reverted', logs: [transfer(JPYC, FORWARDER, RECEIVER, '3465')] });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'failed' });
  });

  it('見つからない取引は「見つからない」・RPC の失敗は「問い合わせできない」 (届いたとは言わない)', async () => {
    const notFound = client(new TransactionReceiptNotFoundError({ hash: HASH }));
    await expect(checkOrderLinkPayment({ ...base, client: notFound })).resolves.toEqual({ status: 'notFound' });
    const broken = client(new Error('rpc down'));
    await expect(checkOrderLinkPayment({ ...base, client: broken })).resolves.toEqual({ status: 'error' });
  });

  it('Tx Hash が読み取れなければチェーンに問い合わせない', async () => {
    const c = client({ status: 'success', logs: [] });
    await expect(checkOrderLinkPayment({ ...base, text: 'A-001 払いました', client: c })).resolves.toEqual({ status: 'invalid' });
    expect(c.getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('rememberCheckedPayment', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      data,
    };
  }
  const input = { chain: 'polygon' as const, receiver: RECEIVER, hash: HASH, now: 1_000 };

  it('初めての支払いは null、同じ受取先・チェーン・Tx Hash の 2 回目は 1 回目の時刻を返す (使い回しを知らせる)', () => {
    const storage = memoryStorage();
    expect(rememberCheckedPayment(input, storage)).toBeNull();
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, storage)).toBe(1_000);
    // 大文字小文字の違いは同じ支払い。
    expect(rememberCheckedPayment({ ...input, hash: HASH.toUpperCase().replace('0X', '0x') as Hex, now: 3_000 }, storage)).toBe(1_000);
    // 受取先やチェーンが違えば別の記録。
    expect(rememberCheckedPayment({ ...input, receiver: OTHER }, storage)).toBeNull();
    expect(rememberCheckedPayment({ ...input, chain: 'kaia' }, storage)).toBeNull();
  });

  it('壊れた記録は作り直し、保存できない・使えない環境でも例外を出さない (確かめる機能は止めない)', () => {
    const broken = memoryStorage({ 'openpay:order-link-checked:v1': '{not json' });
    expect(rememberCheckedPayment(input, broken)).toBeNull();
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, broken)).toBe(1_000);
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(rememberCheckedPayment(input, full)).toBeNull();
    expect(rememberCheckedPayment(input, null)).toBeNull();
  });

  it('記録は新しい順に 300 件までに保つ', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 300; i += 1) many[`polygon:x:${i}`] = i;
    const storage = memoryStorage({ 'openpay:order-link-checked:v1': JSON.stringify(many) });
    rememberCheckedPayment({ ...input, now: 10_000 }, storage);
    const kept = JSON.parse(storage.data['openpay:order-link-checked:v1']) as Record<string, number>;
    expect(Object.keys(kept)).toHaveLength(300);
    expect(kept['polygon:x:0']).toBeUndefined();
    expect(Object.values(kept)).toContain(10_000);
  });
});
