// @vitest-environment node
// 取り消し (cancelAuthorization) の証拠の判定 (lib/x402/authorizationCancel.ts)。在庫・rail を戻してよいのは
// finalized・canonical な AuthorizationCanceled(payer, nonce) が、使用・決済と矛盾なく確かめられたときだけ。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, toHex, TransactionReceiptNotFoundError, type Hex, type Log } from 'viem';
import { AUTHORIZATION_CANCELED_EVENT, findFinalizedAuthorizationCancel, type AuthorizationCancelClient } from '@/lib/x402/authorizationCancel';

const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x2222222222222222222222222222222222222222');
const PAYER = getAddress('0x5555555555555555555555555555555555555555');
const OTHER = getAddress('0x6666666666666666666666666666666666666666');
const NONCE = toHex(77n, { size: 32 });
const CANCEL_TX = toHex(901n, { size: 32 });
const STORED_TX = toHex(902n, { size: 32 });
const CANCEL_BLOCK = 400n;
const CANCEL_BLOCK_HASH = toHex(4000n, { size: 32 });
const FINAL_BLOCK = 500n;
const FINAL_HASH = toHex(5000n, { size: 32 });
const USED_EVENT = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)'])[0];
const SETTLED_EVENT = parseAbi(['event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)'])[0];

function rawLog(address: Hex, topics: Hex[], data: Hex = '0x'): Log {
  return {
    address, topics: topics as [Hex, ...Hex[]], data, blockNumber: CANCEL_BLOCK, blockHash: CANCEL_BLOCK_HASH,
    transactionHash: CANCEL_TX, transactionIndex: 0, logIndex: 0, removed: false,
  };
}
const canceledLog = (authorizer = PAYER, nonce = NONCE) => rawLog(TOKEN, encodeEventTopics({ abi: [AUTHORIZATION_CANCELED_EVENT], eventName: 'AuthorizationCanceled', args: { authorizer, nonce } }) as Hex[]);
const usedLog = () => rawLog(TOKEN, encodeEventTopics({ abi: [USED_EVENT], eventName: 'AuthorizationUsed', args: { authorizer: PAYER, nonce: NONCE } }) as Hex[]);
const settledLog = () => rawLog(FORWARDER, encodeEventTopics({ abi: [SETTLED_EVENT], eventName: 'Settled', args: { from: PAYER, nonce: NONCE, merchant: OTHER } }) as Hex[],
  encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [1n, OTHER, 1n]));

type Fixture = {
  logs: { blockNumber: bigint | null; blockHash: Hex | null; transactionHash: Hex | null; removed?: boolean }[];
  receipt: Awaited<ReturnType<AuthorizationCancelClient['getTransactionReceipt']>>;
  stored: Awaited<ReturnType<AuthorizationCancelClient['getTransactionReceipt']>> | Error;
  blocks: Map<bigint, Hex>;
  finalized: { number: bigint | null; hash?: Hex | null };
};
let f: Fixture;
const client = {
  getLogs: vi.fn(async () => f.logs),
  getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
    if (hash === CANCEL_TX) return f.receipt;
    if (f.stored instanceof Error) throw f.stored;
    return f.stored;
  }),
  getBlock: vi.fn(async (args: { blockTag: 'finalized' } | { blockNumber: bigint }) =>
    'blockTag' in args ? f.finalized : { number: args.blockNumber, hash: f.blocks.get(args.blockNumber) ?? null }),
} satisfies AuthorizationCancelClient;
const find = (extra: Partial<Parameters<typeof findFinalizedAuthorizationCancel>[0]> = {}) => findFinalizedAuthorizationCancel({
  client, token: TOKEN, forwarder: FORWARDER, payer: PAYER, nonce: NONCE, fromBlock: 1n, toBlock: 600n, ...extra,
});
const EVIDENCE = { blockNumber: '400', blockHash: CANCEL_BLOCK_HASH, transactionHash: CANCEL_TX };

beforeEach(() => {
  vi.clearAllMocks();
  f = {
    logs: [{ blockNumber: CANCEL_BLOCK, blockHash: CANCEL_BLOCK_HASH, transactionHash: CANCEL_TX, removed: false }],
    receipt: { status: 'success', blockNumber: CANCEL_BLOCK, blockHash: CANCEL_BLOCK_HASH, transactionHash: CANCEL_TX, logs: [canceledLog()] },
    stored: { status: 'reverted', blockNumber: 300n, blockHash: toHex(3000n, { size: 32 }), transactionHash: STORED_TX, logs: [] },
    blocks: new Map([[CANCEL_BLOCK, CANCEL_BLOCK_HASH], [FINAL_BLOCK, FINAL_HASH]]),
    finalized: { number: FINAL_BLOCK, hash: FINAL_HASH },
  };
});

