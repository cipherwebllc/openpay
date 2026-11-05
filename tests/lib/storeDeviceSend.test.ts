import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// createDeviceIo の RPC (最新ブロックの時刻だけ使う)。
const rpcHold = vi.hoisted(() => ({ blockTime: 0n }));
vi.mock('@/lib/chains', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chains')>()),
  transportForChain: (chainId: number) =>
    custom({
      async request({ method }: { method: string }) {
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method === 'eth_getBlockByNumber') {
          return { number: '0x1', hash: `0x${'aa'.repeat(32)}`, timestamp: `0x${rpcHold.blockTime.toString(16)}`, transactions: [] };
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
}));
import {
  buildForwarderNonce,
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import {
  STORE_DEVICE_SENT_KEY,
  addSentMark,
  createDeviceIo,
  readSentMarks,
  removeSentMark,
  sentMarkWrittenThisTab,
  receiptHasSettlement,
  sendStoreDeviceSettle,
  verifyDeviceAuth,
  type DeviceAuth,
  type DeviceExpectation,
  type DeviceSendIo,
  type DeviceSentMark,
} from '@/lib/storeDeviceSend';

const CHAIN = 80002;
const JPYC = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FWD = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const FEE = getAddress('0x428483FbA62eDCef1E3a100d3799F6d71759c560');
const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const AMOUNT = 1000n * 10n ** 18n;
const NOW = 1_800_000_000n;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const RAW = '0x02f8' as Hex;
const customer = privateKeyToAccount(generatePrivateKey());
const exp: DeviceExpectation = { chainId: CHAIN, token: JPYC, forwarder: FWD, feeReceiver: FEE, merchant: SHOP, amount: AMOUNT };

async function signedAuth(over: Partial<ForwarderSettleParams> = {}, signer = customer): Promise<DeviceAuth> {
  const p: ForwarderSettleParams = {
    from: customer.address,
    merchant: SHOP,
    merchantValue: AMOUNT,
    feeReceiver: FEE,
    feeValue: 1n,
    validAfter: 0n,
    validBefore: NOW + 150n,
    intentSalt: `0x${'11'.repeat(32)}` as Hex,
    ...over,
  };
  const signature = await signer.signTypedData(buildReceiveWithAuthorizationTypedData(p, CHAIN, JPYC, FWD));
  return {
    from: p.from,
    merchantValue: p.merchantValue.toString(),
    feeValue: p.feeValue.toString(),
    validAfter: p.validAfter.toString(),
    validBefore: p.validBefore.toString(),
    intentSalt: p.intentSalt,
    signature,
    nonce: buildForwarderNonce(p, CHAIN, FWD),
  };
}

async function verified(over: Partial<ForwarderSettleParams> = {}) {
  const r = await verifyDeviceAuth({ merchant: SHOP, amount: AMOUNT.toString(), auth: await signedAuth(over) }, exp);
  if (!r.ok) throw new Error(`setup ${r.reason}`);
  return r.value;
}

describe('verifyDeviceAuth (サーバを信じ切らず、自分が作ったセッションと照合する)', () => {
  it('セッションどおりで本人の署名なら通る (nonce と分割額を返す)', async () => {
    const r = await verifyDeviceAuth({ merchant: SHOP, amount: AMOUNT.toString(), auth: await signedAuth() }, exp);
    expect(r).toMatchObject({ ok: true, value: { params: { from: customer.address, merchant: SHOP, merchantValue: AMOUNT, feeValue: 1n, feeReceiver: FEE } } });
  });

  it.each([
    ['受取先が違う (受け渡しが別の店を返した)', async () => ({ merchant: FEE, amount: AMOUNT.toString(), auth: await signedAuth() }), 'merchant_mismatch'],
    ['金額が違う (セッション)', async () => ({ merchant: SHOP, amount: '1', auth: await signedAuth() }), 'amount_mismatch'],
    ['金額が違う (署名)', async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: await signedAuth({ merchantValue: AMOUNT - 1n }) }), 'amount_mismatch'],
    ['手数料欄が 1 wei でない', async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: await signedAuth({ feeValue: 2n }) }), 'fee_mismatch'],
    ['validAfter が 0 でない', async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: await signedAuth({ validAfter: 5n }) }), 'not_yet_valid'],
    ['salt が 0', async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: await signedAuth({ intentSalt: `0x${'00'.repeat(32)}` as Hex }) }), 'zero_salt'],
    ['nonce が中身と合わない', async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: { ...(await signedAuth()), nonce: `0x${'22'.repeat(32)}` } }), 'nonce_mismatch'],
    ['別人の署名', async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: await signedAuth({}, privateKeyToAccount(generatePrivateKey())) }), 'signature_mismatch'],
    ['壊れた値', async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: { ...(await signedAuth()), signature: '0x12' } }), 'malformed'],
    // 第 9 回レビュー F-05: 78 桁でも uint256 を超える値は形の違う値 (nonce の計算で例外にして拒否の理由を失わない)。
    // uint256 の上限は約 1.16 × 10^77 (78 桁) なので、範囲外は「上限 + 1」から「78 桁の 9」まで。
    [
      'validBefore が uint256 の上限 + 1 (改ざんされた応答)',
      async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: { ...(await signedAuth()), validBefore: (maxUint256 + 1n).toString() } }),
      'malformed',
    ],
    [
      'validBefore が 78 桁の 9 (改ざんされた応答)',
      async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: { ...(await signedAuth()), validBefore: '9'.repeat(78) } }),
      'malformed',
    ],
    [
      'validBefore が uint256 の上限ちょうど (形は正しい・中身が署名と合わない)',
      async () => ({ merchant: SHOP, amount: AMOUNT.toString(), auth: { ...(await signedAuth()), validBefore: maxUint256.toString() } }),
      'nonce_mismatch',
    ],
  ])('%s → 送らない', async (_, view, reason) => {
    expect(await verifyDeviceAuth(await view(), exp)).toEqual({ ok: false, reason });
  });

  it('手数料受取口が違う設定で作った署名は nonce が合わない (別の受取口へ 1 wei を流さない)', async () => {
    const auth = await signedAuth({ feeReceiver: getAddress('0x0000000000000000000000000000000000000fee') });
    expect(await verifyDeviceAuth({ merchant: SHOP, amount: AMOUNT.toString(), auth }, exp)).toMatchObject({ ok: false });
  });
});

