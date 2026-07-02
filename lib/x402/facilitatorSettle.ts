// x402 facilitator の /verify・/settle 共通の「リクエスト解析 + ForwarderSettleParams 再構成 +
// 純検証 deps 組み立て」。OpenPay forwarder 分割モデル:
//   - 分割パラメタ (merchant/merchantValue/feeReceiver/feeValue) は paymentRequirements.extra.openpay
//     (= buyer が署名した値) から取る。
//   - buyer 選択フィールド (from/validAfter/validBefore/intentSalt) は paymentPayload.payload.authorization
//     から取る。
//   - feeReceiver/feeValue は **buyer 署名値をそのまま** params に入れ、server 権威 (= feeReceiverFor /
//     x402FeeValue(merchantValue)) との一致は verifyForwarderSettle が強制する。改竄 requirements
//     (別 feeReceiver/feeValue) は署名検証前に fee_receiver_mismatch / fee_value_mismatch で reject される
//     ため、buyer の authorization は broadcast されない (資金は安全)。
// 検証本体・settle 本体は lib/relay の共有コア (verifyForwarderSettle / settleViaForwarder) を再利用する。

import { isAddress, isHex, getAddress, type Hex } from 'viem';
import { x402FacilitatorConfig } from './facilitatorConfig';
import { x402FeeValue } from './fee';
import { chainIdFromCaip2 } from './network';
import { MAX_VALUE, jpycAddressFor, getBalance } from '@/lib/relay/relayProvider';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import {
  feeReceiverFor,
  MAX_VALIDITY_WINDOW_SEC,
} from '@/lib/relay/forwarderSettleService';
import type { ForwarderVerifyDeps } from '@/lib/relay/forwarderRecover';
import type { ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import { isDec } from '@/lib/relay/relayRoute';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const MAX_CHAIN_ID_DIGITS = 16; // Number.isSafeInteger の範囲を超える巨大 eip155 chainId を弾く。
const MAX_UINT256_DEC_DIGITS = 78; // 2^256-1 は 78 桁。BigInt parse の入力を uint256 相当に bound。
const CAIP2_EIP155 = /^eip155:(\d+)$/;

function isDecWithin(v: unknown, maxDigits: number): v is string {
  return isDec(v) && v.length <= maxDigits;
}

export type ParsedFacilitatorRequest = {
  chainId: number;
  params: ForwarderSettleParams;
  signature: Hex;
  expectedFeeValue: bigint;
};

export type ParseResult =
  | { ok: true; parsed: ParsedFacilitatorRequest }
  | { ok: false; reason: string };

// /verify・/settle 共通ボディ { x402Version, paymentPayload, paymentRequirements } を検証し
// ForwarderSettleParams に再構成する。reason は invalidReason / errorReason にそのまま使う。
export function parseFacilitatorRequest(raw: unknown): ParseResult {
  if (!isObj(raw)) return { ok: false, reason: 'invalid_body' };
  const payload = raw.paymentPayload;
  const reqs = raw.paymentRequirements;
  if (!isObj(payload) || !isObj(reqs)) return { ok: false, reason: 'invalid_body' };
  if (payload.scheme !== 'exact') return { ok: false, reason: 'unsupported_scheme' };

  const network = typeof payload.network === 'string' ? payload.network : '';
  const chainMatch = CAIP2_EIP155.exec(network);
  if (!chainMatch || chainMatch[1].length > MAX_CHAIN_ID_DIGITS) {
    return { ok: false, reason: 'invalid_network' };
  }
  const chainId = chainIdFromCaip2(network);
  if (chainId === null) return { ok: false, reason: 'invalid_network' };
  if (chainId !== x402FacilitatorConfig.chainId) {
    return { ok: false, reason: 'unsupported_network' };
  }
  if (reqs.network !== network) return { ok: false, reason: 'network_mismatch' };

  const inner = payload.payload;
  if (!isObj(inner)) return { ok: false, reason: 'invalid_payload' };
  if (typeof inner.signature !== 'string' || !isHex(inner.signature)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  const auth = inner.authorization;
  if (!isObj(auth)) return { ok: false, reason: 'invalid_authorization' };

  const extra = reqs.extra;
  const openpay = isObj(extra) ? extra.openpay : undefined;
  if (!isObj(openpay)) return { ok: false, reason: 'invalid_requirements' };

  // buyer 選択フィールド (paymentPayload.payload.authorization)。
  if (
    !isAddress(auth.from as string) ||
    !isDecWithin(auth.validAfter, MAX_UINT256_DEC_DIGITS) ||
    !isDecWithin(auth.validBefore, MAX_UINT256_DEC_DIGITS) ||
    typeof auth.intentSalt !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(auth.intentSalt)
  ) {
    return { ok: false, reason: 'invalid_authorization' };
  }
  // 分割フィールド (paymentRequirements.extra.openpay)。
  if (
    !isAddress(openpay.merchant as string) ||
    !isDecWithin(openpay.merchantValue, MAX_UINT256_DEC_DIGITS) ||
    !isAddress(openpay.feeReceiver as string) ||
    !isDecWithin(openpay.feeValue, MAX_UINT256_DEC_DIGITS)
  ) {
    return { ok: false, reason: 'invalid_requirements' };
  }

  const merchantValue = BigInt(openpay.merchantValue);
  const params: ForwarderSettleParams = {
    from: getAddress(auth.from as string),
    merchant: getAddress(openpay.merchant as string),
    merchantValue,
    feeReceiver: getAddress(openpay.feeReceiver as string),
    feeValue: BigInt(openpay.feeValue),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    intentSalt: auth.intentSalt as Hex,
  };
  return {
    ok: true,
    parsed: {
      chainId,
      params,
      signature: inner.signature as Hex,
      // server 権威の手数料 (verifyForwarderSettle が params.feeValue との一致を強制する)。
      expectedFeeValue: x402FeeValue(merchantValue),
    },
  };
}

// /verify 用の純検証 deps (broadcast/guard 系を含まない)。forwarderFor は raw (configuredJpycForwarderFor・
// a1 非依存: x402 facilitator は a1 利用料とは独立の別プロダクト)。
export function x402VerifyDeps(expectedFeeValue: bigint): ForwarderVerifyDeps {
  return {
    nowSec: () => Math.floor(Date.now() / 1000),
    expectedFeeValue,
    maxValue: MAX_VALUE,
    maxValidityWindowSec: MAX_VALIDITY_WINDOW_SEC,
    jpycAddressFor,
    forwarderFor: configuredJpycForwarderFor,
    feeReceiverFor,
    getBalance,
  };
}
