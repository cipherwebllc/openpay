import 'server-only';

// x402 facilitator の署名済み payment を read-only で解決する共有 helper。
// settle/冪等 claim/broadcast は一切行わず、relay status と同じ
// settled / unused / indeterminate 語彙で response-unknown を分類する。
//
// `x402fac:idem:` の txHash は broadcast 直後にも記録されるため、それ単独は支払い成立の
// 根拠にしない。authorizationState と receipt 内の nonce-bound Settled event を on-chain
// で照合し、pending/reverted tx や別決済の receipt・署名の token 直送が有料リソース/注文の
// 解錠へ波及するのを断つ。

import {
  createPublicClient,
  getAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { logger } from '@/lib/logger';
import {
  findAuthorizationUsedTransactionHash,
  jpycAddressFor,
  readAuthorizationUsed,
} from '@/lib/relay/relayProvider';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { recoverReceiveWithAuthorizationSigner } from '@/lib/relay/forwarderSettle';
import { feeReceiverFor } from '@/lib/relay/forwarderSettleService';
import { readIdempotency } from '@/lib/relay/relayGuards';
import { parseFacilitatorRequest } from '@/lib/x402/facilitatorSettle';

export type FacilitatorPaymentStatus =
  | {
      ok: true;
      chainId: number;
      payer: Address;
      state: 'settled';
      txHash: Hex | null;
    }
  | {
      ok: true;
      chainId: number;
      payer: Address;
      state: 'unused' | 'indeterminate';
    }
  | {
      ok: false;
      error:
        | 'invalid_payload'
        | 'fee_receiver_mismatch'
        | 'fee_value_mismatch'
        | 'signature_invalid'
        | 'signature_mismatch'
        | 'unsupported_chain';
    };

const FORWARDER_SETTLED_EVENT_ABI = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

async function receiptMatchesSettlement(
  chainId: number,
  txHash: Hex,
  forwarder: Address,
  payer: Address,
  nonce: Hex,
  merchant: Address,
  merchantValue: bigint,
  feeReceiver: Address,
  feeValue: bigint,
): Promise<boolean> {
  const chain = chainObjectForId(chainId);
  if (!chain) return false;
  const client = createPublicClient({
    chain,
    transport: transportForChain(chainId),
  });
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') return false;

  // Eip3009Forwarder は merchant / feeReceiver 双方への safeTransfer が成功した後にだけ
  // Settled を emit し、失敗時は tx 全体が revert する。そのため expected forwarder 発火かつ
  // 6 field 完全一致の event が対象 settle の成立証明になる。同一 batch の別 settle を
  // nonce だけで誤帰属させず、receipt 全体の Transfer 合算で正規 batch を拒否もしない。
  return parseEventLogs({
    abi: FORWARDER_SETTLED_EVENT_ABI,
    eventName: 'Settled',
    logs: receipt.logs.filter((log) =>
      isAddressEqual(log.address, forwarder),
    ),
    strict: true,
  }).some(
    ({ args }) =>
      isAddressEqual(args.from, payer) &&
      args.nonce === nonce &&
      isAddressEqual(args.merchant, merchant) &&
      args.merchantValue === merchantValue &&
      isAddressEqual(args.feeReceiver, feeReceiver) &&
      args.feeValue === feeValue,
  );
}

async function receiptMatchesSettlementOrFalse(
  chainId: number,
  txHash: Hex,
  forwarder: Address,
  payer: Address,
  nonce: Hex,
  merchant: Address,
  merchantValue: bigint,
  feeReceiver: Address,
  feeValue: bigint,
): Promise<boolean> {
  try {
    return await receiptMatchesSettlement(
      chainId,
      txHash,
      forwarder,
      payer,
      nonce,
      merchant,
      merchantValue,
      feeReceiver,
      feeValue,
    );
  } catch {
    return false;
  }
}

export async function resolveFacilitatorPaymentStatus(
  raw: unknown,
): Promise<FacilitatorPaymentStatus> {
  const parsed = parseFacilitatorRequest(raw);
  if (!parsed.ok) return { ok: false, error: 'invalid_payload' };

  const { chainId, params, signature, expectedFeeValue } = parsed.parsed;
  const token = jpycAddressFor(chainId);
  const forwarder = configuredJpycForwarderFor(chainId);
  const expectedFeeReceiver = feeReceiverFor(chainId);
  if (!token || !forwarder || !expectedFeeReceiver) {
    return { ok: false, error: 'unsupported_chain' };
  }
  if (getAddress(params.feeReceiver) !== getAddress(expectedFeeReceiver)) {
    return { ok: false, error: 'fee_receiver_mismatch' };
  }
  if (params.feeValue !== expectedFeeValue) {
    return { ok: false, error: 'fee_value_mismatch' };
  }

  let signer: Address;
  try {
    signer = await recoverReceiveWithAuthorizationSigner(
      params,
      chainId,
      token,
      forwarder,
      signature,
    );
  } catch {
    return { ok: false, error: 'signature_invalid' };
  }
  if (getAddress(signer) !== params.from) {
    return { ok: false, error: 'signature_mismatch' };
  }

  const base = { ok: true as const, chainId, payer: params.from };
  const nonce = buildForwarderNonce(params, chainId, forwarder);

  try {
    const idem = await readIdempotency(
      'x402fac:idem:',
      chainId,
      params.from,
      nonce,
    );
    if (idem.state === 'indeterminate') {
      return { ...base, state: 'indeterminate' };
    }

    const used = await readAuthorizationUsed(
      chainId,
      token,
      params.from,
      nonce,
    );
    if (!used) {
      // hash 有り + unused は broadcast 済み tx の未確定/revert を区別できない。unused と断定して
      // 新 payment を許すと二重払いへ波及するため、hash が消えるまでは indeterminate に閉じる。
      return {
        ...base,
        state: idem.state === 'hash' ? 'indeterminate' : 'unused',
      };
    }

    if (
      idem.state === 'hash' &&
      (await receiptMatchesSettlementOrFalse(
        chainId,
        idem.txHash,
        forwarder,
        params.from,
        nonce,
        params.merchant,
        params.merchantValue,
        params.feeReceiver,
        params.feeValue,
      ))
    ) {
      return { ...base, state: 'settled', txHash: idem.txHash };
    }

    // relayer replacement 後は broadcast 直後に保存した hash と、authorization を実際に
    // 消費した tx hash が異なりうる。旧 hash の不成立が 30 分の回復不能へ波及するのを断つため、
    // その場合だけ署名 nonce の AuthorizationUsed event から実行 tx を再解決する。
    const txHash = await findAuthorizationUsedTransactionHash(
      chainId,
      token,
      params.from,
      nonce,
    );
    if (
      !txHash ||
      !(await receiptMatchesSettlementOrFalse(
        chainId,
        txHash,
        forwarder,
        params.from,
        nonce,
        params.merchant,
        params.merchantValue,
        params.feeReceiver,
        params.feeValue,
      ))
    ) {
      return { ...base, state: 'indeterminate' };
    }
    return { ...base, state: 'settled', txHash };
  } catch (error) {
    // status の KV/RPC/receipt 障害は payment の真実を変えない。既存 verify/settle の応答や
    // 呼出元の本処理へ波及させず、read-only 回復だけを indeterminate として再試行可能に保つ。
    logger.warn('x402.facilitator.status.indeterminate', {
      chainId,
      error,
    });
    return { ...base, state: 'indeterminate' };
  }
}
