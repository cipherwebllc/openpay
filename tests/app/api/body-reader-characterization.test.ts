// @vitest-environment node
// R6b: 手書きの JSON body reader 3 本と lib/httpBodyCap の readJsonBodyCapped の差を固定する。
// 置換の前提 (「観測できる挙動が同一」) を確かめるための characterization で、現行の挙動を
// そのまま期待値にしている (直すべき挙動かどうかは B-R6 で判断する)。
//
// 2026-10-30 (第 8 回 E-4): req.text() で全体を読んでから大きさを比べていた入口 8 本 (relay/jpyc・relay/jpyc/status・
// facilitator の settle/verify/verify-receipt/status・csv-pass/relay・push/subscribe) を lib/httpBodyCap の
// readTextBodyCapped に替えた。readTextBodyCapped は req.text() と同じ復号と同じ上限の測り方 (復号後の再エンコード長) を
// 保ったまま、生 byte が上限 + 6 (req.text() が外しうる BOM 2 つ分) を超えた chunk で読むのをやめる。下の CASES の
// text 列は置き換え前の req.text() の結果で、8 本の route がいまも同じ応答を返すこと (= 応答を変えずに読み口だけ
// 替えたこと) をここで確かめる。text 列がこの runtime の req.text() の結果と合っていることも別に確かめる。
//
// 対象:
//   - 上の 8 本の route (置き換え前は req.text() → 復号後の再エンコード長で cap → JSON.parse。relay/jpyc/status は
//     失敗をすべて invalid_payload にする)
//   - lib/agent/purchasesHttp の purchasesBody (逐次読みの cap・Buffer の寛容な復号・content-type 必須)
// 参照: readJsonBodyCapped (逐次読みの cap は生 byte・fatal な UTF-8 復号・content-type を見ない)。
//
// 判明した差 (readJsonBodyCapped に置換すると応答が変わる。readTextBodyCapped は 4 以外で req.text() と同じ):
//   1. BOM: req.text() は BOM を除いた文字列の長さで cap を測るので、生 byte が cap+3 でも通る。
//      readJsonBodyCapped は生 byte で測るので too_large。purchasesBody は BOM を残して JSON.parse が失敗する。
//   2. 不正な UTF-8: req.text() と Buffer は U+FFFD に置き換えて受理する。readJsonBodyCapped は invalid_json。
//   3. 不正な UTF-8 が cap 付近: 置換文字 (3 byte) で再エンコード長が伸び、生 byte が cap 以下でも 413。
//      readJsonBodyCapped は invalid_json (400)。purchasesBody は生 byte で測るので受理する。
//   4. 早期 cancel: req.text() は cap を超えても最後まで読む。readJsonBodyCapped は超過時点、readTextBodyCapped は
//      生 byte が cap + 6 を超えた時点で cancel する。応答が変わるのは「cap + 6 を超えて読んだあとで stream が切れる」
//      body だけ (置き換え前は req.text() が投げて 400、いまは切れる前に読むのをやめて 413)。これは受容した差。
//   5. content-type: purchasesBody だけが application/json を要求する (readJsonBodyCapped は見ない)。
//      push/subscribe と csv-pass/relay の reader 自体は見ないが、route は共通の CSRF 検査 (lib/net/crossOriginWrite) で
//      application/json 以外を reader より前に 415 で返す (cookie を使わない他の 6 本は検査なし)。
// 同一だった点: 上限ちょうど/+1 (素の ASCII)・空 body・body なし・読み取り中の stream エラー・
// chunk 境界で分かれた多 byte 文字。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
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
      enableJpycEip3009: true,
      enableX402Facilitator: true,
      enableCsvPass: true,
      feeReceiverConfigured: true,
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
vi.mock('@/lib/relay/relayProvider', () => ({
  PROVIDER: 'self-host',
  SUPPORTED_CHAINS: { 80002: {} },
  jpycAddressFor: () => '0x2222222222222222222222222222222222222222',
  readAuthorizationUsed: vi.fn(async () => false),
  findAuthorizationUsedTransactionHash: vi.fn(async () => null),
}));
// relay/jpyc の route が読み込む lib/tokens は読み込み時に forwarderConfig の他の関数も使うので、実物を残して一部だけ固定する。
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => null,
}));
vi.mock('@/lib/relay/forwarderSettleService', () => ({
  feeReceiverFor: () => '0x3333333333333333333333333333333333333333',
}));
// facilitator/status は reader を通った body を照合へ渡す。照合の失敗 (invalid_payload) は reader の失敗と同じ応答なので、
// reader を通ったことが応答で分かるよう照合を固定する。
vi.mock('@/lib/x402/facilitatorStatus', () => ({
  resolveFacilitatorPaymentStatus: vi.fn(async () => ({ ok: true, state: 'unused' })),
}));

