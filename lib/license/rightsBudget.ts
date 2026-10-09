import 'server-only';

import { randomUUID } from 'node:crypto';
import { kvEval } from '@/lib/kv';
import { LICENSE_VERIFY_BUDGET } from './verifyBudget';

// SIWE 認証済み経路 (content / library / holders) の権利照合 RPC の同時実行枠 (第 7 回レビュー B9)。
// verify (公開 API・store:license:verify:rpc) と delivery (store:delivery:rpc) と同じ Lua (8 枠・60 秒 lease) を
// 別 key で持ち、認証済み経路が公開 API の枠を食い潰さず、逆も起きないようにする。
export const LICENSE_RIGHTS_BUDGET_KEY = 'store:license:rights:rpc';
const RELEASE = 'return redis.call("ZREM",KEYS[1],ARGV[1]); ';

export type LicenseRightsAdmission = {
  acquire(): Promise<string | null>;
  release(token: string): Promise<void>;
};

export async function acquireLicenseRightsBudget(): Promise<string | null> {
  const token = randomUUID();
  const result = await kvEval<number>(LICENSE_VERIFY_BUDGET, [LICENSE_RIGHTS_BUDGET_KEY], [String(Date.now()), token]);
  // 集計枠の障害時に無制限 RPC を開始しない。呼出側は権利 unknown として返す (denied にしない)。
  return result.ok && result.value === 1 ? token : null;
}

export async function releaseLicenseRightsBudget(token: string): Promise<void> {
  await kvEval(RELEASE, [LICENSE_RIGHTS_BUDGET_KEY], [token]);
}
