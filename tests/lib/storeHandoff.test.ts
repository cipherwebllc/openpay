import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { mobileOrderFeeValue } from '@/lib/mobileOrderFee';
import {
  STORE_DEVICE_FEE_WEI,
  STORE_DEVICE_MIN_AMOUNT_WEI,
} from '@/lib/storeDevicePayment';
import {
  closeHandoff,
  createHandoffSession,
  handoffTokenFor,
  isGenuineHandoffId,
  newHandoffId,
  readHandoff,
  recordHandoffTx,
  submitHandoffAuth,
  type HandoffAuth,
  type HandoffClosedMark,
  type HandoffDeps,
  type HandoffSession,
  type HandoffStore,
} from '@/lib/storeHandoff';

const CHAIN = 80002;
const JPYC = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FWD = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const FEE = getAddress('0x428483FbA62eDCef1E3a100d3799F6d71759c560');
const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const NOW = 1_800_000_000;
const mac = (m: string) => createHmac('sha256', 'test-secret-'.repeat(4)).update(m).digest('hex');
const fixedBytes = (n: number) => Buffer.alloc(n, 7);
const ID = newHandoffId({ mac, randomBytes: fixedBytes })!;
const TOKEN = handoffTokenFor(ID, mac)!;
const AMOUNT = 1000n * 10n ** 18n;

function memoryStore(): HandoffStore & { failRead: boolean; data: Map<string, string> } {
  const data = new Map<string, string>();
  const s = {
    data,
    failRead: false,
    async putSession(id: string, session: HandoffSession) {
      if (data.has(`s:${id}`)) return false;
      data.set(`s:${id}`, JSON.stringify(session));
      return true;
    },
    async read(id: string) {
      if (s.failRead) return null;
      const session = data.get(`s:${id}`);
      const slot = data.get(`a:${id}`);
      const tx = data.get(`t:${id}`);
      const parsed = slot ? (JSON.parse(slot) as HandoffAuth & { closed?: true }) : null;
      return {
        session: session ? (JSON.parse(session) as HandoffSession) : null,
        auth: parsed && !parsed.closed ? parsed : null,
        txHash: (tx as Hex) ?? null,
        closed: !!parsed?.closed,
      };
    },
    async claimAuth(id: string, auth: HandoffAuth) {
      const existing = data.get(`a:${id}`);
      if (existing) {
        const v = JSON.parse(existing) as HandoffAuth & { closed?: true };
        return v.closed ? { existing: null, closed: true as const } : { existing: v };
      }
      data.set(`a:${id}`, JSON.stringify(auth));
      return { existing: null };
    },
    async closeSlot(id: string, mark: HandoffClosedMark) {
      const existing = data.get(`a:${id}`);
      if (existing) {
        const v = JSON.parse(existing) as HandoffAuth & { closed?: true };
        return v.closed ? { closed: true as const } : { closed: false as const, existing: v };
      }
      data.set(`a:${id}`, JSON.stringify(mark));
      return { closed: true as const };
    },
    async putTx(id: string, txHash: Hex) {
      const existing = data.get(`t:${id}`);
      if (existing) return existing as Hex;
      data.set(`t:${id}`, txHash);
      return txHash;
    },
  };
  return s;
}

let store: ReturnType<typeof memoryStore>;
let balance: bigint;
let used: boolean;

function deps(over: Partial<HandoffDeps> = {}): HandoffDeps {
  return {
    store,
    expectedChainId: CHAIN,
    nowSec: () => NOW,
    expectedFeeValue: 1n,
    maxValue: 50_000n * 10n ** 18n,
    maxValidityWindowSec: 180,
    jpycAddressFor: () => JPYC,
    forwarderFor: () => FWD,
    feeReceiverFor: () => FEE,
    getBalance: async () => balance,
    readAuthorizationUsed: async () => used,
    mac,
    randomBytes: fixedBytes,
    ...over,
  };
}

const customer = privateKeyToAccount(generatePrivateKey());

