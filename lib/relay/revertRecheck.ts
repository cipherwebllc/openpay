// relay 自身の tx が revert した後の authorization 再確認 (free relay と forwarder recover の共用・第 8 回レビュー A-01)。
//
// relay の tx が revert しても、同じ EIP-3009 authorization を別の tx (公開 mempool から calldata を写した前走り等) が
// 先に実行していれば、支払いはチェーン上で成立している。それを 'reverted' のまま返すと、client は保存した intent を
// 捨てて新しい署名を許し、顧客が 2 回払うことになる。そこで broadcast 後の 'reverted' に限り authorizationState を
// 読み直し、使用済みなら既存の 'pending' (送信前の既使用チェックと同じ txHash なし) に置き換える。client は intent を
// 保ったまま、既存の /api/relay/jpyc/status で実際に authorization を使った tx を解決する。
// 自分の tx の revert は自分の使用も巻き戻すので、ここで used = 別の tx が使った、と読める。
// 未使用・読み取り失敗は従来どおり 'reverted' を返す (応答が変わるのは「revert かつ使用済み」の 1 条件だけ)。
// relayBroadcast は触らない: 送信前の既使用チェックと同じく、authorizationState を読む判断は呼び元 (各経路) に置く。

import type { Address, Hex } from 'viem';
import { logger } from '@/lib/logger';
import type { RelayResult } from './relayTypes';

type RevertRecheckTarget = {
  chainId: number;
  token: Address;
  from: Address;
  nonce: Hex;
  // 既存の preflight_unavailable と同じイベント名の prefix ('relay.jpyc' / 'relay.forwarder')。
  logPrefix: string;
};

type CheckAuthorizationUsed = (
  chainId: number,
  token: Address,
  from: Address,
  nonce: Hex,
) => Promise<boolean>;

export async function recheckRevertedAuthorization(
  result: RelayResult,
  target: RevertRecheckTarget,
  checkAuthorizationUsed: CheckAuthorizationUsed | undefined,
): Promise<RelayResult> {
  if (result.kind !== 'reverted' || !checkAuthorizationUsed) return result;

  let used: boolean;
  try {
    used = await checkAuthorizationUsed(
      target.chainId,
      target.token,
      target.from,
      target.nonce,
    );
  } catch (error) {
    // 再確認の RPC 障害を応答へ波及させない: 従来どおりの 'reverted' を返し、運営の観測用に warn だけ残す。
    logger.warn(`${target.logPrefix}.revert_recheck_unavailable`, {
      chainId: target.chainId,
      txHash: result.txHash,
      error,
    });
    return result;
  }
  if (!used) return result;

  // relay の tx は revert したが authorization は別の tx で使用済み (前走り等)。運営が追えるよう revert した
  // 自分の tx を残す。応答には付けない (explorer で失敗と見え、再支払いを誘うため)。
  logger.warn(`${target.logPrefix}.reverted_authorization_used`, {
    chainId: target.chainId,
    txHash: result.txHash,
  });
  return { kind: 'pending' };
}
