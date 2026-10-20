// Arc の売上を受取アドレスのウォレットで全額引き出す部品 (lib/crossChain/arcPayout.ts)。
// 資金に関わる約束を固定する: 自分宛て・Arc → Arc・額 + 手数料 = 残高 (残高 0)・maxFee = 手数料ちょうど・
// Circle の応答を自分の署名と照合してから受け取りの取引を送る・失効した attestation は送らない。
import { describe, expect, it, vi } from 'vitest';
import { getAddress, pad, parseUnits, type Hex } from 'viem';
import {
  ArcPayoutError,
  arcPayoutChain,
  buildArcPayoutIntent,
  fetchArcPayoutFee,
  planArcPayout,
  readArcPayoutBalance,
  requestArcPayout,
  sendArcPayoutMint,
  type ArcPayoutAttestation,
} from '@/lib/crossChain/arcPayout';
import { GATEWAY_MINTER_ADDRESS, GATEWAY_WALLET_ADDRESS } from '@/lib/crossChain/config';
import { GatewayTransferRejectedError } from '@/lib/crossChain/gateway';
import { CIRCLE_DOMAIN_ARC, type BurnIntent } from '@/lib/crossChain/types';
import { gatewayAttestation } from '../../fixtures/gateway';

const DEPOSITOR = getAddress('0x52d4901142e2b5680027da5eb47c86cb02a3ca81');
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const BASE = 'https://gateway.test';

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
  const publicClient = {
    readContract: vi.fn(async () => 1_000n),
    getBlockNumber: vi.fn(async () => 500n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  };
  const deps = {
    walletClient: walletClient as never, publicClient: publicClient as never, switchChainAsync, fetch, baseUrl: BASE,
  };
  return { deps, walletClient, publicClient, switchChainAsync, fetch, signed };
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

describe('sendArcPayoutMint', () => {
  const pending: ArcPayoutAttestation = {
    depositor: DEPOSITOR, attestation: '0xaa', signature: '0xbb', expiresAtBlock: 1_000n, value: parseUnits('0.027', 6),
  };

  it('引き出し元のアカウントから Arc の GatewayMinter へ gatewayMint を送り、成功の receipt を待つ', async () => {
    const h = harness();
    await expect(sendArcPayoutMint(pending, h.deps)).resolves.toBe(`0x${'ab'.repeat(32)}`);
    expect(h.walletClient.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({
      account: DEPOSITOR, to: GATEWAY_MINTER_ADDRESS, chain: arcPayoutChain(),
    }));
  });

  it('失効 (Arc のブロック高が maxBlockHeight を過ぎた) attestation は送らない', async () => {
    const h = harness();
    h.publicClient.getBlockNumber.mockResolvedValue(1_001n);
    await expect(sendArcPayoutMint(pending, h.deps)).rejects.toMatchObject({ code: 'attestation_expired' });
    expect(h.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('取引が revert したら成功と言わない', async () => {
    const h = harness();
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    await expect(sendArcPayoutMint(pending, h.deps)).rejects.toMatchObject({ code: 'mint_reverted' });
  });
});
