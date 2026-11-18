#!/usr/bin/env node
// OpenPay の JPYC forwarder-split 402 を 1 回購入するリファレンス買い手。
//
// 使い方 (Node.js 22+・鍵はファイルにもコマンド行にも書かない・入力で受けて env で渡す):
//   npm install openpay-x402-sdk viem
//   read -s BUYER_PRIVATE_KEY && export BUYER_PRIVATE_KEY   # 専用の少額ウォレットの鍵だけ
//   [RESOURCE_URL=https://open-pay.jp/api/paid/x] [MAX_JPYC=5] node scripts/x402-buyer-example.mjs
//
// 金銭ガード (署名の前に必ず通す。402 の自己申告を鵜呑みにしない):
//   - 総額 (merchantValue + feeValue) が MAX_JPYC (既定 5 JPYC) を超えたら署名しない
//   - asset / forwarder が SDK の既知値 (SUPPORTED_JPYC_ASSETS / SUPPORTED_JPYC_FORWARDERS) と
//     一致しなければ署名しない (別 token の署名・攻撃者 EOA への総額付け替えを止める)
//   - validBefore は min(402 の maxTimeoutSeconds, facilitator 上限) で頭打ちにする
//   - RESOURCE_URL は SDK の parseSafePaymentUrl を通してから fetch する (SSRF ガード)。
//     さらに https だけにする (平文 HTTP の 402 は経路の途中で書き換えられる・SDK の executor と同じ)
//   - 402 の取得も支払いの再送も転送 (3xx) を追わない。最初の URL と別の origin の応答には署名しない
//   - 支払条件に resource があれば、その origin が最初の URL の origin と同じでなければ署名しない

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  bytesToHex,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  SUPPORTED_JPYC_ASSETS,
  SUPPORTED_JPYC_FORWARDERS,
  MAX_AUTHORIZATION_TIMEOUT_SECONDS,
  parseSafePaymentUrl,
} from 'openpay-x402-sdk';

const DEFAULT_RESOURCE_URL = 'https://open-pay.jp/api/paid/demo';
export const DEFAULT_MAX_JPYC = '5';
const JPYC_DECIMALS = 18;

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function requireDec(value, label) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be a decimal string`);
  }
  return value;
}

function requireAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${label} must be an EVM address`);
  }
  return getAddress(value);
}

function requireBytes32(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value;
}

export function chainIdFromNetwork(network) {
  if (typeof network !== 'string') throw new Error('network must be a string');
  const match = /^eip155:([0-9]+)$/.exec(network);
  if (!match) throw new Error(`unsupported network: ${network}`);
  return Number(match[1]);
}