type Calls = string[];
function fakeIo(calls: Calls, over: Partial<DeviceSendIo> = {}): DeviceSendIo {
  return {
    chainNowSec: async () => {
      calls.push('now');
      return NOW;
    },
    authorizationUsed: async () => {
      calls.push('used');
      return false;
    },
    tokenBalance: async () => {
      calls.push('balance');
      return AMOUNT * 2n;
    },
    nativeBalance: async () => {
      calls.push('native');
      return 10n ** 18n;
    },
    simulate: async () => {
      calls.push('simulate');
    },
    estimateGas: async () => {
      calls.push('estimate');
      return 250_000n;
    },
    pendingNonce: async () => {
      calls.push('nonce');
      return 7;
    },
    signTx: async (_data, gas, nonce) => {
      calls.push(`sign:${gas}:${nonce}`);
      return { raw: RAW, hash: HASH, maxFeePerGas: 50n * 10n ** 9n };
    },
    sendRawTransaction: async () => {
      calls.push(`send:marked=${readSentMarks().ok && (readSentMarks() as { marks: DeviceSentMark[] }).marks.length > 0}`);
    },
    withLock: async (fn) => {
      calls.push('lock');
      return fn();
    },
    nowMs: () => Number(NOW) * 1000,
    ...over,
  };
}
const ctx = { handoffId: 'AAAAAAAAAAAAAAAAAAAAAA', chainId: CHAIN, forwarder: FWD };

