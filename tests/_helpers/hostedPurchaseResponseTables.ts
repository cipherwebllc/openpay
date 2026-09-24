// useHostedStorePurchase の応答 parser / phase 対応表の固定用テーブル (R15b)。
// 純粋 module の単体テストと、hook 経由のテスト (抽出前の旧コードでも走る) の両方が
// 同じ入力集合を使うことで、抽出前後で同じ事例を検査していることを保証する。
import type { Hex } from 'viem';

export const TABLE_RESOURCE_ID = 'h_fixture';
export const TABLE_INTENT_SALT = `0x${'ab'.repeat(32)}` as Hex;
export const TABLE_TX_HASH = `0x${'ef'.repeat(32)}` as Hex;
const UPPER_TX_HASH = `0x${'EF'.repeat(32)}` as Hex;

export type PurchaseStatusCase = {
  label: string;
  body: unknown;
  /** 正常時の戻り値。null なら 'purchase_status_invalid' を throw する。 */
  expected:
    | { ok: true; state: 'pending' }
    | { ok: true; state: 'failed' }
    | { ok: true; state: 'settled'; txHash: Hex }
    | null;
};

export const PURCHASE_STATUS_CASES: PurchaseStatusCase[] = [
  {
    label: 'pending',
    body: { ok: true, state: 'pending' },
    expected: { ok: true, state: 'pending' },
  },
  {
    label: 'pending (余分な field は落とす)',
    body: { ok: true, state: 'pending', txHash: TABLE_TX_HASH, extra: 1 },
    expected: { ok: true, state: 'pending' },
  },
  {
    label: 'failed',
    body: { ok: true, state: 'failed' },
    expected: { ok: true, state: 'failed' },
  },
  {
    label: 'settled',
    body: { ok: true, state: 'settled', txHash: TABLE_TX_HASH },
    expected: { ok: true, state: 'settled', txHash: TABLE_TX_HASH },
  },
  {
    label: 'settled (大文字 hex も受理・そのまま返す)',
    body: { ok: true, state: 'settled', txHash: UPPER_TX_HASH, extra: 'x' },
    expected: { ok: true, state: 'settled', txHash: UPPER_TX_HASH },
  },
  {
    label: 'settled で txHash 欠落',
    body: { ok: true, state: 'settled' },
    expected: null,
  },
  {
    label: 'settled で txHash が短い',
    body: { ok: true, state: 'settled', txHash: `0x${'ef'.repeat(31)}` },
    expected: null,
  },
  {
    label: 'settled で txHash が 0x なし',
    body: { ok: true, state: 'settled', txHash: 'ef'.repeat(32) },
    expected: null,
  },
  {
    label: 'settled で txHash が非 hex',
    body: { ok: true, state: 'settled', txHash: `0x${'zz'.repeat(32)}` },
    expected: null,
  },
  {
    label: 'ok:false',
    body: { ok: false, state: 'settled', txHash: TABLE_TX_HASH },
    expected: null,
  },
  {
    label: "ok:'true' (文字列)",
    body: { ok: 'true', state: 'pending' },
    expected: null,
  },
  {
    label: '未知の state',
    body: { ok: true, state: 'unexpected' },
    expected: null,
  },
  {
    label: 'state 欠落',
    body: { ok: true },
    expected: null,
  },
  { label: 'null', body: null, expected: null },
  { label: '配列', body: [{ ok: true, state: 'pending' }], expected: null },
  { label: '文字列', body: 'pending', expected: null },
];

type ContentReady = {
  ok: true;
  state: 'ready';
  resourceId: string;
  intentSalt: Hex;
  title: string;
  contentRevision: number;
  kind: 'url' | 'text';
  value: string;
};

type ContentEnded = {
  ok: true;
  state: 'provided-ended';
  resourceId: string;
  intentSalt: Hex;
  title: string;
  contentRevision: number;
};

export type ContentReadBackCase = {
  label: string;
  body: unknown;
  /** 正常時の戻り値。null なら 'store_content_invalid' を throw する。 */
  expected: ContentReady | ContentEnded | null;
};

function readyBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    state: 'ready',
    resourceId: TABLE_RESOURCE_ID,
    intentSalt: TABLE_INTENT_SALT,
    title: 'Fixture product',
    contentRevision: 3,
    kind: 'text',
    value: 'paid content',
    ...overrides,
  };
}