import { POST as csvPassRelayPost } from '@/app/api/csv-pass/relay/route';
import { POST as facilitatorSettlePost } from '@/app/api/facilitator/settle/route';
import { POST as facilitatorStatusPost } from '@/app/api/facilitator/status/route';
import { POST as facilitatorVerifyPost } from '@/app/api/facilitator/verify/route';
import { POST as facilitatorVerifyReceiptPost } from '@/app/api/facilitator/verify-receipt/route';
import { POST as pushSubscribePost } from '@/app/api/push/subscribe/route';
import { POST as relayJpycPost } from '@/app/api/relay/jpyc/route';
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
// boms は先頭に重ねる BOM の数 (bom: true は 1 つ)。
function padded(
  base: Record<string, unknown>,
  size: number,
  opts: { bom?: boolean; boms?: number; bad?: number } = {},
): Uint8Array {
  const head = enc.encode(`${JSON.stringify(base).slice(0, -1)},"pad":"`);
  const tail = enc.encode('"}');
  const bom = new Array<number[]>(opts.boms ?? (opts.bom ? 1 : 0)).fill(BOM).flat();
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
const STATUS_BASE = {
  lookup: 'nonce',
  chainId: 80002,
  from: '0x1111111111111111111111111111111111111111',
  nonce: `0x${'1'.repeat(64)}`,
};
const PURCHASES_BASE = { address: '0x1111111111111111111111111111111111111111' };
// relay/jpyc・csv-pass/relay・facilitator の 4 本 (計 6 本) 用。JSON としては読めるが、reader の次の検査で決まった応答になる body。
const PROBE_BASE = { probe: 'body-reader' };

type RouteReader = {
  name: string;
  url: string;
  post: (req: Request) => Promise<Response>;
  cap: number;
  base: Record<string, unknown>;
  responses: Record<Outcome, { status: number; body: string }>;
  /** route が reader より前に application/json 以外を 415 で返すか (SIWE cookie の書き込み route の CSRF 検査)。 */
  requiresJsonContentType: boolean;
};

const asResult = async (res: Response) => ({ status: res.status, body: await res.text() });
const runSpec = async (reader: RouteReader, spec: BodySpec) =>
  asResult(await reader.post(requestFor(reader.url, spec)));

// 置き換え前の読み口 (req.text() → 復号後の再エンコード長で cap → JSON.parse) を、この runtime でそのまま動かした結果。
// BOM をいくつ外すかは runtime (undici) の実装しだいなので、BOM を重ねた入力の期待値はこれで出す。
async function textReaderOutcome(spec: BodySpec, cap: number): Promise<Outcome> {
  let text: string;
  try {
    text = await requestFor('http://localhost/oracle', spec).text();
  } catch {
    return 'invalid';
  }
  if (Buffer.byteLength(text, 'utf8') > cap) return 'too_large';
  try {
    JSON.parse(text);
    return 'accepted';
  } catch {
    return 'invalid';
  }
}

const routeReaders: RouteReader[] = [
  {
    name: 'push/subscribe POST',
    cap: MAX_BODY_BYTES,
    base: PUSH_BASE,
    url: 'http://localhost/api/push/subscribe',
    post: pushSubscribePost,
    responses: {
      accepted: { status: 200, body: '{"ok":true,"count":1}' },
      too_large: { status: 413, body: '{"ok":false,"error":"payload_too_large"}' },
      invalid: { status: 400, body: '{"ok":false,"error":"invalid_json"}' },
    },
    requiresJsonContentType: true,
  },
  {
    name: 'relay/jpyc/status POST',
    cap: MAX_BODY_BYTES,
    base: STATUS_BASE,
    url: 'http://localhost/api/relay/jpyc/status',
    post: relayStatusPost,
    responses: {
      accepted: { status: 200, body: '{"ok":true,"state":"unused"}' },
      // readBody は失敗理由を区別せず null → 400 invalid_payload。
      too_large: { status: 400, body: '{"ok":false,"error":"invalid_payload"}' },
      invalid: { status: 400, body: '{"ok":false,"error":"invalid_payload"}' },
    },
    requiresJsonContentType: false,
  },
  {
    name: 'relay/jpyc POST',
    cap: MAX_BODY_BYTES,
    base: PROBE_BASE,
    url: 'http://localhost/api/relay/jpyc',
    post: relayJpycPost,
    responses: {
      // reader の次の検査 (chainId が整数でない) で 400 invalid_payload。
      accepted: { status: 400, body: '{"ok":false,"error":"invalid_payload"}' },
      too_large: { status: 413, body: '{"ok":false,"error":"payload_too_large"}' },
      invalid: { status: 400, body: '{"ok":false,"error":"invalid_json"}' },
    },
    requiresJsonContentType: false,
  },
  {
    name: 'csv-pass/relay POST',
    cap: MAX_BODY_BYTES,
    base: PROBE_BASE,
    url: 'http://localhost/api/csv-pass/relay',
    post: csvPassRelayPost,
    responses: {
      accepted: { status: 400, body: '{"ok":false,"error":"invalid_payload"}' },
      too_large: { status: 413, body: '{"ok":false,"error":"payload_too_large"}' },
      invalid: { status: 400, body: '{"ok":false,"error":"invalid_json"}' },
    },
    requiresJsonContentType: true,
  },
  {
    name: 'facilitator/settle POST',
    cap: MAX_BODY_BYTES,
    base: PROBE_BASE,
    url: 'http://localhost/api/facilitator/settle',
    post: facilitatorSettlePost,
    responses: {
      // reader の次の検査 (parseFacilitatorRequest) で 400 invalid_body。
      accepted: { status: 400, body: '{"success":false,"errorReason":"invalid_body"}' },
      too_large: { status: 413, body: '{"success":false,"errorReason":"payload_too_large"}' },
      invalid: { status: 400, body: '{"success":false,"errorReason":"invalid_json"}' },
    },
    requiresJsonContentType: false,
  },
  {
    name: 'facilitator/verify POST',
    cap: MAX_BODY_BYTES,
    base: PROBE_BASE,
    url: 'http://localhost/api/facilitator/verify',
    post: facilitatorVerifyPost,
    responses: {
      // 構造不正は 200 で isValid:false。
      accepted: { status: 200, body: '{"isValid":false,"invalidReason":"invalid_body"}' },
      too_large: { status: 413, body: '{"isValid":false,"invalidReason":"payload_too_large"}' },
      invalid: { status: 400, body: '{"isValid":false,"invalidReason":"invalid_json"}' },
    },
    requiresJsonContentType: false,
  },
  {
    name: 'facilitator/verify-receipt POST',
    cap: MAX_BODY_BYTES,
    base: PROBE_BASE,
    url: 'http://localhost/api/facilitator/verify-receipt',
    post: facilitatorVerifyReceiptPost,
    responses: {
      // receipt が無い object は 200 で valid:false。
      accepted: { status: 200, body: '{"valid":false,"signer":null}' },
      too_large: { status: 413, body: '{"valid":false,"error":"payload_too_large"}' },
      invalid: { status: 400, body: '{"valid":false,"error":"invalid_json"}' },
    },
    requiresJsonContentType: false,
  },
  {
    name: 'facilitator/status POST',
    cap: MAX_BODY_BYTES,
    base: PROBE_BASE,
    url: 'http://localhost/api/facilitator/status',
    post: facilitatorStatusPost,
    responses: {
      // 照合は固定 (上の vi.mock) なので、reader を通れば 200 unused。
      accepted: { status: 200, body: '{"ok":true,"state":"unused"}' },
      too_large: { status: 413, body: '{"ok":false,"error":"payload_too_large"}' },
      invalid: { status: 400, body: '{"ok":false,"error":"invalid_payload"}' },
    },
    requiresJsonContentType: false,
  },
];

const UNSUPPORTED_MEDIA_TYPE = { status: 415, body: '{"ok":false,"error":"unsupported_media_type"}' };

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
    name: '生 byte で上限 +6 を読んだ後に stream エラー',
    spec: (base, cap) => ({ chunks: [padded(base, cap + 6)], streamError: true }),
    // readTextBodyCapped はまだ読み続ける量 (上限 + 6 以下) なので、req.text() と同じく stream エラーで invalid。
    text: 'invalid', purchases: 'null', capped: 'too_large',
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
  h.upsert.mockReset().mockResolvedValue({ ok: true, value: [{ endpoint: SUBSCRIPTION.endpoint }] });
});

