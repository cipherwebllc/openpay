// Arc の売上を受取アドレスのウォレットで全額引き出す部品 (lib/crossChain/arcPayout.ts)。
// 資金に関わる約束を固定する: 自分宛て・Arc → Arc・額 + 手数料 = 残高 (残高 0)・maxFee = 手数料ちょうど・
// Circle の応答を自分の署名と照合してから受け取りの取引を送る・失効した attestation は送らない。
import { describe, expect, it, vi } from 'vitest';
import { getAddress, keccak256, pad, parseAbiItem, parseUnits, toEventSelector, type Hex } from 'viem';
import {
  ArcPayoutError,
  arcPayoutChain,
  buildArcPayoutIntent,
  fetchArcPayoutFee,
  planArcPayout,
  readArcPayoutBalance,
  requestArcPayout,
  completeArcPayout,
  type ArcPayoutAttestation,
} from '@/lib/crossChain/arcPayout';
import { GATEWAY_MINTER_ADDRESS, GATEWAY_WALLET_ADDRESS } from '@/lib/crossChain/config';
import { GatewayTransferRejectedError } from '@/lib/crossChain/gateway';
import { encodeGatewayTransferSpec } from '@/lib/crossChain/gatewayAttestation';
import { CIRCLE_DOMAIN_ARC, type BurnIntent } from '@/lib/crossChain/types';
import { gatewayAttestation } from '../../fixtures/gateway';

const DEPOSITOR = getAddress('0x52d4901142e2b5680027da5eb47c86cb02a3ca81');
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const ARC_USDC_FOR_LOG = ARC_USDC as Hex;
const BASE = 'https://gateway.test';
const SPEC_HASH = `0x${'5a'.repeat(32)}` as Hex;

/** GatewayMinter の AttestationUsed のログ (2026-10-21 の本番の取引と同じ形: transferSpecHash は topics[3])。 */
function attestationUsedLog(transferSpecHash: Hex) {
  return {
    address: GATEWAY_MINTER_ADDRESS,
    topics: [
      toEventSelector(parseAbiItem('event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)')),
      pad(ARC_USDC_FOR_LOG), pad(DEPOSITOR), transferSpecHash,
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function balanceRow(balance: string, extra: Record<string, unknown> = {}) {
  return { token: 'USDC', balances: [{ domain: 26, depositor: DEPOSITOR, balance, pendingBatch: '0', ...extra }] };
}

function feeEstimate(perIntent: unknown[]) {
  return { body: [], fees: { token: 'USDC', total: '0.018658', perIntent, forwardingFee: '0.015158' } };
}

describe('readArcPayoutBalance', () => {
  it('Arc (domain 26) の残高と精算待ちを atomic で返す', async () => {
    const fetch = vi.fn(async () => jsonResponse(balanceRow('0.030500', { pendingBatch: '0.0012' })));
    await expect(readArcPayoutBalance(DEPOSITOR, { fetch, baseUrl: BASE })).resolves.toEqual({
      status: 'ok', available: 30_500n, pending: 1_200n,
    });
    expect(fetch).toHaveBeenCalledWith(`${BASE}/v1/balances`, expect.objectContaining({ method: 'POST' }));
    const init = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init[1].body))).toEqual({ token: 'USDC', sources: [{ domain: 26, depositor: DEPOSITOR }] });
  });

  it('pendingBatch が無い応答は精算待ち不明 (null) — 0 と決めつけない', async () => {
    const row = balanceRow('1');
    delete (row.balances[0] as { pendingBatch?: string }).pendingBatch;
    const fetch = vi.fn(async () => jsonResponse(row));
    await expect(readArcPayoutBalance(DEPOSITOR, { fetch, baseUrl: BASE })).resolves.toEqual({
      status: 'ok', available: 1_000_000n, pending: null,
    });
  });

  it.each([
    ['別のアドレスの行', balanceRow('1', { depositor: '0x0000000000000000000000000000000000000001' })],
    ['別の domain の行', balanceRow('1', { domain: 6 })],
    ['行が 2 つ', { balances: [balanceRow('1').balances[0], balanceRow('1').balances[0]] }],
    ['行が無い', { balances: [] }],
    ['7 桁の小数', balanceRow('0.0000001')],
    ['数値型', balanceRow(1 as unknown as string)],
  ])('%s は信用せず error (偽の残高を出さない)', async (_label, body) => {
    const fetch = vi.fn(async () => jsonResponse(body));
    await expect(readArcPayoutBalance(DEPOSITOR, { fetch, baseUrl: BASE })).resolves.toMatchObject({ status: 'error' });
  });

  it('HTTP エラー・通信失敗は error (0 と表示させない)', async () => {
    await expect(readArcPayoutBalance(DEPOSITOR, { fetch: async () => jsonResponse({}, 503), baseUrl: BASE }))
      .resolves.toMatchObject({ status: 'error' });
    await expect(readArcPayoutBalance(DEPOSITOR, { fetch: async () => { throw new TypeError('offline'); }, baseUrl: BASE }))
      .resolves.toMatchObject({ status: 'error' });
  });
});

