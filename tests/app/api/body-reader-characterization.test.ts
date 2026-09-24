// @vitest-environment node
// R6b: 手書きの JSON body reader 4 本と lib/httpBodyCap の readJsonBodyCapped の差を固定する。
// 置換の前提 (「観測できる挙動が同一」) を確かめるための characterization で、現行の挙動を
// そのまま期待値にしている (直すべき挙動かどうかは B-R6 で判断する)。
//
// 対象:
//   - push/subscribe の readJsonBody (req.text() → 復号後の再エンコード長で cap → JSON.parse)
//   - register/claim の inline reader (同じ手順)
//   - relay/jpyc/status の readBody (同じ手順・失敗はすべて invalid_payload)
//   - lib/agent/purchasesHttp の purchasesBody (逐次読みの cap・Buffer の寛容な復号・content-type 必須)
// 参照: readJsonBodyCapped (逐次読みの cap は生 byte・fatal な UTF-8 復号・content-type を見ない)。
//
// 判明した差 (いずれも置換すると応答が変わる):
//   1. BOM: req.text() は BOM を除いた文字列の長さで cap を測るので、生 byte が cap+3 でも通る。
//      readJsonBodyCapped は生 byte で測るので too_large。purchasesBody は BOM を残して JSON.parse が失敗する。
//   2. 不正な UTF-8: req.text() と Buffer は U+FFFD に置き換えて受理する。readJsonBodyCapped は invalid_json。
//   3. 不正な UTF-8 が cap 付近: 置換文字 (3 byte) で再エンコード長が伸び、生 byte が cap 以下でも 413。
//      readJsonBodyCapped は invalid_json (400)。purchasesBody は生 byte で測るので受理する。
//   4. 早期 cancel: req.text() は cap を超えても最後まで読む。readJsonBodyCapped は超過時点で cancel する。
//   5. content-type: purchasesBody だけが application/json を要求する (readJsonBodyCapped は見ない)。
// 同一だった点: 上限ちょうど/+1 (素の ASCII)・空 body・body なし・読み取り中の stream エラー・
// chunk 境界で分かれた多 byte 文字。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enablePushNotify: true,
      pushVapidPublicKey: 'test-public-key',
      enableRegisterFee: true,
      enableJpycEip3009: true,
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () => ({ ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' }),
  readSession: async () => ({ status: 'missing' }),
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkReadRateLimit: vi.fn(async () => true),
  checkIpRateLimit: vi.fn(async () => true),
  readIdempotency: vi.fn(async () => ({ state: 'missing' })),
}));
vi.mock('@/lib/push/store', () => ({
  listPushSubscriptions: vi.fn(),
  removePushSubscription: vi.fn(),
  upsertPushSubscription: h.upsert,
}));
vi.mock('@/lib/registerFeeClaim', () => ({
  claimRegisterFeePayment: h.claim,
}));
vi.mock('@/lib/relay/relayProvider', () => ({
  PROVIDER: 'self-host',
  SUPPORTED_CHAINS: { 80002: {} },
  jpycAddressFor: () => '0x2222222222222222222222222222222222222222',
  readAuthorizationUsed: vi.fn(async () => false),
  findAuthorizationUsedTransactionHash: vi.fn(async () => null),
}));
vi.mock('@/lib/relay/forwarderConfig', () => ({
  jpycForwarderFor: () => null,
}));
vi.mock('@/lib/relay/forwarderSettleService', () => ({
  feeReceiverFor: () => '0x3333333333333333333333333333333333333333',
}));

import { POST as pushSubscribePost } from '@/app/api/push/subscribe/route';
import { POST as registerClaimPost } from '@/app/api/register/claim/route';
import { POST as relayStatusPost } from '@/app/api/relay/jpyc/status/route';
import { purchasesBody } from '@/lib/agent/purchasesHttp';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { MAX_BODY_BYTES } from '@/lib/relay/relayRoute';

const enc = new TextEncoder();
const BOM = [0xef, 0xbb, 0xbf];
const PURCHASES_CAP = 2048;

type Outcome = 'accepted' | 'too_large' | 'invalid';

type BodySpec = {
  chunks: Uint8Array[];
  contentType?: string | null;
  streamError?: boolean;
  noBody?: boolean;
};