async function signedBody(over: Partial<ForwarderSettleParams> = {}, signer = customer) {
  const params: ForwarderSettleParams = {
    from: customer.address,
    merchant: SHOP,
    merchantValue: AMOUNT,
    feeReceiver: FEE,
    feeValue: STORE_DEVICE_FEE_WEI,
    validAfter: 0n,
    validBefore: BigInt(NOW + 150),
    intentSalt: `0x${'11'.repeat(32)}` as Hex,
    ...over,
  };
  const signature = await signer.signTypedData(buildReceiveWithAuthorizationTypedData(params, CHAIN, JPYC, FWD));
  return {
    from: params.from,
    merchant: params.merchant,
    merchantValue: params.merchantValue.toString(),
    feeValue: params.feeValue.toString(),
    validAfter: params.validAfter.toString(),
    validBefore: params.validBefore.toString(),
    intentSalt: params.intentSalt,
    signature,
  };
}

async function openSession() {
  const r = await createHandoffSession({ chainId: CHAIN, merchant: SHOP, amount: AMOUNT.toString() }, deps());
  if (!r.ok) throw new Error(`setup ${r.error}`);
  return r;
}

beforeEach(() => {
  store = memoryStore();
  balance = 10_000n * 10n ** 18n;
  used = false;
});

describe('受け渡しセッションを作る', () => {
  it('セッションを置き、トークンは保存しない (id から HMAC で導き直す)', async () => {
    const r = await openSession();
    expect(r).toEqual({ ok: true, id: ID, token: TOKEN, expiresAt: NOW + 600 });
    const saved = JSON.parse(store.data.get(`s:${ID}`)!);
    expect(saved).toMatchObject({ chainId: CHAIN, merchant: SHOP, amount: AMOUNT.toString() });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
  });

  it('id は HMAC 付き: 秘密値の違う・作り話の id は本物と見なさない', () => {
    expect(isGenuineHandoffId(ID, mac)).toBe(true);
    expect(isGenuineHandoffId('AAAAAAAAAAAAAAAAAAAAAA', mac)).toBe(false);
    const otherMac = (m: string) => createHmac('sha256', 'other-secret-'.repeat(3)).update(m).digest('hex');
    expect(isGenuineHandoffId(ID, otherMac)).toBe(false);
  });

  it('秘密値が無い環境では作らない (受け渡しを止める)', async () => {
    const r = await createHandoffSession({ chainId: CHAIN, merchant: SHOP, amount: AMOUNT.toString() }, deps({ mac: () => null }));
    expect(r).toMatchObject({ ok: false, status: 503, error: 'handoff_unavailable' });
  });

  it.each([
    [{ chainId: 137 }, 'unsupported_chain'],
    [{ merchant: '0x123' }, 'invalid_merchant'],
    [{ merchant: '0x0000000000000000000000000000000000000000' }, 'invalid_merchant'],
    [{ merchant: FEE }, 'merchant_is_fee_receiver'],
    [{ merchant: FWD }, 'merchant_is_forwarder'],
    [{ amount: (STORE_DEVICE_MIN_AMOUNT_WEI - 1n).toString() }, 'invalid_amount'],
    [{ amount: (50_000n * 10n ** 18n).toString() }, 'invalid_amount'], // 上限 − 1 wei を超える
    [{ amount: '12.5' }, 'invalid_amount'],
  ])('%o → %s', async (over, error) => {
    const r = await createHandoffSession({ chainId: CHAIN, merchant: SHOP, amount: AMOUNT.toString(), ...over }, deps());
    expect(r).toMatchObject({ ok: false, error });
  });

  it('forwarder が無い構成では作らない', async () => {
    const r = await createHandoffSession({ chainId: CHAIN, merchant: SHOP, amount: AMOUNT.toString() }, deps({ forwarderFor: () => null }));
    expect(r).toMatchObject({ ok: false, error: 'unsupported_chain' });
  });

  it('KV に置けなければ作れなかったと返す (偽の成功にしない)', async () => {
    const r = await createHandoffSession(
      { chainId: CHAIN, merchant: SHOP, amount: AMOUNT.toString() },
      deps({ store: { ...memoryStore(), putSession: async () => null } }),
    );
    expect(r).toMatchObject({ ok: false, status: 503, error: 'handoff_unavailable' });
  });
});