describe('sendStoreDeviceSettle (二重に送らない・鍵は送る直前に)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('ロックの中で確かめて署名し、印を保存してから送る (見積 × 1.2・pending の nonce)', async () => {
    const calls: Calls = [];
    const v = await verified();
    expect(await sendStoreDeviceSettle(v, ctx, fakeIo(calls))).toMatchObject({ kind: 'sent', hash: HASH, mark: { hash: HASH } });
    expect(calls).toEqual(['lock', 'now', 'used', 'balance', 'native', 'simulate', 'estimate', 'nonce', 'sign:300000:7', 'native', 'send:marked=true']);
    const marks = readSentMarks();
    expect(marks).toMatchObject({ ok: true, marks: [{ nonce: v.nonce, hash: HASH, amount: AMOUNT.toString(), handoffId: ctx.handoffId }] });
  });

  it('同じ署名の印があれば署名も送信もしない (別タブ・再読み込み前に送った)', async () => {
    const calls: Calls = [];
    const v = await verified();
    await sendStoreDeviceSettle(v, ctx, fakeIo([]));
    expect(await sendStoreDeviceSettle(v, ctx, fakeIo(calls))).toMatchObject({ kind: 'already', hash: HASH, mark: { hash: HASH } });
    expect(calls).toEqual(['lock']);
  });

  it('印を読めない端末では送らない (読めないのを「印なし」と扱わない)', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      const calls: Calls = [];
      expect(await sendStoreDeviceSettle(await verified(), ctx, fakeIo(calls))).toEqual({ kind: 'not_sent', reason: 'storage' });
      expect(calls).toEqual(['lock']);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['残り 14 秒 (ブロック時刻で測る)', { chainNowSec: async () => NOW + 136n }, 'expiring'],
    ['期限が遠すぎる (時計の想定外)', { chainNowSec: async () => NOW - 100n }, 'expiring'],
    ['使用済み', { authorizationUsed: async () => true }, 'used'],
    ['お客様の残高が請求額 + 1 wei に足りない', { tokenBalance: async () => AMOUNT }, 'customer_balance'],
    ['simulate が revert', { simulate: async () => { throw new Error('revert'); } }, 'simulate_failed'],
    ['見積 × 1.2 が上限 500,000 を超える (切り詰めない)', { estimateGas: async () => 420_000n }, 'gas_limit'],
    ['ガス代が 0.2 POL を超える (Amoy)', { signTx: async () => ({ raw: RAW, hash: HASH, maxFeePerGas: 10n ** 12n }) }, 'gas_too_high'],
    ['POL が足りない', { nativeBalance: async () => 10n ** 15n }, 'native_insufficient'],
    [
      'POL が 0 (見積もりの失敗に見せない)',
      {
        nativeBalance: async (): Promise<bigint> => 0n,
        estimateGas: async (): Promise<bigint> => {
          throw new Error('insufficient funds for gas');
        },
      } as Partial<DeviceSendIo>,
      'native_insufficient',
    ],
    ['鍵が読めない・RPC 障害', { signTx: async () => { throw new Error('no_key'); } }, 'rpc'],
  ])('%s → 送らない・印を残さない', async (_, over, reason) => {
    const sends: Calls = [];
    const io = fakeIo([], { ...over, sendRawTransaction: async () => { sends.push('send'); } } as Partial<DeviceSendIo>);
    expect(await sendStoreDeviceSettle(await verified(), ctx, io)).toEqual({ kind: 'not_sent', reason });
    expect(sends).toHaveLength(0);
    expect(readSentMarks()).toEqual({ ok: true, marks: [] });
  });

  it('印を保存できなければ送らない', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const sends: Calls = [];
    try {
      const io = fakeIo([], { sendRawTransaction: async () => { sends.push('send'); } });
      expect(await sendStoreDeviceSettle(await verified(), ctx, io)).toEqual({ kind: 'not_sent', reason: 'storage' });
    } finally {
      spy.mockRestore();
    }
    expect(sends).toHaveLength(0);
  });

  it.each([
    ['already known (届いている)', 'already known'],
    ['通信断・timeout (届いたか分からない)', 'fetch failed'],
  ])('送信の失敗が %s → 送ったかもしれない: hash を見る (印は残す・再送しない)', async (_, message) => {
    const io = fakeIo([], { sendRawTransaction: async () => { throw new Error(message); } });
    expect(await sendStoreDeviceSettle(await verified(), ctx, io)).toMatchObject({ kind: 'sent', hash: HASH, mark: { hash: HASH } });
    expect(readSentMarks()).toMatchObject({ ok: true, marks: [{ hash: HASH }] });
  });

  it.each([
    ['insufficient funds', 'native_insufficient'],
    ['nonce too low', 'send_rejected'],
  ])('届いていないと確実 (%s) で、未使用を確かめられたら印を消して「送れませんでした」', async (message, reason) => {
    const io = fakeIo([], { sendRawTransaction: async () => { throw new Error(message); } });
    expect(await sendStoreDeviceSettle(await verified(), ctx, io)).toEqual({ kind: 'not_sent', reason });
    expect(readSentMarks()).toEqual({ ok: true, marks: [] });
  });

  it('届いていないはずでも、使用済み・確かめられないなら「送ったかもしれない」のまま (印を残す)', async () => {
    let n = 0;
    const usedAfter = fakeIo([], {
      authorizationUsed: async () => n++ > 0,
      sendRawTransaction: async () => { throw new Error('insufficient funds'); },
    });
    expect(await sendStoreDeviceSettle(await verified(), ctx, usedAfter)).toMatchObject({ kind: 'sent', hash: HASH, mark: { hash: HASH } });
    window.localStorage.clear();
    let m = 0;
    const unreadable = fakeIo([], {
      authorizationUsed: async () => {
        if (m++ > 0) throw new Error('rpc');
        return false;
      },
      sendRawTransaction: async () => { throw new Error('insufficient funds'); },
    });
    expect(await sendStoreDeviceSettle(await verified(), ctx, unreadable)).toMatchObject({ kind: 'sent', hash: HASH, mark: { hash: HASH } });
    expect(readSentMarks()).toMatchObject({ ok: true, marks: [{ hash: HASH }] });
  });

  it('古い印 (1 時間) は保存のたびに捨てる', async () => {
    const old: DeviceSentMark = {
      handoffId: 'x', chainId: CHAIN, nonce: `0x${'01'.repeat(32)}`, hash: `0x${'02'.repeat(32)}`, from: customer.address,
      merchant: SHOP, amount: '1', validBefore: '1', intentSalt: `0x${'03'.repeat(32)}`, at: 0,
    };
    window.localStorage.setItem(STORE_DEVICE_SENT_KEY, JSON.stringify([old]));
    expect(addSentMark({ ...old, nonce: `0x${'04'.repeat(32)}`, hash: HASH, at: 3_600_001 }, 3_600_001)).toBe(true);
    expect(readSentMarks()).toMatchObject({ ok: true, marks: [{ hash: HASH }] });
  });

  // #762: 送信の後に端末の保存領域が読めなくなっても「送った可能性」を取りこぼさないよう、このタブで書いた印の写しを持つ。
  it('このタブで書いて確かめた印は、保存領域が読めなくなっても nonce で引ける・消した印は引けない', () => {
    const mark: DeviceSentMark = {
      handoffId: 'x', chainId: CHAIN, nonce: `0x${'0a'.repeat(32)}`, hash: `0x${'0b'.repeat(32)}`, from: customer.address,
      merchant: SHOP, amount: '1', validBefore: '1', intentSalt: `0x${'0c'.repeat(32)}`, at: 1,
    };
    expect(addSentMark(mark, 1)).toBe(true);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      expect(readSentMarks()).toEqual({ ok: false });
      expect(sentMarkWrittenThisTab(mark.nonce.toUpperCase().replace('0X', '0x'))).toEqual(mark);
    } finally {
      getItem.mockRestore();
    }
    expect(removeSentMark(mark.hash)).toBe(true);
    expect(sentMarkWrittenThisTab(mark.nonce)).toBeNull();
  });
});