export function normalizePaymentRequirements(raw) {
  if (!isObject(raw)) throw new Error('accepts[0] must be an object');
  if (raw.scheme !== 'exact') throw new Error(`unsupported scheme: ${raw.scheme}`);
  const chainId = chainIdFromNetwork(raw.network);
  const asset = requireAddress(raw.asset, 'asset');
  const payTo = requireAddress(raw.payTo, 'payTo');
  const maxAmountRequired = BigInt(requireDec(raw.maxAmountRequired, 'maxAmountRequired'));
  const extra = raw.extra;
  if (!isObject(extra)) throw new Error('extra is required');
  if (extra.assetTransferMethod !== 'eip3009') {
    throw new Error(`unsupported assetTransferMethod: ${extra.assetTransferMethod}`);
  }
  if (typeof extra.name !== 'string' || extra.name.length === 0) {
    throw new Error('extra.name is required');
  }
  if (typeof extra.version !== 'string' || extra.version.length === 0) {
    throw new Error('extra.version is required');
  }
  const openpay = extra.openpay;
  if (!isObject(openpay) || openpay.mode !== 'forwarder-split') {
    throw new Error('extra.openpay.forwarder-split is required');
  }
  const forwarder = requireAddress(openpay.forwarder, 'extra.openpay.forwarder');
  if (payTo !== forwarder) throw new Error('payTo must match extra.openpay.forwarder');
  const merchant = requireAddress(openpay.merchant, 'extra.openpay.merchant');
  const merchantValue = BigInt(
    requireDec(openpay.merchantValue, 'extra.openpay.merchantValue'),
  );
  const feeReceiver = requireAddress(openpay.feeReceiver, 'extra.openpay.feeReceiver');
  const feeValue = BigInt(requireDec(openpay.feeValue, 'extra.openpay.feeValue'));
  const commitVersion = requireBytes32(
    openpay.commitVersion,
    'extra.openpay.commitVersion',
  );
  const total = merchantValue + feeValue;
  if (maxAmountRequired !== total) {
    throw new Error('maxAmountRequired must equal merchantValue + feeValue');
  }
  return {
    scheme: raw.scheme,
    network: raw.network,
    chainId,
    asset,
    maxTimeoutSeconds: requirePositiveInteger(
      raw.maxTimeoutSeconds,
      'maxTimeoutSeconds',
    ),
    extra: {
      name: extra.name,
      version: extra.version,
      openpay: {
        forwarder,
        merchant,
        merchantValue,
        feeReceiver,
        feeValue,
        commitVersion,
      },
    },
  };
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function buildForwarderNonce(params, chainId, forwarder, commitVersion) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        commitVersion,
        params.from,
        params.merchant,
        params.merchantValue,
        params.feeReceiver,
        params.feeValue,
        params.validAfter,
        params.validBefore,
        params.intentSalt,
        BigInt(chainId),
        forwarder,
      ],
    ),
  );
}

export function buildTypedDataFromPaymentRequirements(rawAccept, authorization) {
  const accept = normalizePaymentRequirements(rawAccept);
  const params = {
    from: requireAddress(authorization.from, 'authorization.from'),
    merchant: accept.extra.openpay.merchant,
    merchantValue: accept.extra.openpay.merchantValue,
    feeReceiver: accept.extra.openpay.feeReceiver,
    feeValue: accept.extra.openpay.feeValue,
    validAfter: BigInt(requireDec(authorization.validAfter, 'authorization.validAfter')),
    validBefore: BigInt(requireDec(authorization.validBefore, 'authorization.validBefore')),
    intentSalt: requireBytes32(authorization.intentSalt, 'authorization.intentSalt'),
  };
  const forwarder = accept.extra.openpay.forwarder;
  const value = params.merchantValue + params.feeValue;
  return {
    accept,
    params,
    typedData: {
      domain: {
        name: accept.extra.name,
        version: accept.extra.version,
        chainId: accept.chainId,
        verifyingContract: accept.asset,
      },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: 'ReceiveWithAuthorization',
      message: {
        from: params.from,
        to: forwarder,
        value,
        validAfter: params.validAfter,
        validBefore: params.validBefore,
        nonce: buildForwarderNonce(
          params,
          accept.chainId,
          forwarder,
          accept.extra.openpay.commitVersion,
        ),
      },
    },
  };
}

export function createAuthorization(
  from,
  maxTimeoutSeconds,
  nowSec = Math.floor(Date.now() / 1000),
) {
  return {
    from: getAddress(from),
    validAfter: '0',
    validBefore: String(nowSec + maxTimeoutSeconds),
    intentSalt: bytesToHex(randomBytes(32)),
  };
}

// MAX_JPYC (人間可読の JPYC) を atomic 単位へ。402 の要求額から導出しないのが要点で、
// 改竄された requirements をここで止めるための独立した上限。
export function parseJpycCap(raw, label = 'MAX_JPYC') {
  const value = typeof raw === 'number' ? String(raw) : raw;
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]{1,18})?$/.test(value)) {
    throw new Error(`${label} must be a JPYC decimal with up to 18 decimals (例: 5)`);
  }
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(JPYC_DECIMALS) + BigInt(frac.padEnd(JPYC_DECIMALS, '0'));
}

