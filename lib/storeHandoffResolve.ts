import 'server-only';

// 「お店の端末で送る」1 件の結論 (plans/store-gas-wallet.md P2b)。お客様の画面はこの結論だけに従う。
//   - settled: 信頼する forwarder の Settled (payer・nonce・分割額の 6 項目一致) を、確定 (finalized) 済みで
//     正規 (canonical) のブロックの receipt で確かめた → txHash
//   - expired_unused: 確定ブロックの時刻が期限を過ぎ、そのブロックで authorizationState が未使用
//     (= この署名はもう使えない。お支払いは行われていない)
//   - used_unresolved: 確定ブロックで使用済み (= この署名はもう二度と使えない) だが、この支払いの Settled を
//     見つけられない (検索範囲より前・取消)。支払い済みとも、行われていないとも言わない (お客様がウォレットで確かめる)
//   - pending: それ以外 (送信待ち・確定待ち・RPC 障害・署名時と設定が違う)。「行われていない」とは言わない
// 判定に使うのはチェーンだけ。nonce は署名した時点の forwarder・手数料受取口でお客様が計算した値を受け取り、
// それがサーバの今の設定と一致し、かつ同じ値から計算し直した nonce と一致するときだけ判定する。

import { getAddress, isAddress, isHex, maxUint256, type Address, type Hex, type Log } from 'viem';
import { buildForwarderNonce, type ForwarderSettleParams } from '@/lib/relay/forwarderIntent';
import type { AuthorizationWindow } from '@/lib/relay/authorizationUsedLookup';
import {
  STORE_DEVICE_CLOCK_SKEW_SEC,
  STORE_DEVICE_FEE_WEI,
  STORE_DEVICE_MAX_VALIDITY_SEC,
} from '@/lib/storeDevicePayment';

export type StoreHandoffResolution =
  | { ok: true; state: 'settled'; txHash: Hex }
  | { ok: true; state: 'expired_unused' }
  | { ok: true; state: 'used_unresolved' }
  // confirming = この支払いの Settled を含む成功 tx があり確定待ち。txHash はその tx (店の端末の確認先に使う・
  // 結論ではない = 支払い済みとは言わない)。
  | { ok: true; state: 'pending'; confirming?: boolean; txHash?: Hex };

export type SuccessfulReceipt = { logs: Log[]; blockNumber: bigint; blockHash: Hex };

export type StoreHandoffResolveDeps = {
  /**
   * 結果を確かめてよいチェーンか (設定済みのチェーン = storeDeviceChainConfig が値を返す)。読むだけで資金を動かさない
   * ので開示の集合では絞らない (チェーンを開示から外した後も、そのチェーンで送った会計の結論を出す)。
   */
  isConfiguredChain: (chainId: number) => boolean;
  nowSec: () => number;
  jpycAddressFor: (chainId: number) => Address | null;
  forwarderFor: (chainId: number) => Address | null;
  feeReceiverFor: (chainId: number) => Address | null;
  /** 成功した receipt。見つからない・revert は null。RPC 障害は throw (「無い」と区別する)。 */
  successfulReceipt: (chainId: number, txHash: Hex) => Promise<SuccessfulReceipt | null>;
  /** そのブロックが確定済み (finalized 以下) で、いまの正規チェーンの同じブロックか。 */
  isFinalizedCanonical: (chainId: number, blockNumber: bigint, blockHash: Hex) => Promise<boolean>;
  hasMatchingSettlement: (
    logs: Log[],
    forwarder: Address,
    payer: Address,
    nonce: Hex,
    split: Pick<ForwarderSettleParams, 'merchant' | 'merchantValue' | 'feeReceiver' | 'feeValue'>,
  ) => boolean;
  readAuthorizationUsed: (chainId: number, token: Address, from: Address, nonce: Hex) => Promise<boolean>;
  /** 確定ブロックで使用済みか (正規チェーンを確かめる)。確かめられなければ false。 */
  usedAtFinalized: (chainId: number, token: Address, from: Address, nonce: Hex) => Promise<boolean>;
  findAuthorizationUsedTransactionHash: (
    chainId: number,
    token: Address,
    from: Address,
    nonce: Hex,
    window?: AuthorizationWindow,
  ) => Promise<Hex | null>;
  expiredUnused: (input: {
    chainId: number;
    token: Address;
    payer: Address;
    nonce: Hex;
    validBefore: bigint;
  }) => Promise<boolean>;
};

