// 失敗した決済の error の文を、端末の履歴 (localStorage) に入れる前と、読み出した後に伏せる。
// 材料は本物の viem の error (tests/helpers/viemRequestErrors.ts)。伏せる関数 (redactLogText) そのものの規則は
// tests/lib/logRedaction.test.ts が見る。ここは「履歴の出入口がその関数を通っているか」と「id を変えていないか」を見る。
import { beforeEach, describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
import {
  appendHistory,
  buildHistoryEntry,
  HISTORY_ERROR_MESSAGE_MAX_LENGTH,
  HISTORY_STORAGE_KEY,
  loadHistory,
  type BuildHistoryBase,
  type HistoryEntry,
} from '@/lib/history';
import { toCsv } from '@/lib/historyCsv';
import {
  aa14UserOperationRejection,
  BUNDLER_ORIGIN,
  BUNDLER_URL,
  leakedMarkers,
  RPC_DETAILS,
  rpcRequestError,
  SENDER,
  USER_OP_BODY,
  USER_OP_HASH,
  VIEM_ERROR_CASES,
} from '../helpers/viemRequestErrors';

const TS = 1_700_000_000_000;
const SECONDS = TS / 1000;

function failed(
  errorMessage: string,
  overrides: Partial<BuildHistoryBase & { ts: number }> = {},
): HistoryEntry {
  return buildHistoryEntry({
    flow: 'batch',
    status: 'error',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: 1000n,
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: 10n,
    txHash: null,
    userOpHash: null,
    blockNumber: null,
    errorMessage,
    storeName: 'Test Store',
    ts: TS,
    ...overrides,
  });
}

/** 伏せる前の版が保存した形: id の種は元の文の先頭 32 字・errorMessage は元の文の先頭 500 字そのまま。 */
function storedByOldBuild(message: string): HistoryEntry {
  return {
    ...failed(message),
    id: `batch-err-${SECONDS}-${message.slice(0, 32)}`,
    errorMessage: message.slice(0, HISTORY_ERROR_MESSAGE_MAX_LENGTH),
  };
}

// 伏せる所の無い文。1 字も変わらない。
const PLAIN_MESSAGES = [
  'gas underpriced',
  'User rejected the request.',
  'ウォレットで署名が取り消されました',
  `bundler rejected (code -32500): ${RPC_DETAILS}`,
  // 64 桁の hash と 40 桁のアドレスは残す。
  `UserOperation ${USER_OP_HASH} from ${SENDER} reverted`,
  // 128 桁までの 16 進は伏せない (伏せるのは 129 桁から)。
  `calldata 0x${'ab'.repeat(64)} rejected`,
  'The contract function "transfer" reverted with the following reason:\nERC20: transfer amount exceeds balance\n\nContract Call:\n  address:   0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29\n  function:  transfer(address to, uint256 amount)',
];

describe('buildHistoryEntry: error の文を伏せてから保存する', () => {
  it.each(VIEM_ERROR_CASES)('%s: key つきの URL と Request body の中身を保存しない', (_name, make) => {
    const { message } = make();
    // 材料の確認: 元の文は、切る前も、先頭 500 字だけでも、伏せる対象を持つ。
    expect(leakedMarkers(message.slice(0, HISTORY_ERROR_MESSAGE_MAX_LENGTH))).not.toEqual([]);

    const entry = failed(message);

    expect(leakedMarkers(entry)).toEqual([]);
    expect(entry.errorMessage).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
    expect(entry.errorMessage).toContain('Request body: [redacted]');
    expect(entry.errorMessage!.length).toBeLessThanOrEqual(HISTORY_ERROR_MESSAGE_MAX_LENGTH);
    // 切る前に伏せるので、Request body の行より後ろの Details の行 (失敗の理由) が 500 字の中に残る。
    expect(entry.errorMessage).toContain('\n\nDetails: ');
  });

  it('bundler の理由 (Details) は、伏せた後の 500 字の中に残る', () => {
    expect(failed(rpcRequestError().message).errorMessage).toContain(`Details: ${RPC_DETAILS}`);
  });

  it('`Request body:` を持たない形 (AA14): 500 字の切れ目にかかる callData を、切る前に伏せる', () => {
    const { message } = aa14UserOperationRejection();
    // 材料の確認: 元の文の先頭 500 字は、callData の途中で切れている (129 桁に満たず、切った後では伏せられない)。
    expect(message.slice(0, HISTORY_ERROR_MESSAGE_MAX_LENGTH)).toMatch(/callData: +0x(?:c0de)+c?0?d?$/);

    const entry = failed(message);

    expect(entry.errorMessage).toContain('callData:              [redacted]');
    expect(entry.errorMessage).not.toContain('c0dec0dec0dec0de');
    expect(entry.errorMessage).not.toContain('9d9d9d9d9d9d9d9d');
    expect(entry.errorMessage).not.toContain('5a5a5a5a5a5a5a5a');
    expect(entry.errorMessage).toHaveLength(HISTORY_ERROR_MESSAGE_MAX_LENGTH);
  });

  it.each(PLAIN_MESSAGES)('伏せる所の無い文は 1 字も変わらない: %s', (message) => {
    expect(failed(message).errorMessage).toBe(message);
  });

  it('500 字を超える、伏せる所の無い文は、今までどおり先頭 500 字', () => {
    const message = 'paymaster rejected: '.repeat(60);
    expect(failed(message).errorMessage).toBe(message.slice(0, HISTORY_ERROR_MESSAGE_MAX_LENGTH));
  });
});

describe('buildHistoryEntry: id の種は元の文の先頭 32 字のまま', () => {
  // 本物の viem の error で、先頭 32 字に入るものを確かめる。`URL:` の行が最も早く始まるのは、status の行を持たない
  // HttpRequestError (fetch そのものの失敗) の 27 字目と、RpcRequestError の 26 字目で、32 字までに入るのは scheme だけ。
  const fetchFailure = () => new HttpRequestError({ body: USER_OP_BODY, url: BUNDLER_URL });
  const plainHttpUrl = () => rpcRequestError('http://rpc.example/v2/KEY123');
  const ID_CASES = [
    ...VIEM_ERROR_CASES,
    ['aa14UserOperationRejection', aa14UserOperationRejection],
    ['HttpRequestError (status なし)', fetchFailure],
    ['RpcRequestError (http の URL)', plainHttpUrl],
  ] as const;

  it.each(ID_CASES)('%s: id は元の文で作った id と同じで、URL の host も key も本文も入らない', (_name, make) => {
    const { message } = make();
    const entry = failed(message);

    expect(entry.id).toBe(`batch-err-${SECONDS}-${message.slice(0, 32)}`);
    expect(leakedMarkers(entry.id)).toEqual([]);
    expect(entry.id).not.toContain('example');
    expect(entry.id).not.toContain('//');
    expect(entry.id).not.toContain('Request body');
  });

  it('先頭 32 字に伏せる対象がある文でも、id は元の文から作る (保存済みの履歴と同じ id のまま)', () => {
    // 作り物の文 (本物の viem の error は、上のとおり先頭 32 字に URL の host を持たない)。id の種を伏せた後の文に
    // 変えると、伏せる前の版が保存した同じ失敗と id が合わなくなり、二重に登録される。
    const message = 'URL: https://rpc.example/v2/path is down';
    const entry = failed(message);

    expect(entry.id).toBe(`batch-err-${SECONDS}-URL: https://rpc.example/v2/path`);
    expect(entry.errorMessage).toBe('URL: https://rpc.example is down');

    window.localStorage.clear();
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([storedByOldBuild(message)]));
    appendHistory(entry);
    expect(loadHistory()).toHaveLength(1);
  });
});