// BOM を重ねた入力。req.text() が外す BOM の数は runtime の実装しだい (Node 26 の undici は 2 つ) なので、期待値は
// textReaderOutcome でこの runtime の req.text() から出す。readTextBodyCapped が生 byte で余分に読む 6 byte の境目を含む。
const STACKED_BOM_CASES: Array<{ name: string; spec: (base: Record<string, unknown>, cap: number) => BodySpec }> = [
  { name: 'BOM 2 つで生 byte が上限 +6', spec: (base, cap) => ({ chunks: [padded(base, cap + 6, { boms: 2 })] }) },
  { name: 'BOM 2 つで生 byte が上限 +7', spec: (base, cap) => ({ chunks: [padded(base, cap + 7, { boms: 2 })] }) },
  {
    name: 'BOM 2 つで生 byte が上限 +6 を 1 byte ずつの chunk で送る',
    spec: (base, cap) => ({ chunks: [...padded(base, cap + 6, { boms: 2 })].map((b) => Uint8Array.of(b)) }),
  },
  { name: 'BOM 3 つで生 byte が上限 +6', spec: (base, cap) => ({ chunks: [padded(base, cap + 6, { boms: 3 })] }) },
  { name: 'BOM 3 つの小さい JSON', spec: (base) => ({ chunks: [padded(base, 600, { boms: 3 })] }) },
  {
    name: 'BOM 2 つと不正な UTF-8 で生 byte が上限 +6',
    spec: (base, cap) => ({ chunks: [padded(base, cap + 6, { boms: 2, bad: 1 })] }),
  },
];

