// /api/paid/usdc/jpyc/* の応答 JSON Schema (draft 2020-12)。
// Bazaar 宣言 (output.schema)・/openapi.json (responses.200 の schema)・テスト (ajv で example と
// 実応答を検証) が共用する**完全な契約**。
//
// 方針 (2026-08-23 裁定 P1):
//   - すべての object に additionalProperties:false。応答にキーを足すときは必ずここを先に更新する
//     (テストが example / 実応答の不適合で落ちる = 契約のドリフト検出)
//   - 金額・残高・ブロック番号は文字列 (JS の安全整数を超える)。pattern で数字列を強制
//   - status は enum。partial success は oneOf で「ok 行」と「unavailable 行」を分け、
//     unavailable 行は errorCode + retryable を必須にする (エージェントが再試行判断できる)
//   - 生のエラー文字列は載せない (viem のメッセージは RPC URL を含み得る)

const UINT_STRING = { type: 'string', pattern: '^[0-9]+$' } as const;
const DECIMAL_STRING = { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' } as const;
const ADDRESS = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' } as const;
const TX_HASH = { type: 'string', pattern: '^0x[a-fA-F0-9]{64}$' } as const;
const ISO_DATETIME = { type: 'string', format: 'date-time' } as const;
const CHAIN = { type: 'string', enum: ['polygon', 'kaia', 'avalanche', 'ethereum'] } as const;

export const JPYC_LIVE_ERROR_CODES = ['rpc_unavailable', 'contract_read_failed'] as const;
export type JpycLiveErrorCode = (typeof JPYC_LIVE_ERROR_CODES)[number];

const ENVELOPE_COMMON = {
  schemaVersion: { type: 'string', const: '2.2' },
  token: {
    type: 'object',
    properties: {
      symbol: { type: 'string', const: 'JPYC' },
      decimals: { type: 'integer', const: 18 },
    },
    required: ['symbol', 'decimals'],
    additionalProperties: false,
  },
  generatedAt: ISO_DATETIME,
  notice: {
    type: 'string',
    const: 'onchain-facts-only',
    description:
      'On-chain facts read from public RPC endpoints at request time. Informational only — not financial advice, not an offer, quote or solicitation. Full terms at termsUrl.',
  },
  termsUrl: { type: 'string', format: 'uri' },
} as const;
const ENVELOPE_REQUIRED = ['schemaVersion', 'token', 'generatedAt', 'notice', 'termsUrl'] as const;

const CHAIN_ROW_BASE = {
  chain: CHAIN,
  chainId: { type: 'integer', minimum: 1 },
  contract: ADDRESS,
} as const;

const UNAVAILABLE_ROW = {
  type: 'object',
  properties: {
    ...CHAIN_ROW_BASE,
    status: { type: 'string', const: 'unavailable' },
    errorCode: { type: 'string', enum: [...JPYC_LIVE_ERROR_CODES] },
    retryable: { type: 'boolean' },
  },
  required: ['chain', 'chainId', 'contract', 'status', 'errorCode', 'retryable'],
  additionalProperties: false,
} as const;

function okRow(extra: Record<string, unknown>, required: readonly string[]) {
  return {
    type: 'object',
    properties: { ...CHAIN_ROW_BASE, status: { type: 'string', const: 'ok' }, blockNumber: UINT_STRING, ...extra },
    required: ['chain', 'chainId', 'contract', 'status', 'blockNumber', ...required],
    additionalProperties: false,
  } as const;
}

export const JPYC_SUPPLY_RESPONSE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    ...ENVELOPE_COMMON,
    items: {
      type: 'array',
      items: {
        oneOf: [
          okRow(
            {
              totalSupply: { ...UINT_STRING, description: 'Atomic JPYC amount with 18 decimals.' },
              totalSupplyFormatted: DECIMAL_STRING,
            },
            ['totalSupply', 'totalSupplyFormatted'],
          ),
          UNAVAILABLE_ROW,
        ],
      },
    },
  },
  required: [...ENVELOPE_REQUIRED, 'items'],
  additionalProperties: false,
} as const;

export const JPYC_BALANCE_RESPONSE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    ...ENVELOPE_COMMON,
    address: ADDRESS,
    items: {
      type: 'array',
      items: {
        oneOf: [
          okRow(
            {
              balance: { ...UINT_STRING, description: 'Atomic JPYC amount with 18 decimals.' },
              balanceFormatted: DECIMAL_STRING,
            },
            ['balance', 'balanceFormatted'],
          ),
          UNAVAILABLE_ROW,
        ],
      },
    },
  },
  required: [...ENVELOPE_REQUIRED, 'address', 'items'],
  additionalProperties: false,
} as const;

export const JPYC_TRANSFERS_RESPONSE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    ...ENVELOPE_COMMON,
    ...CHAIN_ROW_BASE,
    fromBlock: UINT_STRING,
    toBlock: UINT_STRING,
    mode: {
      type: 'string',
      enum: ['snapshot', 'delta'],
      description:
        'snapshot = no cursor was supplied; items are newest first. delta = a cursor was supplied; items are the events after that position, oldest first.',
    },
    nextCursor: {
      type: 'string',
      pattern: '^[0-9]+:(?:-1|[0-9]+)$',
      description:
        'Pass as the cursor query parameter on the next call to receive only transfers newer than this response ("<block>:<logIndex>"). In snapshot mode this is where monitoring starts (after the newest returned event). Never moves backwards relative to the cursor you supplied.',
    },
    hasMore: {
      type: 'boolean',
      description:
        'delta: more events exist after the returned ones — call again with nextCursor to continue. snapshot: older events in the window were omitted and are NOT retrievable via nextCursor (it starts after the newest returned event).',
    },
    truncated: {
      type: 'boolean',
      description:
        'true when the supplied cursor is older than the scanned block window; events between the cursor and fromBlock were not scanned.',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          blockNumber: UINT_STRING,
          txHash: TX_HASH,
          logIndex: { type: 'integer', minimum: 0 },
          from: ADDRESS,
          to: ADDRESS,
          value: { ...UINT_STRING, description: 'Atomic JPYC amount with 18 decimals.' },
          valueFormatted: DECIMAL_STRING,
        },
        required: ['blockNumber', 'txHash', 'logIndex', 'from', 'to', 'value', 'valueFormatted'],
        additionalProperties: false,
      },
    },
  },
  required: [...ENVELOPE_REQUIRED, 'chain', 'chainId', 'contract', 'fromBlock', 'toBlock', 'mode', 'nextCursor', 'hasMore', 'truncated', 'items'],
  additionalProperties: false,
} as const;
