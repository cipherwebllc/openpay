import 'server-only';

// 受け渡し (lib/storeHandoff.ts) の本番の依存: Upstash KV と、中継と同じ forwarder 設定・RPC 読み取り。

import { createHmac, randomBytes } from 'node:crypto';
import { getAddress, isAddress, type Hex } from 'viem';
import { kvMget, kvSet, kvSetNxGet } from '@/lib/kv';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { feeReceiverFor } from '@/lib/relay/forwarderSettleService';
import {
  MAX_VALUE,
  getBalance,
  jpycAddressFor,
  readAuthorizationUsed,
} from '@/lib/relay/relayProvider';
import { storeGasWalletChain } from '@/lib/storeGasWallet';
import {
  handoffAuthKey,
  handoffSessionKey,
  handoffTxKey,
  type HandoffAuth,
  type HandoffDeps,
  type HandoffSession,
  type HandoffStore,
} from '@/lib/storeHandoff';

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const kvHandoffStore: HandoffStore = {
  async putSession(id: string, session: HandoffSession, ttlSec: number) {
    const r = await kvSet(handoffSessionKey(id), JSON.stringify(session), { nx: true, ttlSec });
    if (!r.ok) return null;
    return r.value === 'OK';
  },
  async read(id: string) {
    const r = await kvMget([handoffSessionKey(id), handoffAuthKey(id), handoffTxKey(id)]);
    if (!r.ok) return null;
    const [session, auth, tx] = r.value;
    return {
      session: parseJson<HandoffSession>(session ?? null),
      auth: parseJson<HandoffAuth>(auth ?? null),
      txHash: typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as Hex) : null,
    };
  },
  async claimAuth(id: string, auth: HandoffAuth, ttlSec: number) {
    const r = await kvSetNxGet(handoffAuthKey(id), JSON.stringify(auth), ttlSec);
    if (!r.ok) return null;
    // 生の null だけが「新しく置けた」。既存値が読めない (壊れている) ときは置けていないので、
    // 成功とは言わず KV 障害として止める (偽の成功を出さない)。
    if (r.value === null) return { existing: null };
    const existing = parseJson<HandoffAuth>(r.value);
    return existing ? { existing } : null;
  },
  async putTx(id: string, txHash: Hex, ttlSec: number) {
    const r = await kvSet(handoffTxKey(id), txHash, { nx: true, ttlSec });
    // 既に記録済み (NX で null) も成功扱い (端末の再送)。
    return r.ok;
  },
};

// IP_HASH_SECRET を用途 (store-handoff) で分けた HMAC。新しい秘密値 (env) を増やさない。秘密値が無い・短い
// 環境では null を返し、受け渡し自体を止める (lib/net/ipHash の最小長と同じ基準)。
const MIN_SECRET_BYTES = 32;
export function handoffMac(message: string): string | null {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) return null;
  return createHmac('sha256', secret).update(`store-handoff:${message}`).digest('hex');
}

export function handoffDeps(): HandoffDeps {
  return {
    store: kvHandoffStore,
    expectedChainId: storeGasWalletChain().id,
    nowSec: () => Math.floor(Date.now() / 1000),
    expectedFeeValue: 1n,
    maxValue: MAX_VALUE,
    maxValidityWindowSec: 180,
    jpycAddressFor,
    forwarderFor: jpycForwarderFor,
    feeReceiverFor: (chainId: number) => {
      const r = feeReceiverFor(chainId);
      return r && isAddress(r) ? getAddress(r) : null;
    },
    getBalance,
    readAuthorizationUsed,
    mac: handoffMac,
    randomBytes,
  };
}