// base の JSON に "pad" 欄を足して、生 byte 長をちょうど size にする。bad 個の 0xFF (不正な
// UTF-8) を pad 文字列の中に置く (JSON としては文字列内なので、寛容な復号なら U+FFFD になる)。
function padded(base: Record<string, unknown>, size: number, opts: { bom?: boolean; bad?: number } = {}): Uint8Array {
  const head = enc.encode(`${JSON.stringify(base).slice(0, -1)},"pad":"`);
  const tail = enc.encode('"}');
  const bom = opts.bom ? BOM : [];
  const bad = opts.bad ?? 0;
  const fill = size - bom.length - head.length - tail.length - bad;
  if (fill < 0) throw new Error('size too small for base');
  const bytes = Uint8Array.from([
    ...bom,
    ...head,
    ...new Array<number>(bad).fill(0xff),
    ...enc.encode('x'.repeat(fill)),
    ...tail,
  ]);
  expect(bytes.byteLength).toBe(size);
  return bytes;
}

// 有効な JSON の途中で多 byte 文字 (あ = E3 81 82) を chunk 境界で割る。
function splitMultibyte(base: Record<string, unknown>): Uint8Array[] {
  const bytes = enc.encode(JSON.stringify({ ...base, pad: 'あ' }));
  const at = bytes.indexOf(0xe3) + 1;
  return [bytes.slice(0, at), bytes.slice(at)];
}

function streamOf(chunks: Uint8Array[], streamError = false): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (streamError) {
        controller.enqueue(chunks[0]);
        return;
      }
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    pull(controller) {
      // 1 chunk 目を渡した後で接続断を模す。
      if (streamError) controller.error(new TypeError('terminated'));
    },
  });
}

function requestFor(url: string, spec: BodySpec): Request {
  const headers = new Headers();
  const contentType = spec.contentType === undefined ? 'application/json' : spec.contentType;
  if (contentType !== null) headers.set('content-type', contentType);
  headers.set('x-forwarded-for', '203.0.113.55');
  if (spec.noBody) return new Request(url, { method: 'POST', headers });
  return new Request(url, {
    method: 'POST',
    headers,
    body: streamOf(spec.chunks, spec.streamError),
    duplex: 'half',
  } as RequestInit);
}

function sourceFor(spec: BodySpec): { body: ReadableStream<Uint8Array> | null } {
  if (spec.noBody) return { body: null };
  return { body: streamOf(spec.chunks, spec.streamError) };
}

const SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/sub/1',
  keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
};
const PUSH_BASE = { subscription: SUBSCRIPTION, locale: 'ja' };
const REGISTER_BASE = {
  chainId: 137,
  tokenAddress: `0x${'a'.repeat(40)}`,
  merchant: `0x${'b'.repeat(40)}`,
  saleAmount: '100',
  merchantTxHash: `0x${'1'.repeat(64)}`,
  feeTxHash: `0x${'2'.repeat(64)}`,
};
const STATUS_BASE = {
  lookup: 'nonce',
  chainId: 80002,
  from: '0x1111111111111111111111111111111111111111',
  nonce: `0x${'1'.repeat(64)}`,
};
const PURCHASES_BASE = { address: '0x1111111111111111111111111111111111111111' };

type RouteReader = {
  name: string;
  cap: number;
  base: Record<string, unknown>;
  run: (spec: BodySpec) => Promise<{ status: number; body: string }>;
  responses: Record<Outcome, { status: number; body: string }>;
};

const asResult = async (res: Response) => ({ status: res.status, body: await res.text() });

const routeReaders: RouteReader[] = [
  {
    name: 'push/subscribe POST',
    cap: MAX_BODY_BYTES,
    base: PUSH_BASE,
    run: async (spec) => asResult(await pushSubscribePost(requestFor('http://localhost/api/push/subscribe', spec))),
    responses: {
      accepted: { status: 200, body: '{"ok":true,"count":1}' },
      too_large: { status: 413, body: '{"ok":false,"error":"payload_too_large"}' },
      invalid: { status: 400, body: '{"ok":false,"error":"invalid_json"}' },
    },
  },
  {
    name: 'register/claim POST',
    cap: MAX_BODY_BYTES,
    base: REGISTER_BASE,
    run: async (spec) => asResult(await registerClaimPost(requestFor('http://localhost/api/register/claim', spec))),
    responses: {
      accepted: { status: 200, body: '{"ok":true,"status":"claimed"}' },
      too_large: { status: 413, body: '{"ok":false,"error":"payload_too_large"}' },
      invalid: { status: 400, body: '{"ok":false,"error":"invalid_json"}' },
    },
  },
  {
    name: 'relay/jpyc/status POST',
    cap: MAX_BODY_BYTES,
    base: STATUS_BASE,
    run: async (spec) => asResult(await relayStatusPost(requestFor('http://localhost/api/relay/jpyc/status', spec))),
    responses: {
      accepted: { status: 200, body: '{"ok":true,"state":"unused"}' },
      // readBody は失敗理由を区別せず null → 400 invalid_payload。
      too_large: { status: 400, body: '{"ok":false,"error":"invalid_payload"}' },
      invalid: { status: 400, body: '{"ok":false,"error":"invalid_payload"}' },
    },
  },
];

