// @vitest-environment node
// 第 9 回レビュー C-1 (license 側): 受け取り確認の mintFor simulate で、OZ ERC-1155 の受け取り確認は payer の
// revert をそのまま返す。payer (7702 委任済み EOA 等) が sender=license contract の OffchainLookup を返すと、
// viem の call は to と sender が一致するので、licenseRpc が CCIP-Read を追うと任意の URL へサーバーが fetch する。
// licenseRpc と viem の CCIP の経路は mock せず、本物の http transport を通す。global fetch を偽の RPC ノードにし、
// RPC の URL 以外への fetch (= CCIP-Read の gateway への fetch) が 0 回であることを見る。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, isAddressEqual, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { polygonAmoy } from 'viem/chains';

vi.mock('@/lib/chains', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/chains')>(),
  chainObjectForId: () => polygonAmoy,
  customRpcUrlForChain: () => 'https://rpc.example',
}));
vi.mock('@/lib/license/config', () => ({ licenseNftEnabled: () => true }));

import { checkLicenseRecipient } from '@/lib/license/recipient';
import { createLicenseDefinition } from '@/lib/license/definition';

const RPC_URL = 'https://rpc.example';
const LICENSE = '0x3333333333333333333333333333333333333333';
const MINTER = '0x2222222222222222222222222222222222222222';
const PAYER = '0x1111111111111111111111111111111111111111';
const MINTER_SELECTOR = toFunctionSelector('minter()');
const MINT_FOR_SELECTOR = toFunctionSelector('mintFor(address,uint256,bytes32)');
const MINT_FOR_ABI = parseAbi(['function mintFor(address to,uint256 id,bytes32 paymentKey)']);
const OFFCHAIN_LOOKUP_ABI = parseAbi([
  'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)',
]);
const ATTACKER_URLS = ['http://169.254.169.254/latest/meta-data/{data}', 'https://ssrf.attacker.invalid/{sender}/{data}.json'];
const d = createLicenseDefinition('h_' + 'a'.repeat(32), { supply: 10, transferable: false, termsUrl: 'https://seller.example', termsVersion: '1' }, 80002, LICENSE);

type RpcTx = { from?: string; to?: string; data?: string };

describe('checkLicenseRecipient: CCIP-Read を追わない (C-1)', () => {
  const rpcCalls: Array<{ method: string; params: unknown[] }> = [];
  const nonRpcFetches: string[] = [];

  beforeEach(() => {
    rpcCalls.length = 0;
    nonRpcFetches.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 偽の RPC ノード: minter() は MINTER を返す。mintFor の simulate は license contract の _mint → ERC-1155 の受け取り
  // 確認を模擬する: payer の onERC1155Received が selector を返す (accept) なら成功、revert するなら OZ
  // ERC1155Utils と同じく revert data をそのまま返す (JSON-RPC の code 3 + data)。
  // RPC の URL 以外への fetch は記録だけして 500 を返す (変異で ccipRead を戻したときも本物の通信をしない)。
  function stubRpcNode(onReceived: { accept: true } | { revert: Hex }) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // licenseTransport は Request 経由の URL (末尾 / 付き) で fetch するので、正規化して比べる。
      if (new URL(url).href !== new URL(RPC_URL).href) {
        nonRpcFetches.push(url);
        return new Response('blocked in test', { status: 500 });
      }
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      rpcCalls.push({ method: body.method, params: body.params });
      const reply = (payload: Record<string, unknown>) => new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
      const tx = (body.params?.[0] ?? {}) as RpcTx;
      if (body.method === 'eth_call' && tx.data?.startsWith(MINTER_SELECTOR)) {
        return reply({ result: encodeAbiParameters([{ type: 'address' }], [MINTER]) });
      }
      if (body.method === 'eth_call' && tx.data?.startsWith(MINT_FOR_SELECTOR)) {
        const { args } = decodeFunctionData({ abi: MINT_FOR_ABI, data: tx.data as Hex });
        if (!isAddressEqual(args[0], PAYER)) return reply({ error: { code: 3, message: 'execution reverted', data: '0x' } });
        // mintFor は戻り値なし = 成功は空の result。
        if ('accept' in onReceived) return reply({ result: '0x' });
        return reply({ error: { code: 3, message: 'execution reverted', data: onReceived.revert } });
      }
      return reply({ error: { code: -32601, message: 'unexpected method in test: ' + body.method } });
    }));
  }

  // 空振りでないこと: license contract への mintFor の eth_call (from = on-chain の minter) まで実際に届いた。
  const mintForCalls = () => rpcCalls.filter((c) => {
    const tx = (c.params?.[0] ?? {}) as RpcTx;
    return c.method === 'eth_call'
      && tx.to?.toLowerCase() === LICENSE.toLowerCase()
      && tx.from?.toLowerCase() === MINTER.toLowerCase()
      && tx.data?.startsWith(MINT_FOR_SELECTOR);
  });

  it('payer の受け取り確認が sender=license contract の OffchainLookup を返しても、RPC 以外へ fetch しない', async () => {
    // OZ ERC1155Utils.checkOnERC1155Received が payer の revert をそのまま返した形。sender は呼び先の license contract。
    const lookupRevert: Hex = encodeErrorResult({
      abi: OFFCHAIN_LOOKUP_ABI,
      errorName: 'OffchainLookup',
      args: [LICENSE, ATTACKER_URLS, '0x', '0x12345678', '0x'],
    });
    expect(lookupRevert.slice(0, 10)).toBe('0x556f1830'); // viem utils/ccip.ts の offchainLookupSignature
    stubRpcNode({ revert: lookupRevert });

    // 確定した receiver 拒否 (ERC1155InvalidReceiver) ではないので、従来どおり unknown (= 503 license_simulation_unavailable)。
    expect(await checkLicenseRecipient(d, PAYER)).toBe('unknown');

    expect(nonRpcFetches).toEqual([]);
    expect(mintForCalls()).toHaveLength(1);
  });

  // 回帰: ccipRead:false のまま、正常な受け取り側 (onERC1155Received が selector を返す) は supported になる。
  it('正常な受け取り側 (onERC1155Received が selector を返す) は supported・RPC 以外へ fetch しない', async () => {
    stubRpcNode({ accept: true });

    expect(await checkLicenseRecipient(d, PAYER)).toBe('supported');

    expect(nonRpcFetches).toEqual([]);
    expect(mintForCalls()).toHaveLength(1);
  });
});