// 第 9 回レビュー E-8: 壊れた印 (空文字・JSON でない・配列でない・形の違う印を含む) を「印なし」と読む・形の違う印だけを
// 捨てて上書きすると、別タブ・再読み込み前の未解決の印を消し、同じ会計をもう一度送りうる → 読めない扱い
// (ok: false・corrupt) にし、その上に書かない。
describe('壊れた送信済みの印 (読めない扱いにし、上書きしない)', () => {
  const mark: DeviceSentMark = {
    handoffId: 'x', chainId: CHAIN, nonce: `0x${'0d'.repeat(32)}`, hash: `0x${'0e'.repeat(32)}`, from: customer.address,
    merchant: SHOP, amount: '1', validBefore: '1', intentSalt: `0x${'0f'.repeat(32)}`, at: 1,
  };
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([
    ['空文字 (このモジュールは書かない値)', ''],
    ['JSON でない', '[{"hash":'],
    ['配列でない (オブジェクト)', JSON.stringify({ marks: [mark] })],
    ['配列でない (null)', 'null'],
    ['配列でない (文字列)', JSON.stringify('x')],
    ['形の違う要素を含む', JSON.stringify([{ junk: true }, mark])],
    ['nonce・hash は正しく時刻だけ壊れた印', JSON.stringify([{ ...mark, at: 'x' }])],
  ])('%s → readSentMarks は ok: false (corrupt)・addSentMark / removeSentMark は書き戻さない', (_, raw) => {
    window.localStorage.setItem(STORE_DEVICE_SENT_KEY, raw);
    expect(readSentMarks()).toEqual({ ok: false, corrupt: true });
    const other = { ...mark, nonce: `0x${'2d'.repeat(32)}` as Hex, hash: `0x${'2e'.repeat(32)}` as Hex };
    expect(addSentMark(other, 1)).toBe(false);
    expect(window.localStorage.getItem(STORE_DEVICE_SENT_KEY)).toBe(raw);
    expect(sentMarkWrittenThisTab(other.nonce)).toBeNull();
    expect(removeSentMark(mark.hash)).toBe(false);
    expect(window.localStorage.getItem(STORE_DEVICE_SENT_KEY)).toBe(raw);
  });

  // 起動時に止めるのは値が壊れているときだけ (保存そのものを読めない端末 = サイトデータの拒否は止めない・user 裁定)。
  it('保存そのものを読めない (getItem の例外) ときは ok: false だけ (値が壊れている corrupt と区別する)', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      expect(readSentMarks()).toEqual({ ok: false });
    } finally {
      getItem.mockRestore();
    }
  });

  it('壊れた印の端末では送らない (署名・送信をせず、印の値もそのまま)', async () => {
    const raw = '{not json';
    window.localStorage.setItem(STORE_DEVICE_SENT_KEY, raw);
    const calls: Calls = [];
    const sends: Calls = [];
    const io = fakeIo(calls, { sendRawTransaction: async () => { sends.push('send'); } });
    expect(await sendStoreDeviceSettle(await verified(), ctx, io)).toEqual({ kind: 'not_sent', reason: 'storage' });
    expect(calls).toEqual(['lock']);
    expect(sends).toHaveLength(0);
    expect(window.localStorage.getItem(STORE_DEVICE_SENT_KEY)).toBe(raw);
  });

  // Codex の再現: 同じ署名 (nonce) を送った印の時刻だけが壊れていると、形の違う印として捨てて「前に送った印なし」と読み、
  // 同じ署名をもう一度送って印を上書きしていた。
  it('同じ署名を送った印の時刻だけが壊れていても、もう一度送らず、印を上書きしない', async () => {
    const v = await verified();
    const raw = JSON.stringify([{ ...mark, nonce: v.nonce, hash: HASH, at: 'x' }]);
    window.localStorage.setItem(STORE_DEVICE_SENT_KEY, raw);
    const calls: Calls = [];
    const sends: Calls = [];
    const io = fakeIo(calls, { sendRawTransaction: async () => { sends.push('send'); } });
    expect(await sendStoreDeviceSettle(v, ctx, io)).toEqual({ kind: 'not_sent', reason: 'storage' });
    expect(calls).toEqual(['lock']);
    expect(sends).toHaveLength(0);
    expect(window.localStorage.getItem(STORE_DEVICE_SENT_KEY)).toBe(raw);
  });

  it('正常な値は従来どおり (保存なし・空の配列・印の配列は読める・足せる)', () => {
    expect(readSentMarks()).toEqual({ ok: true, marks: [] });
    window.localStorage.setItem(STORE_DEVICE_SENT_KEY, '[]');
    expect(readSentMarks()).toEqual({ ok: true, marks: [] });
    window.localStorage.setItem(STORE_DEVICE_SENT_KEY, JSON.stringify([mark]));
    expect(readSentMarks()).toEqual({ ok: true, marks: [mark] });
    const next = { ...mark, nonce: `0x${'1d'.repeat(32)}` as Hex, hash: `0x${'1e'.repeat(32)}` as Hex };
    expect(addSentMark(next, 1)).toBe(true);
    expect(readSentMarks()).toEqual({ ok: true, marks: [mark, next] });
  });
});