type CaseDef = {
  name: string;
  spec: (base: Record<string, unknown>, cap: number) => BodySpec;
  // 手書き reader (req.text() 系) の結果
  text: Outcome;
  // purchasesBody の結果
  purchases: 'accepted' | 'null';
  // readJsonBodyCapped の結果
  capped: Outcome;
};

const CASES: CaseDef[] = [
  {
    name: 'ASCII の生 byte が上限ちょうど',
    spec: (base, cap) => ({ chunks: [padded(base, cap)] }),
    text: 'accepted', purchases: 'accepted', capped: 'accepted',
  },
  {
    name: 'ASCII の生 byte が上限 +1',
    spec: (base, cap) => ({ chunks: [padded(base, cap + 1)] }),
    text: 'too_large', purchases: 'null', capped: 'too_large',
  },
  {
    name: '上限 +1 を 1 byte ずつの chunk で送る',
    spec: (base, cap) => ({ chunks: [...padded(base, cap + 1)].map((b) => Uint8Array.of(b)) }),
    text: 'too_large', purchases: 'null', capped: 'too_large',
  },
  {
    name: '多 byte 文字を chunk 境界で割った有効な JSON',
    spec: (base) => ({ chunks: splitMultibyte(base) }),
    text: 'accepted', purchases: 'accepted', capped: 'accepted',
  },
  {
    name: '小さい BOM 付き JSON',
    spec: (base) => ({ chunks: [Uint8Array.from([...BOM, ...enc.encode(JSON.stringify(base))])] }),
    // purchasesBody は Buffer#toString が BOM を残し JSON.parse が失敗する。
    text: 'accepted', purchases: 'null', capped: 'accepted',
  },
  {
    name: 'BOM 付きで生 byte が上限 +3 (BOM を除くと上限ちょうど)',
    spec: (base, cap) => ({ chunks: [padded(base, cap + 3, { bom: true })] }),
    // 差 1: req.text() は BOM を除いた長さで測る。
    text: 'accepted', purchases: 'null', capped: 'too_large',
  },
  {
    name: '文字列内に不正な UTF-8 (0xFF) がある小さい JSON',
    spec: (base) => ({ chunks: [padded(base, 600, { bad: 1 })] }),
    // 差 2: 寛容な復号は U+FFFD で受理、fatal な復号は invalid_json。
    text: 'accepted', purchases: 'accepted', capped: 'invalid',
  },
  {
    name: '不正な UTF-8 を 10 byte 含み生 byte が上限ちょうど',
    spec: (base, cap) => ({ chunks: [padded(base, cap, { bad: 10 })] }),
    // 差 3: U+FFFD (3 byte) で再エンコード長が cap + 20 になり 413。purchasesBody は生 byte で測る。
    text: 'too_large', purchases: 'accepted', capped: 'invalid',
  },
  {
    name: 'overlong / surrogate の UTF-8 (ED A0 80)',
    spec: (base) => {
      const bytes = enc.encode(JSON.stringify({ ...base, pad: 'zzz' }));
      const at = bytes.indexOf(0x7a);
      bytes.set([0xed, 0xa0, 0x80], at);
      return { chunks: [bytes] };
    },
    text: 'accepted', purchases: 'accepted', capped: 'invalid',
  },
  {
    name: '空の stream (0 byte)',
    spec: () => ({ chunks: [] }),
    text: 'invalid', purchases: 'null', capped: 'invalid',
  },
  {
    name: 'body なし',
    spec: () => ({ chunks: [], noBody: true }),
    text: 'invalid', purchases: 'null', capped: 'invalid',
  },
  {
    name: '1 chunk 目の後に stream エラー',
    spec: (base) => ({ chunks: [enc.encode(JSON.stringify(base).slice(0, 10))], streamError: true }),
    text: 'invalid', purchases: 'null', capped: 'invalid',
  },
  {
    name: 'content-type が text/plain の有効な JSON',
    spec: (base) => ({ chunks: [enc.encode(JSON.stringify(base))], contentType: 'text/plain' }),
    // 差 5: purchasesBody だけが content-type を要求する。
    text: 'accepted', purchases: 'null', capped: 'accepted',
  },
  {
    name: 'content-type なしの有効な JSON',
    spec: (base) => ({ chunks: [enc.encode(JSON.stringify(base))], contentType: null }),
    text: 'accepted', purchases: 'null', capped: 'accepted',
  },
];

beforeEach(() => {
  h.claim.mockReset().mockResolvedValue('claimed');
  h.upsert.mockReset().mockResolvedValue({ ok: true, value: [{ endpoint: SUBSCRIPTION.endpoint }] });
});