export type StoreHandoffResolveFailure = { ok: false; status: number; error: string };

/** 使用済みなのに Settled が見つからないとき、期限からこれだけ待ってから used_unresolved にする (ログの遅れ)。 */
export const USED_UNRESOLVED_AFTER_SEC = 300;

// 78 桁の数字は uint256 を超えうる。範囲外は nonce の計算 (uint256 の ABI encode) で例外 (= 500) になるので、
// ここで形の違う本文 (400) として弾く。
function parseWei(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) return null;
  const n = BigInt(value);
  return n <= maxUint256 ? n : null;
}

function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && isHex(value) && value.length === 66;
}

function sameAddress(a: unknown, b: Address): boolean {
  return typeof a === 'string' && isAddress(a, { strict: false }) && getAddress(a) === b;
}

// 同じ支払い (chain・nonce) の照会が続いても RPC (ログ検索を含む) を何度も走らせない、インスタンス内の覚え。
// ヒントの有無・値はキーに入れない (無関係な tx を付け替えて重い検索を繰り返させない)。
//   - 変わらない結論 (settled・expired_unused) は長め。
//   - pending・used_unresolved は短く (後から Settled が見つかる・確定が進む余地がある)。RPC 障害は覚えない。
// 同時に来た照会は、進行中の同じ処理を共有する。
const CACHE_MAX = 500;
const FINAL_TTL_MS = 10 * 60_000;
const SOFT_TTL_MS = 15_000;
type CacheEntry = { at: number; ttl: number; value: StoreHandoffResolution };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StoreHandoffResolution | null>>();

function cached(key: string): StoreHandoffResolution | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function isFinal(v: StoreHandoffResolution): boolean {
  return v.state === 'settled' || v.state === 'expired_unused';
}

function remember(key: string, value: StoreHandoffResolution): StoreHandoffResolution {
  // 変わらない結論は、弱い結論 (遅れて返った pending 等) で上書きしない。
  const prev = cached(key);
  if (prev && isFinal(prev) && !isFinal(value)) return prev;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ttl: isFinal(value) ? FINAL_TTL_MS : SOFT_TTL_MS, value });
  return value;
}

/** テスト用 (インスタンス内の覚えを消す)。 */
export function clearStoreHandoffResolveCache(): void {
  cache.clear();
  inflight.clear();
}