describe('ガス代の上限はチェーンごと (ネイティブ通貨の単位が違う)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // ガス上限は 見積 25 万 × 1.2 = 30 万。cost = 30 万 × maxFeePerGas。
  it.each([
    ['Polygon: 0.06 POL は送る', 137, 2n * 10n ** 11n, 'sent'],
    ['Avalanche: 同じ 0.06 AVAX は上限 0.05 を超えるので送らない', 43114, 2n * 10n ** 11n, 'gas_too_high'],
    ['Avalanche: 0.03 AVAX は送る', 43114, 10n ** 11n, 'sent'],
    ['Kaia: 0.45 KAIA は送る (上限 0.5)', 8217, 15n * 10n ** 11n, 'sent'],
    ['Polygon: 同じ 0.45 POL は上限 0.2 を超えるので送らない', 137, 15n * 10n ** 11n, 'gas_too_high'],
    ['上限の表に無いチェーンは送らない (集合とずれたまま黙って送らない)', 1, 10n ** 9n, 'gas_too_high'],
  ] as const)('%s', async (_, chainId, maxFeePerGas, expected) => {
    const sends: Calls = [];
    const io = fakeIo([], {
      signTx: async () => ({ raw: RAW, hash: HASH, maxFeePerGas }),
      sendRawTransaction: async () => {
        sends.push('send');
      },
    });
    const r = await sendStoreDeviceSettle(await verified(), { ...ctx, chainId }, io);
    if (expected === 'sent') {
      expect(r).toMatchObject({ kind: 'sent', mark: { chainId } });
      expect(sends).toHaveLength(1);
    } else {
      expect(r).toEqual({ kind: 'not_sent', reason: expected });
      expect(sends).toHaveLength(0);
    }
  });
});