describe.each(routeReaders)('$name の body reader', (reader) => {
  it.each(CASES)('$name', async (c) => {
    const result = await reader.run(c.spec(reader.base, reader.cap));
    expect(result).toEqual(reader.responses[c.text]);
  });
});

describe('purchasesBody (agent proof verify/unbind)', () => {
  it.each(CASES)('$name', async (c) => {
    const spec = c.spec(PURCHASES_BASE, PURCHASES_CAP);
    const value = await purchasesBody(requestFor('http://localhost/api/agent/proof/verify', spec));
    if (c.purchases === 'null') {
      expect(value).toBeNull();
    } else {
      expect(value).toMatchObject(PURCHASES_BASE);
    }
  });

  it('JSON が object 以外 (null・配列・数値) なら null', async () => {
    for (const text of ['null', '[]', '[{"a":1}]', '1', '"s"']) {
      expect(await purchasesBody(requestFor('http://localhost/x', { chunks: [enc.encode(text)] }))).toBeNull();
    }
  });

  it('content-type は ; 以降を無視し大文字小文字を区別しない', async () => {
    const value = await purchasesBody(requestFor('http://localhost/x', {
      chunks: [enc.encode('{"a":1}')],
      contentType: ' Application/JSON ; charset=utf-8',
    }));
    expect(value).toEqual({ a: 1 });
  });
});

describe('readJsonBodyCapped (参照)', () => {
  const expectCapped = (result: Awaited<ReturnType<typeof readJsonBodyCapped>>, outcome: Outcome) => {
    if (outcome === 'accepted') expect(result.ok).toBe(true);
    else expect(result).toEqual({ ok: false, reason: outcome === 'too_large' ? 'too_large' : 'invalid_json' });
  };

  it.each(CASES)('cap 4096: $name', async (c) => {
    expectCapped(await readJsonBodyCapped(sourceFor(c.spec(PUSH_BASE, MAX_BODY_BYTES)), MAX_BODY_BYTES), c.capped);
  });

  it.each(CASES)('cap 2048: $name', async (c) => {
    expectCapped(await readJsonBodyCapped(sourceFor(c.spec(PURCHASES_BASE, PURCHASES_CAP)), PURCHASES_CAP), c.capped);
  });

  it('Request 経由でも同じ (body なしは invalid_json)', async () => {
    expectCapped(await readJsonBodyCapped(requestFor('http://localhost/x', { chunks: [], noBody: true }), 10), 'invalid');
  });
});

// 差 4: 上限超過後も読み続けるか。応答は同じでも、接続側の消費量が違う。
describe('上限超過時の読み取り量', () => {
  const CHUNK = 1024;
  const TOTAL_CHUNKS = 32;

  function countingStream() {
    const state = { pulls: 0, cancelled: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulls += 1;
        controller.enqueue(enc.encode('x'.repeat(CHUNK)));
        if (state.pulls === TOTAL_CHUNKS) controller.close();
      },
      cancel() {
        state.cancelled += 1;
      },
    }, { highWaterMark: 0 });
    return { state, body };
  }

  function countingRequest(url: string) {
    const { state, body } = countingStream();
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.55' },
      body,
      duplex: 'half',
    } as RequestInit);
    return { state, req };
  }

  it.each([
    ['push/subscribe POST', (req: Request) => pushSubscribePost(req), 413],
    ['register/claim POST', (req: Request) => registerClaimPost(req), 413],
    ['relay/jpyc/status POST', (req: Request) => relayStatusPost(req), 400],
  ] as const)('%s は req.text() で最後まで読み、cancel しない', async (_name, run, status) => {
    const { state, req } = countingRequest('http://localhost/x');
    expect((await run(req)).status).toBe(status);
    expect(state.pulls).toBe(TOTAL_CHUNKS);
    expect(state.cancelled).toBe(0);
  });

  it('purchasesBody は上限超過の chunk で cancel する', async () => {
    const { state, req } = countingRequest('http://localhost/x');
    expect(await purchasesBody(req)).toBeNull();
    expect(state.cancelled).toBe(1);
    expect(state.pulls).toBeLessThan(TOTAL_CHUNKS);
    expect(state.pulls).toBe(Math.floor(PURCHASES_CAP / CHUNK) + 1);
  });

  it('readJsonBodyCapped は上限超過の chunk で cancel する', async () => {
    const { state, req } = countingRequest('http://localhost/x');
    expect(await readJsonBodyCapped(req, MAX_BODY_BYTES)).toEqual({ ok: false, reason: 'too_large' });
    expect(state.cancelled).toBe(1);
    expect(state.pulls).toBe(Math.floor(MAX_BODY_BYTES / CHUNK) + 1);
  });
});