describe.each(routeReaders)('$name の body reader', (reader) => {
  it.each(CASES)('$name', async (c) => {
    const spec = c.spec(reader.base, reader.cap);
    const result = await runSpec(reader, spec);
    const jsonType = spec.contentType === undefined || spec.contentType === 'application/json';
    expect(result).toEqual(
      reader.requiresJsonContentType && !jsonType ? UNSUPPORTED_MEDIA_TYPE : reader.responses[c.text],
    );
  });

  it.each(STACKED_BOM_CASES)('$name は置き換え前 (req.text()) と同じ応答', async (c) => {
    const expected = await textReaderOutcome(c.spec(reader.base, reader.cap), reader.cap);
    expect(await runSpec(reader, c.spec(reader.base, reader.cap))).toEqual(reader.responses[expected]);
  });

  // 受容した差 (差 4): 上限 + 6 を超えて読んだ時点で読むのをやめるので、そのあとで stream が切れても too_large の応答になる。
  // 置き換え前は req.text() が投げて invalid の応答だった (relay/jpyc/status はどちらも 400 invalid_payload で同じ)。
  it('生 byte で上限 +7 を読んだ後に stream エラー → too_large の応答 (置き換え前は invalid の応答)', async () => {
    const spec = (): BodySpec => ({ chunks: [padded(reader.base, reader.cap + 7)], streamError: true });
    expect(await textReaderOutcome(spec(), reader.cap)).toBe('invalid');
    expect(await runSpec(reader, spec())).toEqual(reader.responses.too_large);
  });
});

describe('CASES の text 列', () => {
  it.each(CASES)('$name はこの runtime の req.text() の結果と一致する', async (c) => {
    expect(await textReaderOutcome(c.spec(PUSH_BASE, MAX_BODY_BYTES), MAX_BODY_BYTES)).toBe(c.text);
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

  it('置き換え前の読み口 (req.text()) は最後まで読み、cancel しない', async () => {
    const { state, req } = countingRequest('http://localhost/x');
    expect(Buffer.byteLength(await req.text(), 'utf8')).toBe(CHUNK * TOTAL_CHUNKS);
    expect(state.pulls).toBe(TOTAL_CHUNKS);
    expect(state.cancelled).toBe(0);
  });

  // 8 本の route は生 byte が上限 + 6 を超えた chunk で読むのをやめる (32 KiB を送っても 5 KiB しか読まない)。
  it.each(routeReaders.map((reader) => [reader.name, reader] as const))(
    '%s は上限 + 6 byte を超えた chunk で cancel する',
    async (_name, reader) => {
      const { state, req } = countingRequest(reader.url);
      expect(await asResult(await reader.post(req))).toEqual(reader.responses.too_large);
      expect(state.cancelled).toBe(1);
      expect(state.pulls).toBe(Math.floor((MAX_BODY_BYTES + 6) / CHUNK) + 1);
      expect(state.pulls).toBeLessThan(TOTAL_CHUNKS);
    },
  );

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