describe('findFinalizedAuthorizationCancel', () => {
  it('returns the finalized canonical AuthorizationCanceled(payer, nonce) and filters getLogs by the token/payer/nonce', async () => {
    expect(await find()).toEqual(EVIDENCE);
    expect(client.getLogs).toHaveBeenCalledWith({ address: TOKEN, event: AUTHORIZATION_CANCELED_EVENT, args: { authorizer: PAYER, nonce: NONCE }, fromBlock: 1n, toBlock: 600n });
    // finalized を自分で取ったときは、その hash が canonical のままかも確かめる。
    expect(client.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' });
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: FINAL_BLOCK });
  });

  it('uses the caller-verified finalized block (license observe) without refetching it', async () => {
    expect(await find({ finalized: { number: FINAL_BLOCK, hash: FINAL_HASH } })).toEqual(EVIDENCE);
    expect(client.getBlock).not.toHaveBeenCalledWith({ blockTag: 'finalized' });
    expect(client.getBlock).toHaveBeenCalledTimes(1);
  });

  it('does not judge a cancel that is not finalized yet (log after the finalized block)', async () => {
    f.finalized = { number: 399n, hash: FINAL_HASH };
    expect(await find()).toBeNull();
    expect(await find({ finalized: { number: 399n, hash: FINAL_HASH } })).toBeNull();
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('an empty range or no log is no evidence (no further RPC)', async () => {
    expect(await find({ fromBlock: 10n, toBlock: 9n })).toBeNull();
    expect(client.getLogs).not.toHaveBeenCalled();
    f.logs = [];
    expect(await find()).toBeNull();
    expect(client.getBlock).not.toHaveBeenCalled();
  });

  it.each([
    ['removed log', () => { f.logs[0]!.removed = true; }],
    ['pending log without block', () => { f.logs[0]!.blockNumber = null; }],
    ['reverted cancel tx', () => { f.receipt = { ...f.receipt, status: 'reverted' }; }],
    ['receipt in another block', () => { f.receipt = { ...f.receipt, blockHash: toHex(1n, { size: 32 }) }; }],
    ['receipt without the cancel event', () => { f.receipt = { ...f.receipt, logs: [] }; }],
    ['cancel of another payer', () => { f.receipt = { ...f.receipt, logs: [canceledLog(OTHER)] }; }],
    ['cancel of another nonce', () => { f.receipt = { ...f.receipt, logs: [canceledLog(PAYER, toHex(78n, { size: 32 }))] }; }],
    ['cancel event from another contract', () => { f.receipt = { ...f.receipt, logs: [{ ...canceledLog(), address: OTHER }] }; }],
    ['same tx also used the nonce', () => { f.receipt = { ...f.receipt, logs: [canceledLog(), usedLog()] }; }],
    ['same tx also settled through the forwarder', () => { f.receipt = { ...f.receipt, logs: [canceledLog(), settledLog()] }; }],
    ['non-canonical cancel block', () => { f.blocks.set(CANCEL_BLOCK, toHex(1n, { size: 32 })); }],
    ['finalized hash changed', () => { f.blocks.set(FINAL_BLOCK, toHex(1n, { size: 32 })); }],
    ['finalized without hash', () => { f.finalized = { number: FINAL_BLOCK, hash: null }; }],
    ['stored payment tx succeeded', () => { f.stored = { ...(f.stored as Fixture['receipt']), status: 'success' }; }],
    ['stored payment receipt unreadable', () => { f.stored = new Error('timeout'); }],
    ['getLogs RPC failure', () => { client.getLogs.mockRejectedValueOnce(new Error('range too large')); }],
  ] as const)('%s is no evidence', async (_name, mutate) => {
    mutate();
    expect(await find({ txHash: STORED_TX })).toBeNull();
  });

  it('a stored payment tx that reverted or was never mined is compatible with the cancel', async () => {
    expect(await find({ txHash: STORED_TX })).toEqual(EVIDENCE);
    f.stored = new TransactionReceiptNotFoundError({ hash: STORED_TX });
    expect(await find({ txHash: STORED_TX })).toEqual(EVIDENCE);
  });
});
