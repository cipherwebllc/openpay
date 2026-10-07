import 'server-only';

// 「お店の端末で送る」1 件の結論 (plans/store-gas-wallet.md P2b)。お客様の画面はこの結論だけに従う。
//   - settled: 信頼する forwarder の Settled (payer・nonce・分割額の 6 項目一致) を receipt で確かめた → txHash
//   - expired_unused: 確定 (finalized) ブロックの時刻が期限を過ぎ、そのブロックで authorizationState が未使用
//     (= この署名はもう使えない。お支払いは行われていない)
//   - pending: それ以外 (送信待ち・確定待ち・取消済みの可能性・RPC 障害)。「行われていない」とは言わない
// 判定に使うのはチェーンだけ (KV の受け渡しの状態・お客様の端末の時計・revert した 1 本の tx は根拠にしない)。
// 受け渡しのセッションが消えた後でも判定できるよう、意図の値はお客様の画面から受け取り、nonce はサーバが
// 自分の forwarder・手数料受取口で計算し直す (値をごまかしても別の nonce になるだけで、他人の支払いは動かない)。

import { getAddress, isAddress, isHex, type Address, type Hex, type Log } from 'viem';
import { buildForwarderNonce, type ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import { STORE_DEVICE_FEE_WEI } from '@/lib/storeDevicePayment';

export type StoreHandoffResolution =
  | { ok: true; state: 'settled'; txHash: Hex }
  | { ok: true; state: 'expired_unused' }
  | { ok: true; state: 'pending' };

export type StoreHandoffResolveDeps = {
  expectedChainId: number;
  jpycAddressFor: (chainId: number) => Address | null;
  forwarderFor: (chainId: number) => Address | null;
  feeReceiverFor: (chainId: number) => Address | null;
  /** 成功した receipt の logs (見つからない・revert・RPC 障害は null)。 */
  successfulReceiptLogs: (chainId: number, txHash: Hex) => Promise<Log[] | null>;
  hasMatchingSettlement: (
    logs: Log[],
    forwarder: Address,
    payer: Address,
    nonce: Hex,
    split: Pick<ForwarderSettleParams, 'merchant' | 'merchantValue' | 'feeReceiver' | 'feeValue'>,
  ) => boolean;
  readAuthorizationUsed: (chainId: number, token: Address, from: Address, nonce: Hex) => Promise<boolean>;
  findAuthorizationUsedTransactionHash: (
    chainId: number,
    token: Address,
    from: Address,
    nonce: Hex,
  ) => Promise<Hex | null>;
  expiredUnused: (input: {
    chainId: number;
    token: Address;
    payer: Address;
    nonce: Hex;
    validBefore: bigint;
    txHash?: Hex;
  }) => Promise<boolean>;
};

export type StoreHandoffResolveFailure = { ok: false; status: number; error: string };

function parseWei(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) return null;
  return BigInt(value);
}

function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && isHex(value) && value.length === 66;
}

const PENDING: StoreHandoffResolution = { ok: true, state: 'pending' };

export async function resolveStoreHandoff(
  body: Record<string, unknown>,
  deps: StoreHandoffResolveDeps,
): Promise<StoreHandoffResolution | StoreHandoffResolveFailure> {
  const chainId = body.chainId;
  const merchantValue = parseWei(body.merchantValue);
  const validBefore = parseWei(body.validBefore);
  if (
    typeof chainId !== 'number' ||
    chainId !== deps.expectedChainId ||
    typeof body.from !== 'string' ||
    !isAddress(body.from, { strict: false }) ||
    typeof body.merchant !== 'string' ||
    !isAddress(body.merchant, { strict: false }) ||
    merchantValue === null ||
    validBefore === null ||
    typeof body.intentSalt !== 'string' ||
    !isHex(body.intentSalt) ||
    body.intentSalt.length !== 66 ||
    (body.txHash !== undefined && body.txHash !== null && !isTxHash(body.txHash))
  ) {
    return { ok: false, status: 400, error: 'invalid_body' };
  }
  const token = deps.jpycAddressFor(chainId);
  const forwarder = deps.forwarderFor(chainId);
  const feeReceiver = deps.feeReceiverFor(chainId);
  if (!token || !forwarder || !feeReceiver) {
    return { ok: false, status: 400, error: 'unsupported_chain' };
  }
  const params: ForwarderSettleParams = {
    from: getAddress(body.from),
    merchant: getAddress(body.merchant),
    merchantValue,
    feeReceiver,
    feeValue: STORE_DEVICE_FEE_WEI,
    validAfter: 0n,
    validBefore,
    intentSalt: body.intentSalt as Hex,
  };
  const nonce = buildForwarderNonce(params, chainId, forwarder);
  const split = {
    merchant: params.merchant,
    merchantValue,
    feeReceiver,
    feeValue: STORE_DEVICE_FEE_WEI,
  };
  const settledBy = async (txHash: Hex): Promise<boolean> => {
    const logs = await deps.successfulReceiptLogs(chainId, txHash);
    return logs !== null && deps.hasMatchingSettlement(logs, forwarder, params.from, nonce, split);
  };

  try {
    // 端末が知らせた tx (ヒント) を先に確かめる。別の取引・revert・置換は一致しないので無視される。
    const hint = isTxHash(body.txHash) ? body.txHash : undefined;
    if (hint && (await settledBy(hint))) return { ok: true, state: 'settled', txHash: hint };

    const used = await deps.readAuthorizationUsed(chainId, token, params.from, nonce);
    if (used) {
      // 使用済みは入金の証明ではない (取消の可能性)。この nonce を使った tx を探し、Settled を照合する。
      const found = await deps.findAuthorizationUsedTransactionHash(chainId, token, params.from, nonce);
      if (found && (await settledBy(found))) return { ok: true, state: 'settled', txHash: found };
      return PENDING;
    }
    const expired = await deps.expiredUnused({
      chainId,
      token,
      payer: params.from,
      nonce,
      validBefore,
      ...(hint ? { txHash: hint } : {}),
    });
    return expired ? { ok: true, state: 'expired_unused' } : PENDING;
  } catch {
    // RPC 障害は結論を出さない (支払い済みとも、行われていないとも言わない)。
    return PENDING;
  }
}