describe('createDeviceIo の「いま」(期限の判定)', () => {
  const io = (chainId = 43113) => createDeviceIo({ chainId, token: JPYC, forwarder: FWD, gasAddress: SHOP });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Number(NOW) * 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('最新ブロックが古い (Avalanche でブロックが出ていない) ときは端末の時計を使う (期限ぎりぎりを送らない)', async () => {
    rpcHold.blockTime = NOW - 40n;
    expect(await io().chainNowSec()).toBe(NOW);
  });

  it('ブロック時刻が端末の時計より進んでいればブロック時刻を使う', async () => {
    rpcHold.blockTime = NOW + 5n;
    expect(await io().chainNowSec()).toBe(NOW + 5n);
  });

  it('Avalanche 以外 (Amoy・Kairos) はブロック時刻だけ (端末の時計が進んでいても、まだ送れる署名を止めない)', async () => {
    rpcHold.blockTime = NOW - 40n;
    expect(await io(80002).chainNowSec()).toBe(NOW - 40n);
    expect(await io(1001).chainNowSec()).toBe(NOW - 40n);
  });
});

describe('receiptHasSettlement (品物を渡す合図 = この支払いの Settled 6 項目)', () => {
  const EVENTS = parseAbi([
    'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
  ]);
  const NONCE = `0x${'33'.repeat(32)}` as Hex;
  const mark = { from: customer.address, nonce: NONCE, merchant: SHOP, amount: AMOUNT.toString() };
  function settled(over: { emitter?: Address; merchantValue?: bigint; feeValue?: bigint; feeReceiver?: Address } = {}): Log {
    return {
      address: over.emitter ?? FWD,
      topics: encodeEventTopics({ abi: EVENTS, eventName: 'Settled', args: { from: customer.address, nonce: NONCE, merchant: SHOP } }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
        [over.merchantValue ?? AMOUNT, over.feeReceiver ?? FEE, over.feeValue ?? 1n],
      ),
    } as Log;
  }

  it('信頼する forwarder の Settled が 6 項目一致なら true、どれか違えば false', () => {
    expect(receiptHasSettlement([settled()], FWD, mark, FEE)).toBe(true);
    expect(receiptHasSettlement([settled({ emitter: SHOP })], FWD, mark, FEE)).toBe(false);
    expect(receiptHasSettlement([settled({ merchantValue: AMOUNT - 1n })], FWD, mark, FEE)).toBe(false);
    expect(receiptHasSettlement([settled({ feeValue: 2n })], FWD, mark, FEE)).toBe(false);
    expect(receiptHasSettlement([settled({ feeReceiver: SHOP })], FWD, mark, FEE)).toBe(false);
    expect(receiptHasSettlement([], FWD, mark, FEE)).toBe(false);
  });
});