function withoutKey(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

export const CONTENT_READBACK_CASES: ContentReadBackCase[] = [
  {
    label: 'ready text',
    body: readyBody(),
    expected: {
      ok: true,
      state: 'ready',
      resourceId: TABLE_RESOURCE_ID,
      intentSalt: TABLE_INTENT_SALT,
      title: 'Fixture product',
      contentRevision: 3,
      kind: 'text',
      value: 'paid content',
    },
  },
  {
    label: 'ready url (余分な field は落とす)',
    body: readyBody({ kind: 'url', value: 'https://example.com/a', extra: 1 }),
    expected: {
      ok: true,
      state: 'ready',
      resourceId: TABLE_RESOURCE_ID,
      intentSalt: TABLE_INTENT_SALT,
      title: 'Fixture product',
      contentRevision: 3,
      kind: 'url',
      value: 'https://example.com/a',
    },
  },
  {
    label: 'intentSalt は大文字小文字を無視して照合し、引数側の値を返す',
    body: readyBody({ intentSalt: `0x${'AB'.repeat(32)}` }),
    expected: {
      ok: true,
      state: 'ready',
      resourceId: TABLE_RESOURCE_ID,
      intentSalt: TABLE_INTENT_SALT,
      title: 'Fixture product',
      contentRevision: 3,
      kind: 'text',
      value: 'paid content',
    },
  },
  {
    label: 'ready で value 空文字は受理',
    body: readyBody({ value: '' }),
    expected: {
      ok: true,
      state: 'ready',
      resourceId: TABLE_RESOURCE_ID,
      intentSalt: TABLE_INTENT_SALT,
      title: 'Fixture product',
      contentRevision: 3,
      kind: 'text',
      value: '',
    },
  },
  {
    label: 'provided-ended',
    body: withoutKey(
      withoutKey(readyBody({ state: 'provided-ended' }), 'kind'),
      'value',
    ),
    expected: {
      ok: true,
      state: 'provided-ended',
      resourceId: TABLE_RESOURCE_ID,
      intentSalt: TABLE_INTENT_SALT,
      title: 'Fixture product',
      contentRevision: 3,
    },
  },
  {
    label: 'provided-ended は kind/value があっても落とす',
    body: readyBody({ state: 'provided-ended', kind: 'html', value: 1 }),
    expected: {
      ok: true,
      state: 'provided-ended',
      resourceId: TABLE_RESOURCE_ID,
      intentSalt: TABLE_INTENT_SALT,
      title: 'Fixture product',
      contentRevision: 3,
    },
  },
  {
    label: '別商品の resourceId',
    body: readyBody({ resourceId: 'h_other' }),
    expected: null,
  },
  {
    label: '過去購入の intentSalt',
    body: readyBody({ intentSalt: `0x${'12'.repeat(32)}` }),
    expected: null,
  },
  {
    label: 'intentSalt 非文字列',
    body: readyBody({ intentSalt: 1 }),
    expected: null,
  },
  {
    label: 'title 欠落',
    body: withoutKey(readyBody(), 'title'),
    expected: null,
  },
  {
    label: 'contentRevision 0',
    body: readyBody({ contentRevision: 0 }),
    expected: null,
  },
  {
    label: 'contentRevision 負',
    body: readyBody({ contentRevision: -1 }),
    expected: null,
  },
  {
    label: 'contentRevision 小数',
    body: readyBody({ contentRevision: 1.5 }),
    expected: null,
  },
  {
    label: 'contentRevision 文字列',
    body: readyBody({ contentRevision: '1' }),
    expected: null,
  },
  {
    label: 'contentRevision が safe integer 超え',
    body: readyBody({ contentRevision: 2 ** 53 }),
    expected: null,
  },
  {
    label: 'ready で未知の kind',
    body: readyBody({ kind: 'html' }),
    expected: null,
  },
  {
    label: 'ready で value 非文字列',
    body: readyBody({ value: 1 }),
    expected: null,
  },
  {
    label: 'ready で value 欠落',
    body: withoutKey(readyBody(), 'value'),
    expected: null,
  },
  {
    label: '未知の state',
    body: readyBody({ state: 'pending' }),
    expected: null,
  },
  {
    label: 'ok:false',
    body: readyBody({ ok: false }),
    expected: null,
  },
  { label: 'null', body: null, expected: null },
  { label: '配列', body: [readyBody()], expected: null },
];

export const PHASE_STATUS_TABLE = [
  ['idle', 'not-started', 'none'],
  ['loading-quote', 'not-started', 'none'],
  ['review', 'not-started', 'none'],
  ['signing', 'not-started', 'none'],
  ['submitting', 'unknown', 'provisioning'],
  ['indeterminate', 'unknown', 'provisioning'],
  ['indeterminate-exhausted', 'unknown', 'needs-support'],
  ['provisioning', 'confirmed', 'provisioning'],
  ['ready', 'confirmed', 'ready'],
  ['needs-support', 'confirmed', 'needs-support'],
  ['failed-prebroadcast', 'not-executed', 'none'],
  ['error', 'not-executed', 'none'],
] as const;