export async function resolveStoreHandoff(
  body: Record<string, unknown>,
  deps: StoreHandoffResolveDeps,
): Promise<StoreHandoffResolution | StoreHandoffResolveFailure> {
  const chainId = body.chainId;
  const merchantValue = parseWei(body.merchantValue);
  const validBefore = parseWei(body.validBefore);
  if (
    typeof chainId !== 'number' ||
    !deps.isConfiguredChain(chainId) ||
    typeof body.from !== 'string' ||
    !isAddress(body.from, { strict: false }) ||
    typeof body.merchant !== 'string' ||
    !isAddress(body.merchant, { strict: false }) ||
    merchantValue === null ||
    // お客様が署名する額は請求額 + 1 wei。それが uint256 に収まらない請求額の署名は存在しない。
    merchantValue > maxUint256 - STORE_DEVICE_FEE_WEI ||
    validBefore === null ||
    typeof body.intentSalt !== 'string' ||
    !isHex(body.intentSalt) ||
    body.intentSalt.length !== 66 ||
    typeof body.nonce !== 'string' ||
    !isHex(body.nonce) ||
    body.nonce.length !== 66 ||
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
  // 署名した時点の forwarder・手数料受取口がいまの設定と違う (設定が変わった) なら判定しない。
  if (!sameAddress(body.forwarder, forwarder) || !sameAddress(body.feeReceiver, feeReceiver)) {
    return { ok: true, state: 'pending' };
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
  if (nonce.toLowerCase() !== (body.nonce as string).toLowerCase()) {
    return { ok: false, status: 400, error: 'nonce_mismatch' };
  }
  const key = `${chainId}:${nonce.toLowerCase()}`;
  const split = {
    merchant: params.merchant,
    merchantValue,
    feeReceiver,
    feeValue: STORE_DEVICE_FEE_WEI,
  };
  // この支払いの Settled を含み、確定済みのブロックにある成功 receipt か。RPC 障害は throw のまま上げる。
  const checkTx = async (txHash: Hex): Promise<'settled' | 'unconfirmed' | 'no'> => {
    const receipt = await deps.successfulReceipt(chainId, txHash);
    if (!receipt || !deps.hasMatchingSettlement(receipt.logs, forwarder, params.from, nonce, split)) {
      return 'no';
    }
    return (await deps.isFinalizedCanonical(chainId, receipt.blockNumber, receipt.blockHash))
      ? 'settled'
      : 'unconfirmed';
  };

  const known = cached(key);
  if (known && isFinal(known)) return known;

  const hint = isTxHash(body.txHash) ? body.txHash : undefined;
  try {
    // 端末が知らせた tx (ヒント) は安い確認 (receipt 1 件) なので毎回見る。一致しなければ無視される。
    if (hint) {
      const r = await checkTx(hint);
      if (r === 'settled') return remember(key, { ok: true, state: 'settled', txHash: hint });
      if (r === 'unconfirmed') return remember(key, { ok: true, state: 'pending', confirming: true, txHash: hint });
    }
  } catch {
    return { ok: true, state: 'pending' }; // RPC 障害は結論を出さず覚えない
  }
  // ヒントの確認を待つ間に、同じ支払いの別の照会が結論を覚えたかもしれないので読み直す。
  const latest = cached(key);
  if (latest) return latest; // 重い確認 (ログ検索) は短い間は繰り返さない

  const running = inflight.get(key);
  if (running) return (await running) ?? { ok: true, state: 'pending' };
  const work = (async (): Promise<StoreHandoffResolution | null> => {
    try {
      const used = await deps.readAuthorizationUsed(chainId, token, params.from, nonce);
      if (used) {
        // 使用済みは入金の証明ではない (取消の可能性)。この nonce を使った tx を探し、Settled を照合する。
        // 署名が使われうる時刻 (受け渡しが受け付けた有効窓の上限 + 時計のずれ) に絞れるようにする (RPC の範囲制限)。
        const found = await deps.findAuthorizationUsedTransactionHash(chainId, token, params.from, nonce, {
          validAfter: params.validAfter,
          validBefore,
          maxWindowSec: STORE_DEVICE_MAX_VALIDITY_SEC + STORE_DEVICE_CLOCK_SKEW_SEC,
        });
        if (found) {
          const r = await checkTx(found);
          if (r === 'settled') return remember(key, { ok: true, state: 'settled', txHash: found });
          if (r === 'unconfirmed') return remember(key, { ok: true, state: 'pending', confirming: true, txHash: found });
        }
        // 見つからない (検索範囲より前・取消)。確定ブロックでも使用済みで、期限から十分たったときだけ、
        // 「この署名はもう使えない (結果は不明)」を返す。支払い済みとも、行われていないとも言わない。
        if (
          deps.nowSec() > Number(validBefore) + USED_UNRESOLVED_AFTER_SEC &&
          (await deps.usedAtFinalized(chainId, token, params.from, nonce))
        ) {
          return remember(key, { ok: true, state: 'used_unresolved' });
        }
        return remember(key, { ok: true, state: 'pending' });
      }
      // 確定ブロックで期限切れ・未使用なら、この署名はもう使えない (無関係な tx のヒントは判定に混ぜない)。
      const expired = await deps.expiredUnused({ chainId, token, payer: params.from, nonce, validBefore });
      return remember(key, expired ? { ok: true, state: 'expired_unused' } : { ok: true, state: 'pending' });
    } catch {
      return null; // RPC 障害は結論を出さず覚えない
    }
  })();
  inflight.set(key, work);
  try {
    return (await work) ?? { ok: true, state: 'pending' };
  } finally {
    inflight.delete(key);
  }
}