describe('お客様の署名を受け取る', () => {
  it('検証を通った最初の署名で枠を取り、同じ署名の再送は冪等', async () => {
    await openSession();
    const body = await signedBody();
    expect(await submitHandoffAuth(ID, body, deps())).toMatchObject({ ok: true, idempotent: false });
    expect(await submitHandoffAuth(ID, body, deps())).toMatchObject({ ok: true, idempotent: true });
  });

  it('預かった署名の再送は、端末が送った後 (使用済み)・残高が減った後・RPC 障害時でも冪等に受ける', async () => {
    await openSession();
    const body = await signedBody();
    await submitHandoffAuth(ID, body, deps());
    used = true;
    balance = 0n;
    const r = await submitHandoffAuth(
      ID,
      body,
      deps({ getBalance: async () => { throw new Error('rpc down'); } }),
    );
    expect(r).toMatchObject({ ok: true, idempotent: true });
  });

  it('署名の期限がセッションの期限を超えるものは受けない', async () => {
    await openSession();
    const late = deps({ nowSec: () => NOW + 500 });
    const r = await submitHandoffAuth(ID, await signedBody({ validBefore: BigInt(NOW + 650) }), late);
    expect(r).toMatchObject({ ok: false, error: 'validity_beyond_session' });
  });

  it('検証 (RPC) の間にセッションが切れたら預からない (孤立した署名を置いて成功を返さない)', async () => {
    await openSession();
    let t = NOW + 520;
    const r = await submitHandoffAuth(
      ID,
      await signedBody({ validBefore: BigInt(NOW + 599) }),
      deps({
        nowSec: () => t,
        getBalance: async () => {
          t = NOW + 600; // 残高照会の間にセッション切れ
          return balance;
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, status: 410, error: 'expired' });
    expect(store.data.has(`a:${ID}`)).toBe(false);
  });

  it('枠が埋まったあとの別の署名は受けない (二重払いの種を作らない)', async () => {
    await openSession();
    await submitHandoffAuth(ID, await signedBody(), deps());
    const other = await signedBody({ intentSalt: `0x${'22'.repeat(32)}` as Hex });
    expect(await submitHandoffAuth(ID, other, deps())).toMatchObject({ ok: false, status: 409, error: 'slot_taken' });
  });

  it.each([
    ['金額がセッションと違う', { merchantValue: AMOUNT + 1n }, 'amount_mismatch'],
    ['手数料欄が 1 wei でない', { feeValue: 2n }, 'fee_value_mismatch'],
    ['有効窓が 180 秒を超える', { validBefore: BigInt(NOW + 181) }, 'validity_too_far'],
    ['残り 60 秒未満 (端末が送れない署名で枠を占有させない)', { validBefore: BigInt(NOW + 59) }, 'validity_too_short'],
  ])('%s → %s', async (_, over, error) => {
    await openSession();
    expect(await submitHandoffAuth(ID, await signedBody(over), deps())).toMatchObject({ ok: false, error });
  });

  it('店がセッションと違う署名は受けない', async () => {
    await openSession();
    const body = { ...(await signedBody()), merchant: FEE };
    expect(await submitHandoffAuth(ID, body, deps())).toMatchObject({ ok: false, error: 'merchant_mismatch' });
  });

  it('別の鍵で署名された・壊れた署名は受けない', async () => {
    await openSession();
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await submitHandoffAuth(ID, await signedBody({}, other), deps())).toMatchObject({ ok: false, error: 'signature_mismatch' });
  });

  it('残高が請求額 + 1 wei に足りないと受けない (残高ちょうどのお客様)', async () => {
    await openSession();
    balance = AMOUNT; // 1 wei 足りない
    expect(await submitHandoffAuth(ID, await signedBody(), deps())).toMatchObject({ ok: false, error: 'insufficient_balance' });
  });

  it('使用済みの署名・無いセッション・期限切れのセッション・読めない KV', async () => {
    await openSession();
    used = true;
    expect(await submitHandoffAuth(ID, await signedBody(), deps())).toMatchObject({ ok: false, status: 409, error: 'authorization_used' });
    used = false;
    expect(await submitHandoffAuth('AAAAAAAAAAAAAAAAAAAAAA', await signedBody(), deps())).toMatchObject({ ok: false, status: 404 });
    expect(await submitHandoffAuth('bad id', await signedBody(), deps())).toMatchObject({ ok: false, status: 404 });
    expect(await submitHandoffAuth(ID, await signedBody(), deps({ nowSec: () => NOW + 601 }))).toMatchObject({ ok: false, status: 410 });
    store.failRead = true;
    expect(await submitHandoffAuth(ID, await signedBody(), deps())).toMatchObject({ ok: false, status: 503, error: 'handoff_unavailable' });
  });
});

describe('状態を読む・送った tx を記録する', () => {
  it('お客様には公開項目だけ、お店の端末にはトークンで署名まで', async () => {
    await openSession();
    expect(await readHandoff(ID, null, deps())).toEqual({ ok: true, state: 'open', expiresAt: NOW + 600, txHash: null });
    await submitHandoffAuth(ID, await signedBody(), deps());
    const pub = await readHandoff(ID, null, deps());
    expect(pub).toEqual({ ok: true, state: 'signed', expiresAt: NOW + 600, txHash: null });
    const device = await readHandoff(ID, TOKEN, deps());
    expect(device).toMatchObject({ ok: true, state: 'signed', merchant: SHOP, amount: AMOUNT.toString(), auth: { from: customer.address, feeValue: '1' } });
    expect(await readHandoff(ID, 'cd'.repeat(32), deps())).toMatchObject({ ok: false, status: 403, error: 'bad_token' });
    expect(await readHandoff(ID, 'not-a-token', deps())).toMatchObject({ ok: false, status: 403 });
  });

  it('偽の id・偽のトークンは KV を読まずに弾く', async () => {
    await openSession();
    let reads = 0;
    const counting = { ...store, read: async (id: string) => { reads += 1; return store.read(id); } };
    expect(await readHandoff('AAAAAAAAAAAAAAAAAAAAAA', null, deps({ store: counting }))).toMatchObject({ ok: false, status: 404 });
    expect(await readHandoff(ID, 'cd'.repeat(32), deps({ store: counting }))).toMatchObject({ ok: false, status: 403 });
    expect(await recordHandoffTx(ID, 'cd'.repeat(32), { txHash: `0x${'ef'.repeat(32)}` }, deps({ store: counting }))).toMatchObject({ ok: false, status: 403 });
    expect(reads).toBe(0);
  });

  it('tx の記録はトークンと署名が要る・記録後は sent', async () => {
    await openSession();
    const tx = `0x${'ef'.repeat(32)}`;
    expect(await recordHandoffTx(ID, TOKEN, { txHash: tx }, deps())).toMatchObject({ ok: false, status: 409 });
    await submitHandoffAuth(ID, await signedBody(), deps());
    expect(await recordHandoffTx(ID, null, { txHash: tx }, deps())).toMatchObject({ ok: false, status: 403 });
    expect(await recordHandoffTx(ID, TOKEN, { txHash: '0x12' }, deps())).toMatchObject({ ok: false, error: 'invalid_tx' });
    expect(await recordHandoffTx(ID, TOKEN, { txHash: tx }, deps())).toEqual({ ok: true, txHash: tx });
    expect(await readHandoff(ID, null, deps())).toMatchObject({ state: 'sent', txHash: tx });
  });

  it('別の hash が後から来ても上書きせず、記録済みの hash を返す (端末が別の送信に気づける)', async () => {
    await openSession();
    await submitHandoffAuth(ID, await signedBody(), deps());
    const first = `0x${'ef'.repeat(32)}`;
    const second = `0x${'cd'.repeat(32)}`;
    expect(await recordHandoffTx(ID, TOKEN, { txHash: first }, deps())).toEqual({ ok: true, txHash: first });
    expect(await recordHandoffTx(ID, TOKEN, { txHash: second }, deps())).toEqual({ ok: true, txHash: first });
  });
});

describe('締め切る (お店の端末が使わなくなったセッション)', () => {
  it('署名が無ければ締め切り、以後のお客様の署名は期限切れ (410) で受けない・状態は closed', async () => {
    await openSession();
    expect(await closeHandoff(ID, TOKEN, deps())).toEqual({ ok: true, closed: true });
    expect(await closeHandoff(ID, TOKEN, deps())).toEqual({ ok: true, closed: true }); // 冪等
    expect(await submitHandoffAuth(ID, await signedBody(), deps())).toMatchObject({ ok: false, status: 410, error: 'expired' });
    expect(await readHandoff(ID, null, deps())).toMatchObject({ state: 'closed', txHash: null });
    expect(await readHandoff(ID, TOKEN, deps())).toMatchObject({ state: 'closed', auth: null });
  });

  it('署名が先に入っていれば締め切らず、その署名を返す (端末が受け取って送る)', async () => {
    await openSession();
    await submitHandoffAuth(ID, await signedBody(), deps());
    const r = await closeHandoff(ID, TOKEN, deps());
    expect(r).toMatchObject({ ok: true, closed: false, txHash: null, auth: { from: customer.address, feeValue: '1' } });
    expect(await readHandoff(ID, null, deps())).toMatchObject({ state: 'signed' });
  });

  it('端末が送った後 (tx 記録済み) の締め切りは、署名と記録済みの hash を返す (端末は送り直さない)', async () => {
    await openSession();
    await submitHandoffAuth(ID, await signedBody(), deps());
    const tx = `0x${'ef'.repeat(32)}`;
    await recordHandoffTx(ID, TOKEN, { txHash: tx }, deps());
    expect(await closeHandoff(ID, TOKEN, deps())).toMatchObject({ ok: true, closed: false, txHash: tx, auth: { from: customer.address } });
    expect(await readHandoff(ID, null, deps())).toMatchObject({ state: 'sent', txHash: tx });
  });

  it('お客様の検証 (RPC) の間に締め切られたら預からない (枠は締め切りが先に取った)', async () => {
    await openSession();
    const body = await signedBody();
    const racing = {
      ...store,
      claimAuth: async (id: string, auth: HandoffAuth, ttl: number) => {
        await closeHandoff(ID, TOKEN, deps());
        return store.claimAuth(id, auth, ttl);
      },
    };
    expect(await submitHandoffAuth(ID, body, deps({ store: racing }))).toMatchObject({ ok: false, status: 410, error: 'expired' });
    expect(await readHandoff(ID, TOKEN, deps())).toMatchObject({ state: 'closed', auth: null });
  });

  it('締め切りと署名が同時なら、枠を先に取った方が勝つ (締め切りの直前に署名が入れば署名を返す)', async () => {
    await openSession();
    const body = await signedBody();
    const racing = {
      ...store,
      closeSlot: async (id: string, mark: HandoffClosedMark, ttl: number) => {
        await submitHandoffAuth(ID, body, deps());
        return store.closeSlot(id, mark, ttl);
      },
    };
    expect(await closeHandoff(ID, TOKEN, deps({ store: racing }))).toMatchObject({ ok: true, closed: false, auth: { from: customer.address } });
  });

  it('トークンが要る・偽の id は KV を読まない・無いセッションは 404・KV 障害は 503', async () => {
    await openSession();
    let reads = 0;
    const counting = { ...store, read: async (id: string) => { reads += 1; return store.read(id); } };
    expect(await closeHandoff(ID, null, deps({ store: counting }))).toMatchObject({ ok: false, status: 403 });
    expect(await closeHandoff('AAAAAAAAAAAAAAAAAAAAAA', TOKEN, deps({ store: counting }))).toMatchObject({ ok: false, status: 404 });
    expect(reads).toBe(0);
    const other = newHandoffId({ mac, randomBytes: (n) => Buffer.alloc(n, 9) })!;
    expect(await closeHandoff(other, handoffTokenFor(other, mac), deps())).toMatchObject({ ok: false, status: 404 });
    store.failRead = true;
    expect(await closeHandoff(ID, TOKEN, deps())).toMatchObject({ ok: false, status: 503 });
  });
});

describe('1 wei の署名は OpenPay の中継を通らない (最低 1 JPYC のとき)', () => {
  // /api/relay/jpyc は feeValue を server で再計算して照合する。最低額 1 JPYC 以上なら、どの gasMode /
  // feeKind の組み合わせでも期待手数料は 1 wei より大きく fee_value_mismatch で拒否される。
  for (const amount of [STORE_DEVICE_MIN_AMOUNT_WEI, AMOUNT]) {
    for (const gasMode of ['merchant', 'customer'] as const) {
      const bill = gasMode === 'merchant' ? amount + STORE_DEVICE_FEE_WEI : amount;
      it(`amount=${amount} gasMode=${gasMode}: 回収・店頭 1%・事前 3% の期待手数料がすべて 1 wei を超える`, () => {
        expect(recoverFeeValue(bill, gasMode, 137)).toBeGreaterThan(STORE_DEVICE_FEE_WEI);
        expect(mobileOrderFeeValue(bill, 'storefront')).toBeGreaterThan(STORE_DEVICE_FEE_WEI);
        expect(mobileOrderFeeValue(bill, 'preorder')).toBeGreaterThan(STORE_DEVICE_FEE_WEI);
      });
    }
  }
});