describe('loadHistory: 保存済みの古い履歴の error の文を、読み込みで伏せる', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each(VIEM_ERROR_CASES)('%s: 読み出した entry と CSV に、key つきの URL と Request body の中身が無い', (_name, make) => {
    const old = storedByOldBuild(make().message);
    expect(leakedMarkers(old.errorMessage)).not.toEqual([]);
    const stored = JSON.stringify([old]);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, stored);

    const loaded = loadHistory();

    expect(loaded).toHaveLength(1);
    expect(leakedMarkers(loaded)).toEqual([]);
    expect(loaded[0].errorMessage).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
    expect(loaded[0].errorMessage).toContain('Request body: [redacted]');
    // 伏せるのは errorMessage だけ。ほかの欄 (id も) は保存されたまま。
    expect({ ...loaded[0], errorMessage: old.errorMessage }).toEqual(old);

    const csv = toCsv(loaded);
    expect(leakedMarkers(csv)).toEqual([]);
    expect(csv).toContain(`URL: ${BUNDLER_ORIGIN}\n`);

    // 読むだけでは書き戻さない。
    expect(window.localStorage.getItem(HISTORY_STORAGE_KEY)).toBe(stored);
  });

  it('古い schema (v1) の entry も、同じ読み込みを通って伏せられる', () => {
    const latest = storedByOldBuild(rpcRequestError().message);
    const v1: Record<string, unknown> = { ...latest, schemaVersion: 1 };
    for (const key of [
      'provider', 'circlePaymasterAddress', 'circlePaymasterNetUsdc', 'circleVerification',
      'saleAmount', 'networkFeeEquivalent', 'feeBreakdownVersion',
      'anchorAmount', 'anchorSymbol', 'fxRateUsdcJpy',
      'productName', 'memo', 'taxRate', 'taxCategory', 'receiptNo', 'lineItems',
    ]) {
      delete v1[key];
    }
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([v1]));

    const loaded = loadHistory();

    expect(loaded).toHaveLength(1);
    expect(leakedMarkers(loaded)).toEqual([]);
    expect(loaded[0].errorMessage).toContain(`URL: ${BUNDLER_ORIGIN}\n`);
  });

  it('次に履歴を保存するとき、古い entry は伏せた形で保存し直される', () => {
    window.localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify([storedByOldBuild(rpcRequestError().message)]),
    );

    appendHistory(failed('gas underpriced', { ts: TS + 5_000 }));

    const stored = window.localStorage.getItem(HISTORY_STORAGE_KEY)!;
    expect(JSON.parse(stored)).toHaveLength(2);
    expect(leakedMarkers(stored)).toEqual([]);
    expect(stored).toContain(BUNDLER_ORIGIN);
  });

  it.each(PLAIN_MESSAGES)('伏せる所の無い文は、読み出しても 1 字も変わらない: %s', (message) => {
    const old = storedByOldBuild(message);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([old]));

    expect(loadHistory()).toEqual([old]);
  });

  it('errorMessage が null の entry はそのまま', () => {
    const success = failed('unused', { status: 'success', errorMessage: null, txHash: '0xTx' });
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([success]));

    expect(loadHistory()).toEqual([success]);
  });
});