export function assertWithinCap(totalAtomic, capAtomic, capLabel) {
  if (totalAtomic > capAtomic) {
    throw new Error(
      `要求額 ${formatUnits(totalAtomic, JPYC_DECIMALS)} JPYC が上限 MAX_JPYC=${capLabel} を超過 — 署名せず中止します`,
    );
  }
}

// 402 が自己申告した asset / forwarder をそのまま信じると、売り手は別 token の署名を
// 引き出したり、表示した分配を迂回して総額を攻撃者 EOA へ付け替えられる。SDK の
// 既知値 (単一情報源) へ束縛してその波及を断つ。
export function assertSupportedAssetAndForwarder(accept) {
  const known = SUPPORTED_JPYC_ASSETS[accept.network];
  if (!known) {
    throw new Error(`未対応 network ${accept.network} — 署名せず中止します`);
  }
  if (accept.asset.toLowerCase() !== known.address.toLowerCase()) {
    throw new Error(
      `asset ${accept.asset} が ${accept.network} の既知 JPYC (${known.address}) と一致しません — 署名せず中止します`,
    );
  }
  const forwarder = SUPPORTED_JPYC_FORWARDERS[accept.network];
  if (!forwarder) {
    throw new Error(
      `${accept.network} の OpenPay forwarder が未掲載です — 署名せず中止します`,
    );
  }
  // normalizePaymentRequirements が payTo === extra.openpay.forwarder を保証済なので、
  // forwarder の一致確認が payTo の確認を兼ねる。
  if (accept.extra.openpay.forwarder.toLowerCase() !== forwarder.toLowerCase()) {
    throw new Error(
      `forwarder/payTo ${accept.extra.openpay.forwarder} が既知の OpenPay forwarder (${forwarder}) と一致しません — 署名せず中止します`,
    );
  }
  return accept;
}

// 売り手が長い有効期限を要求しても、facilitator の上限を超える authorization には
// 署名しない (後日 facilitator を迂回して直接 settle される波及を断つ)。
export function clampAuthorizationTimeout(maxTimeoutSeconds) {
  return Math.min(maxTimeoutSeconds, MAX_AUTHORIZATION_TIMEOUT_SECONDS);
}

// 平文 HTTP の 402 は経路の途中で書き換えられ、改竄された支払条件に署名させられる。署名する購入先は
// https の公開ホストだけにする (SDK の executor と同じ扱い・localhost の http も通さない)。
export function parsePurchaseUrl(raw) {
  // SSRF ガード: 内部/リンクローカル/認証情報付き URL へは 1 バイトも送らない。
  const safeUrl = parseSafePaymentUrl(raw);
  if (!safeUrl || safeUrl.protocol !== 'https:') {
    throw new Error(
      `RESOURCE_URL ${raw} は支払い先として不正です (https の公開ホストのみ・認証情報付き不可) — 中止します`,
    );
  }
  return safeUrl;
}

// 転送 (3xx) を追うと、別の origin が返した支払条件に署名したり、署名した支払い (X-PAYMENT) を
// 別の origin へ運んだりする。fetch は redirect: 'manual' で呼び、応答が最初の URL の origin の
// ものであることをここで確かめる。
export function assertSameOriginResponse(response, origin, label) {
  if (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new Error(
      `${label}の応答が転送 (HTTP ${response.status}) でした — 転送先は追わずに中止します`,
    );
  }
  if (response.url && new URL(response.url).origin !== origin) {
    throw new Error(`${label}の応答が ${origin} 以外から届きました — 中止します`);
  }
}

