// forwarder (Eip3009Forwarder) の on-chain 健全性チェック。submit 前に「env の forwarder が本物の
// 我々の forwarder か」を肯定的に検証する。EOA や別コントラクト/別 token/別 feeReceiver だと settle()
// が no-op SUCCESS して「API 成功・着金ゼロ・authorization 未消費」になるため、検証成功時のみ submit へ
// 進む (false-success を構造的に排除)。
//
// 抽出元は app/api/relay/jpyc/route.ts の verifyRecoverForwarder (CDX-1)。**挙動・ログイベント名は不変**
// (決済 route の既存テストが無改変で green であることが受け入れ条件)。recover relay と x402 facilitator の
// settle が共通で使う (forwarderSettleService 経由)。

import {
  createPublicClient,
  parseAbi,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { logger } from '@/lib/logger';
import { SUPPORTED_CHAINS, transportFor } from './relayProvider';

// CDX-1: forwarder の immutable getter (Eip3009Forwarder.token / feeReceiver)。健全性チェックで読む。
const FORWARDER_GETTERS_ABI = parseAbi([
  'function token() view returns (address)',
  'function feeReceiver() view returns (address)',
]);

// CDX-1: chain 別 forwarder 健全性チェックの判定キャッシュ (process lifetime)。'valid' (肯定的に検証済み)
// と DETERMINISTIC 無効 (no-code / token mismatch / feeReceiver mismatch・恒久) のみキャッシュする。
// 検証不能 (RPC throw 等) はキャッシュせず毎リクエストで再試行する (自己回復)。値: 'valid' = 健全,
// 文字列(理由) = 恒久的に無効。
const forwarderVerdictCache = new Map<number, 'valid' | string>();
// 設計 (Codex 4 round の最終形): 「**肯定的に検証できた時だけ submit**」。
// getBytecode/getter の throw (RPC flake でも別コントラクトの revert でも) は理由を問わず
// 「今回は検証不能」とし submit しない (= 非 null を返す) が **キャッシュしない** → 次リクエストで再試行し
// 自己回復する。これにより:
//   (a) false-success (EOA / 別コントラクトの settle no-op) を完全に塞ぐ (検証成功時のみ先へ進むため)。
//   (b) 一時的 RPC flake で chain を恒久 503 キャッシュしない (throw は非キャッシュ)。
//   (c) エラー文字列を transport/contract に分類する fragile なロジックが不要になる。
// 代償は「RPC flake 中の初回 settle が standard へ落ちる」だけ (安全・自己回復・利用者は支払える)。
// 返り値: null = 肯定的に検証済み (submit 可) / 非 null = 503 relay_not_configured に倒す理由。
export async function verifyForwarderHealth(
  chainId: number,
  forwarder: Address,
  jpyc: Address,
  feeReceiver: Address,
): Promise<string | null> {
  const cached = forwarderVerdictCache.get(chainId);
  if (cached !== undefined) return cached === 'valid' ? null : cached;

  const client = createPublicClient({
    chain: SUPPORTED_CHAINS[chainId].chain,
    transport: transportFor(chainId),
  });

  // STEP 1: bytecode。no-code (EOA/未デプロイ) は DETERMINISTIC 無効 → キャッシュ + 503。
  //         throw は検証不能 → 非キャッシュで 503 (次回再試行)。
  let code: Hex | undefined;
  try {
    code = await client.getBytecode({ address: forwarder });
  } catch (e) {
    logger.warn('relay.jpyc.forwarder_unverified', {
      chainId,
      error: e instanceof Error ? e.message : String(e),
    });
    return 'forwarder_unverified'; // 非キャッシュ: 次リクエストで再試行
  }
  if (!code || code === '0x') {
    forwarderVerdictCache.set(chainId, 'no_bytecode');
    logger.error('relay.jpyc.forwarder_invalid', { chainId, forwarder, reason: 'no_bytecode' });
    return 'no_bytecode';
  }

  // STEP 2: immutable getter を **肯定的に** 読む。throw は理由を問わず検証不能 → 非キャッシュ 503。
  //         token()/feeReceiver() を持たない別コントラクトも、RPC flake も、ここで一律に submit しない
  //         (= false-success を構造的に排除)。値が取れた時だけ不一致判定へ進む。
  let token: Address;
  let onChainFeeReceiver: Address;
  try {
    token = await client.readContract({
      address: forwarder,
      abi: FORWARDER_GETTERS_ABI,
      functionName: 'token',
    });
    onChainFeeReceiver = await client.readContract({
      address: forwarder,
      abi: FORWARDER_GETTERS_ABI,
      functionName: 'feeReceiver',
    });
  } catch (e) {
    logger.warn('relay.jpyc.forwarder_unverified', {
      chainId,
      error: e instanceof Error ? e.message : String(e),
    });
    return 'forwarder_unverified'; // 非キャッシュ: getter が取れない限り submit しない
  }

  // 値が取れた → DETERMINISTIC 不一致判定 (恒久・キャッシュする)。
  let reason: string | null = null;
  if (getAddress(token) !== getAddress(jpyc)) {
    reason = `token_mismatch(${token} != ${jpyc})`;
  } else if (getAddress(onChainFeeReceiver) !== getAddress(feeReceiver)) {
    reason = `fee_receiver_mismatch(${onChainFeeReceiver} != ${feeReceiver})`;
  }

  if (reason) {
    forwarderVerdictCache.set(chainId, reason);
    logger.error('relay.jpyc.forwarder_invalid', { chainId, forwarder, reason });
    return reason;
  }

  forwarderVerdictCache.set(chainId, 'valid');
  return null;
}
