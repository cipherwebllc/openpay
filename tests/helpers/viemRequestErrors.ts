// 本物の viem の error (node_modules/viem の class を new する) を、署名済みの eth_sendUserOperation の本文つきで作る。
// log の出口が伏せる対象 (key つきの URL・Request body・129 桁以上の 16 進) と、残す対象 (64 桁の hash・アドレス) を
// 1 か所にまとめる。値はすべてテスト用の作り物。
import { HttpRequestError, RpcRequestError, TimeoutError } from 'viem';
import { UserOperationExecutionError } from 'viem/account-abstraction';

export const API_KEY = 'KEY123';
export const BUNDLER_ORIGIN = 'https://api.example';
export const BUNDLER_URL = `${BUNDLER_ORIGIN}/v2/1/rpc?apikey=${API_KEY}`;
// 署名 65 byte = 130 桁。
export const SIGNATURE = `0x${'5a'.repeat(64)}1b`;
export const CALL_DATA = `0x${'c0de'.repeat(120)}`;
export const PAYMASTER_DATA = `0x${'9d'.repeat(118)}`;
// 129 桁に満たない欄 (120 桁)。16 進の規則では拾えず、Request body の行ごと伏せる規則だけが消す。
export const SHORT_FACTORY_DATA = `0x${'f00d'.repeat(30)}`;

// 残すもの。
export const USER_OP_HASH = `0x${'7e'.repeat(32)}`;
export const SENDER = '0x1111111111111111111111111111111111111111';
export const RPC_DETAILS = 'AA25 invalid account nonce';

// どの出口にも残ってはいけない断片。長い 16 進は途中で切れて残る場合も拾えるよう、16 桁の断片で見る。
export const SECRET_MARKERS = [
  API_KEY,
  '/v2/1/rpc',
  '5a5a5a5a5a5a5a5a',
  'c0dec0dec0dec0de',
  '9d9d9d9d9d9d9d9d',
  'f00df00df00df00d',
  'eth_sendUserOperation',
] as const;

const userOperation = {
  sender: SENDER,
  nonce: '0x1',
  factory: '0x2222222222222222222222222222222222222222',
  factoryData: SHORT_FACTORY_DATA,
  callData: CALL_DATA,
  callGasLimit: '0x5208',
  verificationGasLimit: '0x186a0',
  preVerificationGas: '0xc350',
  maxFeePerGas: '0x3b9aca00',
  maxPriorityFeePerGas: '0x3b9aca00',
  paymaster: '0x3333333333333333333333333333333333333333',
  paymasterData: PAYMASTER_DATA,
  signature: SIGNATURE,
};

export const USER_OP_BODY = {
  jsonrpc: '2.0',
  id: 7,
  method: 'eth_sendUserOperation',
  params: [userOperation, '0x0000000071727De22E5E9d8BAf0edAc6f37da032'],
};

export function rpcRequestError(): RpcRequestError {
  return new RpcRequestError({
    body: USER_OP_BODY,
    url: BUNDLER_URL,
    error: { code: -32500, message: RPC_DETAILS },
  });
}

export function httpRequestError(): HttpRequestError {
  return new HttpRequestError({
    body: USER_OP_BODY,
    url: BUNDLER_URL,
    status: 502,
    details: RPC_DETAILS,
  });
}

export function timeoutError(): TimeoutError {
  return new TimeoutError({ body: USER_OP_BODY, url: BUNDLER_URL });
}

// bundler の action が投げる形。message は cause の URL・Request body の行に加えて、`Request Arguments:` に
// callData・paymasterData・signature を 1 行ずつ並べる (Request body の行の外に長い 16 進が出る)。
export function userOperationExecutionError(): UserOperationExecutionError {
  return new UserOperationExecutionError(rpcRequestError(), {
    sender: SENDER,
    nonce: 1n,
    callData: CALL_DATA,
    paymaster: userOperation.paymaster,
    paymasterData: PAYMASTER_DATA,
    signature: SIGNATURE,
  } as never);
}

export const VIEM_ERROR_CASES = [
  ['RpcRequestError', rpcRequestError],
  ['HttpRequestError', httpRequestError],
  ['TimeoutError', timeoutError],
  ['UserOperationExecutionError', userOperationExecutionError],
] as const;

/** 値の中の文字列を全部集める (Error の message・stack・cause と、列挙されない欄も見る)。 */
export function collectStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.getOwnPropertyNames(value).flatMap((key) => [
    key,
    ...collectStrings((value as Record<string, unknown>)[key], seen),
  ]);
}

export function leakedMarkers(value: unknown): string[] {
  const text = collectStrings(value).join('\n');
  return SECRET_MARKERS.filter((marker) => text.includes(marker));
}