// 支払条件の resource が別の origin を指していたら、別の売り手の支払条件を中継されている疑いがある。
// resource がある場合は、その origin が最初の URL の origin と同じことを署名の前に確かめる。
export function assertResourceOrigin(rawAccept, origin) {
  if (!isObject(rawAccept) || rawAccept.resource === undefined) return;
  const resourceOrigin =
    typeof rawAccept.resource === 'string' && URL.canParse(rawAccept.resource)
      ? new URL(rawAccept.resource).origin
      : null;
  if (resourceOrigin !== origin) {
    throw new Error(
      `支払条件の resource ${String(rawAccept.resource)} が購入先 ${origin} と別の origin です — 署名せず中止します`,
    );
  }
}

export function encodePaymentPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodePaymentResponse(raw) {
  if (!raw) return null;
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

function paymentPayloadFor(accept, authorization, signature) {
  return {
    x402Version: 1,
    scheme: accept.scheme,
    network: accept.network,
    payload: {
      signature,
      authorization,
    },
  };
}

async function readJson(res) {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function main() {
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!privateKey || !isHex(privateKey) || privateKey.length !== 66) {
    throw new Error('BUYER_PRIVATE_KEY=0x... is required');
  }
  const safeUrl = parsePurchaseUrl(process.env.RESOURCE_URL || DEFAULT_RESOURCE_URL);
  const resourceUrl = safeUrl.toString();
  const origin = safeUrl.origin;
  const maxJpyc = process.env.MAX_JPYC ?? DEFAULT_MAX_JPYC;
  const capAtomic = parseJpycCap(maxJpyc);
  const account = privateKeyToAccount(privateKey);

  console.log(`[1/3] Requesting ${resourceUrl}`);
  const first = await fetch(resourceUrl, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  });
  assertSameOriginResponse(first, origin, '402 の取得');
  const challenge = await readJson(first);
  if (first.status !== 402 || !isObject(challenge) || !Array.isArray(challenge.accepts)) {
    throw new Error(`expected HTTP 402 challenge, got ${first.status}`);
  }
  assertResourceOrigin(challenge.accepts[0], origin);
  const accept = assertSupportedAssetAndForwarder(
    normalizePaymentRequirements(challenge.accepts[0]),
  );
  assertWithinCap(
    accept.extra.openpay.merchantValue + accept.extra.openpay.feeValue,
    capAtomic,
    maxJpyc,
  );
  const authorization = createAuthorization(
    account.address,
    clampAuthorizationTimeout(accept.maxTimeoutSeconds),
  );
  const { typedData } = buildTypedDataFromPaymentRequirements(
    challenge.accepts[0],
    authorization,
  );
  console.log(
    `[1/3] 402 received: price ${formatUnits(
      accept.extra.openpay.merchantValue,
      18,
    )} JPYC + fee ${formatUnits(accept.extra.openpay.feeValue, 18)} JPYC (上限 MAX_JPYC=${maxJpyc})`,
  );

  console.log('[2/3] Signing receiveWithAuthorization');
  const signature = await account.signTypedData(typedData);
  const paymentPayload = paymentPayloadFor(accept, authorization, signature);

  console.log('[3/3] Retrying with X-PAYMENT');
  // 署名した支払いは最初の URL へだけ送る (転送を追うと X-PAYMENT が転送先へも運ばれる)。
  const unlocked = await fetch(resourceUrl, {
    headers: {
      accept: 'application/json',
      'X-PAYMENT': encodePaymentPayload(paymentPayload),
    },
    redirect: 'manual',
  });
  const body = await readJson(unlocked);
  const paymentResponse = decodePaymentResponse(unlocked.headers.get('x-payment-response'));
  console.log(`HTTP ${unlocked.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (paymentResponse) {
    console.log('X-PAYMENT-RESPONSE');
    console.log(JSON.stringify(paymentResponse, null, 2));
  }
  // 受領 (X-PAYMENT-RESPONSE) を表示してから、転送を追わなかったことを失敗として伝える。
  assertSameOriginResponse(unlocked, origin, '支払いの再送');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
