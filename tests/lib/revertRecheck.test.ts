// 第 8 回レビュー A-01: relay の tx が revert した後の authorizationState の固定読み取り (authorizationUsedAtRevert)。
// 「未使用」は client に払い直しを許す根拠になるので、revert の receipt が載ったブロックの hash に固定して読み
// (EIP-1898 blockHash + requireCanonical)、読み取りの後もそのブロックが canonical のときだけ false を返す。
// 固定できない・食い違いはすべて throw (呼び元の recheckRevertedAuthorization が pending に倒す)。

import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { authorizationUsedAtRevert } from '@/lib/relay/revertRecheck';

const TOKEN = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29' as Address;
const FROM = '0x1111111111111111111111111111111111111111' as Address;
const NONCE = `0x${'22'.repeat(32)}` as Hex;
const REVERT_TX = `0x${'ef'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as Hex;
const OTHER_BLOCK_HASH = `0x${'cd'.repeat(32)}` as Hex;
const BLOCK_NUMBER = 1234n;

type Client = Parameters<typeof authorizationUsedAtRevert>[0]['client'];

function client(over: {
  receipt?: Awaited<ReturnType<Client['getTransactionReceipt']>> | Error;
  used?: boolean | Error;
  canonicalHash?: Hex | null;
} = {}) {
  const getTransactionReceipt = vi.fn<Client['getTransactionReceipt']>(async () => {
    const receipt = over.receipt ?? { status: 'reverted', blockNumber: BLOCK_NUMBER, blockHash: BLOCK_HASH };
    if (receipt instanceof Error) throw receipt;
    return receipt;
  });
  const readContract = vi.fn<Client['readContract']>(async () => {
    const used = over.used ?? false;
    if (used instanceof Error) throw used;
    return used;
  });
  const getBlock = vi.fn<Client['getBlock']>(async () => ({
    hash: over.canonicalHash === undefined ? BLOCK_HASH : over.canonicalHash,
  }));
  return { getTransactionReceipt, readContract, getBlock };
}

function read(c: Client) {
  return authorizationUsedAtRevert({ client: c, token: TOKEN, from: FROM, nonce: NONCE, revertTxHash: REVERT_TX });
}

describe('authorizationUsedAtRevert (A-01)', () => {
  it('revert の receipt のブロック hash に固定して読み、canonical のままなら未使用 (false)', async () => {
    const c = client();
    await expect(read(c)).resolves.toBe(false);
    expect(c.getTransactionReceipt).toHaveBeenCalledWith({ hash: REVERT_TX });
    expect(c.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: TOKEN,
      functionName: 'authorizationState',
      args: [FROM, NONCE],
      blockHash: BLOCK_HASH,
      requireCanonical: true,
    }));
    // 番号や latest では読まない (遅れた RPC ノード・別フォークの「未使用」を根拠にしない)。
    expect(c.readContract.mock.calls[0][0]).not.toHaveProperty('blockNumber');
    expect(c.readContract.mock.calls[0][0]).not.toHaveProperty('blockTag');
    // 読み取りの後に canonical を確かめる。
    expect(c.getBlock).toHaveBeenCalledWith({ blockNumber: BLOCK_NUMBER });
    expect(c.getBlock.mock.invocationCallOrder[0]).toBeGreaterThan(c.readContract.mock.invocationCallOrder[0]);
  });

  it('固定したブロックで使用済みなら true (支払いの証拠なので canonical の確認を待たない)', async () => {
    const c = client({ used: true });
    await expect(read(c)).resolves.toBe(true);
    expect(c.getBlock).not.toHaveBeenCalled();
  });

  it('canonical の hash が大文字小文字だけ違うのは同じブロックとして扱う', async () => {
    const c = client({ canonicalHash: BLOCK_HASH.toUpperCase().replace('0X', '0x') as Hex });
    await expect(read(c)).resolves.toBe(false);
  });

  it.each([
    ['receipt が revert でない', { receipt: { status: 'success' as const, blockNumber: BLOCK_NUMBER, blockHash: BLOCK_HASH } }],
    ['receipt に block hash が無い', { receipt: { status: 'reverted' as const, blockNumber: BLOCK_NUMBER, blockHash: null } }],
    ['receipt に block 番号が無い', { receipt: { status: 'reverted' as const, blockNumber: null, blockHash: BLOCK_HASH } }],
    ['receipt を読めない', { receipt: new Error('receipt not found') }],
    ['固定した読み取りに失敗 (そのブロックを持たない RPC ノード)', { used: new Error('header not found') }],
    ['読み取りの後にそのブロックが canonical でない', { canonicalHash: OTHER_BLOCK_HASH }],
    ['canonical の hash が取れない', { canonicalHash: null }],
  ])('%s → throw (未使用と言い切らない)', async (_label, over) => {
    await expect(read(client(over))).rejects.toThrow();
  });

  it('receipt が revert でない・hash が無いときは state を読まない', async () => {
    const c = client({ receipt: { status: 'reverted', blockNumber: BLOCK_NUMBER, blockHash: null } });
    await expect(read(c)).rejects.toThrow('revert_receipt_unpinnable');
    expect(c.readContract).not.toHaveBeenCalled();
  });
});