describe('fetchArcPayoutFee', () => {
  it('内訳 (baseFee) を読むため enableForwarder=true の見積もりを呼び、自分宛ての Arc → Arc の spec を送る', async () => {
    const fetch = vi.fn(async () => jsonResponse(feeEstimate([{ transferSpecHash: '0x', domain: 26, baseFee: '0.0035' }])));
    await expect(fetchArcPayoutFee(DEPOSITOR, 30_500n, { fetch, baseUrl: BASE })).resolves.toBe(3_500n);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/estimate?enableForwarder=true`);
    const [{ spec }] = JSON.parse(String(init.body));
    const self = pad(DEPOSITOR);
    expect(spec).toMatchObject({
      sourceDomain: 26, destinationDomain: 26, value: '30500',
      sourceDepositor: self, destinationRecipient: self, sourceSigner: self,
      destinationCaller: pad('0x00'),
    });
    expect(spec.sourceToken.toLowerCase()).toBe(pad(ARC_USDC).toLowerCase());
    expect(spec.destinationToken).toBe(spec.sourceToken);
  });

  it('transferFee があれば足す', async () => {
    const fetch = vi.fn(async () => jsonResponse(feeEstimate([{ domain: 26, baseFee: '0.0035', transferFee: '0.000002' }])));
    await expect(fetchArcPayoutFee(DEPOSITOR, 30_500n, { fetch, baseUrl: BASE })).resolves.toBe(3_502n);
  });

  it.each([
    ['内訳が無い (forwarder なしの形)', [{ burnIntent: { maxFee: '3850' } }]],
    ['domain が Arc でない', feeEstimate([{ domain: 6, baseFee: '0.01' }])],
    ['baseFee が無い', feeEstimate([{ domain: 26 }])],
    ['内訳が 2 つ', feeEstimate([{ domain: 26, baseFee: '0.0035' }, { domain: 26, baseFee: '0.0035' }])],
    ['token が USDC でない', { fees: { token: 'EURC', perIntent: [{ domain: 26, baseFee: '0.0035' }] } }],
  ])('%s なら投げる (文書の 0.0035 を仮定して署名させない)', async (_label, body) => {
    await expect(fetchArcPayoutFee(DEPOSITOR, 1n, { fetch: async () => jsonResponse(body), baseUrl: BASE })).rejects.toThrow();
  });

  it('HTTP エラーは投げる', async () => {
    await expect(fetchArcPayoutFee(DEPOSITOR, 1n, { fetch: async () => jsonResponse({}, 400), baseUrl: BASE })).rejects.toThrow('HTTP 400');
  });
});

describe('planArcPayout', () => {
  it('額 + 手数料 = 残高 (残高 0)・maxFee = 手数料ちょうど', () => {
    expect(planArcPayout(30_500n, 3_500n)).toEqual({ ok: true, value: 27_000n, maxFee: 3_500n });
  });
  it.each([[3_500n], [3_499n], [0n]])('残高 %s は手数料 3500 以下なので引き出せない', (available) => {
    expect(planArcPayout(available, 3_500n)).toEqual({ ok: false, reason: 'below_fee' });
  });
});

describe('buildArcPayoutIntent', () => {
  it('自分宛て・Arc → Arc・誰でも受け取りの取引を送れる (destinationCaller 0)・maxFee は指定どおり', () => {
    const intent = buildArcPayoutIntent({
      depositor: DEPOSITOR.toLowerCase() as Hex, value: 27_000n, maxFee: 3_500n,
      currentBlockHeight: 1_000n, withdrawalDelay: 1_000n, salt: pad('0x01'),
    });
    const self = pad(DEPOSITOR);
    expect(intent.maxFee).toBe(3_500n);
    expect(intent.maxBlockHeight).toBe(1_000n + 1_000n + 100n);
    expect(intent.spec).toEqual({
      version: 1, sourceDomain: CIRCLE_DOMAIN_ARC, destinationDomain: CIRCLE_DOMAIN_ARC,
      sourceContract: pad(GATEWAY_WALLET_ADDRESS), destinationContract: pad(GATEWAY_MINTER_ADDRESS),
      sourceToken: pad(ARC_USDC), destinationToken: pad(ARC_USDC),
      sourceDepositor: self, destinationRecipient: self, sourceSigner: self,
      destinationCaller: pad('0x00'), value: 27_000n, salt: pad('0x01'), hookData: '0x',
    });
  });
});

// requestArcPayout / sendArcPayoutMint のウォレットと Arc の RPC の代役。
function harness(opts: { balances?: string[]; fee?: string; transfer?: (intent: BurnIntent) => Response; chainId?: number } = {}) {
  const balances = [...(opts.balances ?? ['0.030500'])];
  const signed: BurnIntent[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/balances')) return jsonResponse(balanceRow(balances.shift() ?? '0'));
    if (url.includes('/v1/estimate')) return jsonResponse(feeEstimate([{ domain: 26, baseFee: opts.fee ?? '0.0035' }]));
    if (url.endsWith('/v1/transfer')) {
      const [{ burnIntent }] = JSON.parse(String(init?.body), (_k, v) => v);
      const intent = signed[signed.length - 1]!;
      expect(burnIntent.maxFee).toBe(intent.maxFee.toString());
      return opts.transfer ? opts.transfer(intent) : jsonResponse({ ...gatewayAttestation(intent.spec, 2_000n), transferId: 't' });
    }
    throw new Error(`unexpected ${url}`);
  });
  let chainId = opts.chainId ?? arcPayoutChain().id;
  const walletClient = {
    getChainId: vi.fn(async () => chainId),
    signTypedData: vi.fn(async (args: { message: BurnIntent }) => {
      signed.push(args.message);
      return `0x${'22'.repeat(65)}` as Hex;
    }),
    sendTransaction: vi.fn(async () => `0x${'ab'.repeat(32)}` as Hex),
  };
  const switchChainAsync = vi.fn(async ({ chainId: next }: { chainId: number }) => { chainId = next; });
  // GatewayMinter の受け取り済みの記録 (isTransferSpecHashUsed)。受け取りの取引が成功したら true にする。
  const minter = { minted: false, readFails: false };
  const publicClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'withdrawalDelay') return 1_000n;
      if (minter.readFails) throw new Error('rpc down');
      return minter.minted;
    }),
    getBlockNumber: vi.fn(async () => 500n),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      minter.minted = true;
      return { status: 'success', transactionHash: hash, blockNumber: 500n };
    }),
    // 既定: この引き出しの受け取り (GatewayMinter の AttestationUsed・spec hash 一致) を含む成功した取引
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({
      status: 'success', transactionHash: hash, to: GATEWAY_MINTER_ADDRESS, logs: [attestationUsedLog(SPEC_HASH)],
    })),
  };
  const deps = {
    walletClient: walletClient as never, publicClient: publicClient as never, switchChainAsync, fetch, baseUrl: BASE,
  };
  return { deps, walletClient, publicClient, switchChainAsync, fetch, signed, minter };
}

describe('requestArcPayout', () => {
  it('押した時点の残高で全額を決め直し、Arc に切り替えて署名し、照合した attestation を返す', async () => {
    const h = harness({ balances: ['0.050000'] });
    const steps: string[] = [];
    const pending = await requestArcPayout(DEPOSITOR, { ...h.deps, onStep: (s) => steps.push(s) });
    expect(steps).toEqual(['switching', 'signing', 'requesting']);
    expect(h.signed).toHaveLength(1);
    expect(h.signed[0]!.spec.value).toBe(46_500n);
    expect(h.signed[0]!.maxFee).toBe(3_500n);
    expect(pending).toMatchObject({ depositor: DEPOSITOR, value: 46_500n, expiresAtBlock: 2_000n });
    // 受け取りの成否を GatewayMinter の記録で確かめる鍵 = 署名した TransferSpec の hash
    expect(pending.transferSpecHash).toBe(keccak256(encodeGatewayTransferSpec(h.signed[0]!.spec)));
    expect(pending.txHash).toBeUndefined();
  });

  it('別のチェーンにいたら Arc へ切り替えてから署名する', async () => {
    const h = harness({ chainId: 8453 });
    await requestArcPayout(DEPOSITOR, h.deps);
    expect(h.switchChainAsync).toHaveBeenCalledWith({ chainId: arcPayoutChain().id });
    expect(h.switchChainAsync.mock.invocationCallOrder[0]).toBeLessThan(h.walletClient.signTypedData.mock.invocationCallOrder[0]!);
  });

  it('残高が手数料以下なら署名を求めない', async () => {
    const h = harness({ balances: ['0.0035'] });
    await expect(requestArcPayout(DEPOSITOR, h.deps)).rejects.toMatchObject({ code: 'below_fee' });
    expect(h.walletClient.signTypedData).not.toHaveBeenCalled();
  });

  it('残高を読めなければ署名を求めない', async () => {
    const h = harness();
    h.fetch.mockImplementationOnce(async () => jsonResponse({}, 503));
    await expect(requestArcPayout(DEPOSITOR, h.deps)).rejects.toBeInstanceOf(ArcPayoutError);
    expect(h.walletClient.signTypedData).not.toHaveBeenCalled();
  });

  it('Circle の拒否は GatewayTransferRejectedError (署名は 1 回だけ・作り直さない)', async () => {
    const h = harness({ transfer: () => jsonResponse({ message: 'maxFee too low' }, 400) });
    const err = await requestArcPayout(DEPOSITOR, h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayTransferRejectedError);
    expect((err as GatewayTransferRejectedError).definitive).toBe(true);
    expect(h.walletClient.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('Circle の応答が署名した内容 (受取人・額) と違えば送らずに投げる', async () => {
    const h = harness({
      transfer: (intent) => jsonResponse(gatewayAttestation({ ...intent.spec, destinationRecipient: pad('0xbad0') }, 2_000n)),
    });
    await expect(requestArcPayout(DEPOSITOR, h.deps)).rejects.toThrow('binding');
  });
});

describe('completeArcPayout (受け取りの取引)', () => {
  const TX = `0x${'ab'.repeat(32)}` as Hex;
  const base: ArcPayoutAttestation = {
    depositor: DEPOSITOR, attestation: '0xaa', signature: '0xbb', transferSpecHash: SPEC_HASH,
    expiresAtBlock: 1_000n, value: parseUnits('0.027', 6),
  };

  it('引き出し元のアカウントから Arc の GatewayMinter へ送り、送った直後に hash を知らせ、記録で受け取りを確かめる', async () => {
    const h = harness();
    const onBroadcast = vi.fn();
    await expect(completeArcPayout(base, { ...h.deps, onBroadcast })).resolves.toBe(TX);
    expect(h.walletClient.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({
      account: DEPOSITOR, to: GATEWAY_MINTER_ADDRESS, chain: arcPayoutChain(),
    }));
    expect(onBroadcast).toHaveBeenCalledWith(TX);
    // 受け取りの記録は、失効の判定と同じブロックの時点で読む
    expect(h.publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: GATEWAY_MINTER_ADDRESS, functionName: 'isTransferSpecHashUsed', args: [base.transferSpecHash], blockNumber: 500n,
    }));
  });

  it('すでに受け取り済み (記録あり) なら送らない', async () => {
    const h = harness();
    h.minter.minted = true;
    await expect(completeArcPayout(base, h.deps)).resolves.toBeNull();
    expect(h.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('手数料の上げ直し (repriced) で確定したら、確定した取引の hash を返す', async () => {
    const h = harness();
    const REPRICED = `0x${'cd'.repeat(32)}` as Hex;
    h.publicClient.waitForTransactionReceipt.mockImplementationOnce(async (args: unknown) => {
      (args as { onReplaced: (r: unknown) => void }).onReplaced({ reason: 'repriced', transaction: { hash: REPRICED } });
      h.minter.minted = true;
      return { status: 'success', transactionHash: REPRICED, blockNumber: 500n };
    });
    const onBroadcast = vi.fn();
    await expect(completeArcPayout(base, { ...h.deps, onBroadcast })).resolves.toBe(REPRICED);
    // 置き換え後の hash も残す (この後の読み取りが失敗しても、確かめ直しは置き換え後の取引を見る)
    expect(onBroadcast).toHaveBeenLastCalledWith(REPRICED);
  });

  it('ウォレットで取り消した (同じ nonce の別の取引が成功した) ら、成功と言わずに送り直せるようにする', async () => {
    const h = harness();
    const CANCEL = `0x${'ee'.repeat(32)}` as Hex;
    h.publicClient.waitForTransactionReceipt.mockImplementationOnce(async (args: unknown) => {
      (args as { onReplaced: (r: unknown) => void }).onReplaced({ reason: 'cancelled', transaction: { hash: CANCEL } });
      return { status: 'success', transactionHash: CANCEL, blockNumber: 500n };
    });
    await expect(completeArcPayout(base, h.deps)).rejects.toMatchObject({ code: 'mint_not_completed' });
  });

  it('receipt を待てない (RPC 障害) なら confirm_unknown — 確かめ直しは同じ hash の結果を見て、送り直さない', async () => {
    const h = harness();
    h.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error('rpc timeout'));
    const onBroadcast = vi.fn();
    await expect(completeArcPayout(base, { ...h.deps, onBroadcast })).rejects.toMatchObject({ code: 'confirm_unknown' });
    expect(onBroadcast).toHaveBeenCalledWith(TX);

    // 確かめ直し (hash つき): 送らずに同じ hash の receipt を待ち、記録で受け取りを確かめる
    await expect(completeArcPayout({ ...base, txHash: TX }, h.deps)).resolves.toBe(TX);
    expect(h.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.waitForTransactionReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ hash: TX }));
  });

  it('receipt を待てなくても、記録で受け取り済みと分かれば成功', async () => {
    const h = harness();
    h.publicClient.waitForTransactionReceipt.mockImplementationOnce(async () => {
      h.minter.minted = true;
      throw new Error('rpc timeout');
    });
    await expect(completeArcPayout(base, h.deps)).resolves.toBe(TX);
  });

  it('送った取引が消えて receipt が出ないまま失効したら attestation_expired で終わる (確かめ直しを続けさせない)', async () => {
    const h = harness();
    h.publicClient.waitForTransactionReceipt.mockRejectedValue(new Error('not found'));
    h.publicClient.getBlockNumber.mockResolvedValueOnce(900n).mockResolvedValue(1_001n);
    await expect(completeArcPayout({ ...base, txHash: TX }, h.deps)).rejects.toMatchObject({ code: 'attestation_expired' });
    expect(h.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('確定の後に記録を読めない (RPC 障害) なら confirm_unknown — 「送り直せる」とは言わない', async () => {
    const h = harness();
    h.publicClient.waitForTransactionReceipt.mockImplementationOnce(async ({ hash }: { hash: Hex }) => {
      h.minter.readFails = true;
      return { status: 'success', transactionHash: hash, blockNumber: 500n };
    });
    await expect(completeArcPayout(base, h.deps)).rejects.toMatchObject({ code: 'confirm_unknown' });
  });

  it('取引の確定より古い状態 (遅れた RPC) で「受け取っていない」と決めない — confirm_unknown のまま送り直させない', async () => {
    const h = harness();
    h.publicClient.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: TX, blockNumber: 600n });
    await expect(completeArcPayout(base, h.deps)).rejects.toMatchObject({ code: 'confirm_unknown' });
  });

  it('結果が分からない間に別の取引で受け取っていたら、残した hash は受け取りの取引と確かめられたときだけ返す', async () => {
    const h = harness();
    h.minter.minted = true;
    await expect(completeArcPayout({ ...base, txHash: TX }, h.deps)).resolves.toBe(TX);
    h.publicClient.getTransactionReceipt.mockResolvedValueOnce(null as never);
    await expect(completeArcPayout({ ...base, txHash: TX }, h.deps)).resolves.toBeNull();
    // 成功しても、この引き出しの受け取りの記録 (AttestationUsed) が無い取引 (取り消し・別の引き出し) は返さない
    h.publicClient.getTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: TX, to: GATEWAY_MINTER_ADDRESS, logs: [] } as never);
    await expect(completeArcPayout({ ...base, txHash: TX }, h.deps)).resolves.toBeNull();
    h.publicClient.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success', transactionHash: TX, to: GATEWAY_MINTER_ADDRESS, logs: [attestationUsedLog(`0x${'99'.repeat(32)}`)],
    } as never);
    await expect(completeArcPayout({ ...base, txHash: TX }, h.deps)).resolves.toBeNull();
    expect(h.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('EIP-7702 のスマートアカウントが委任の仕組みを経由して送った (to が GatewayMinter でない) 取引も、受け取りの記録があれば返す', async () => {
    const h = harness();
    h.minter.minted = true;
    // 2026-10-21 の本番の引き出し: to = 委任の仕組みのコントラクト・GatewayMinter の AttestationUsed を含む
    h.publicClient.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success', transactionHash: TX, to: '0xdb9b1e94b5b69df7e401ddbede43491141047db3', logs: [attestationUsedLog(SPEC_HASH)],
    } as never);
    await expect(completeArcPayout({ ...base, txHash: TX }, h.deps)).resolves.toBe(TX);
  });

  it('まだ送っていないとき、記録を読めなければ送らない', async () => {
    const h = harness();
    h.minter.readFails = true;
    await expect(completeArcPayout(base, h.deps)).rejects.toThrow('rpc down');
    expect(h.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('失効 (Arc のブロック高が maxBlockHeight を過ぎた) attestation は送らない', async () => {
    const h = harness();
    h.publicClient.getBlockNumber.mockResolvedValue(1_001n);
    await expect(completeArcPayout(base, h.deps)).rejects.toMatchObject({ code: 'attestation_expired' });
    expect(h.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('取引が revert して記録も無ければ成功と言わない (失効前は送り直せる・失効後は attestation_expired)', async () => {
    const h = harness();
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted', transactionHash: TX, blockNumber: 500n });
    await expect(completeArcPayout(base, h.deps)).rejects.toMatchObject({ code: 'mint_not_completed' });
    h.publicClient.getBlockNumber.mockResolvedValueOnce(500n).mockResolvedValueOnce(1_001n);
    await expect(completeArcPayout(base, h.deps)).rejects.toMatchObject({ code: 'attestation_expired' });
  });
});
