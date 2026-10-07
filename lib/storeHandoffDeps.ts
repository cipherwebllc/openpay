import 'server-only';

// 受け渡し (lib/storeHandoff.ts) の本番の依存: Upstash KV と、中継と同じ forwarder 設定・RPC 読み取り。

import { createHmac, randomBytes } from 'node:crypto';
import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { hasMatchingForwarderSettlement } from '@/lib/relay/settlementReceipt';
import {
  authorizationExpiredUnused,
  type AuthorizationExpiryClient,
} from '@/lib/x402/authorizationExpiry';
import type { StoreHandoffResolveDeps } from '@/lib/storeHandoffResolve';
import { kvMget, kvSet, kvSetNxGet } from '@/lib/kv';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { feeReceiverFor } from '@/lib/relay/forwarderSettleService';
import {
  MAX_VALUE,
  findAuthorizationUsedTransactionHash,
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
  type HandoffClosedMark,
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

// 署名の枠の中身: 署名・締め切りの印・壊れた値 (読めない)。
type AuthSlot = { auth: HandoffAuth } | { closed: true } | null;
function parseAuthSlot(raw: string): AuthSlot {
  const v = parseJson<Record<string, unknown>>(raw);
  if (!v || typeof v !== 'object') return null;
  if (v.closed === true) return { closed: true };
  return typeof v.nonce === 'string' ? { auth: v as unknown as HandoffAuth } : null;
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
    const slot = typeof auth === 'string' ? parseAuthSlot(auth) : null;
    return {
      session: parseJson<HandoffSession>(session ?? null),
      auth: slot && 'auth' in slot ? slot.auth : null,
      txHash: typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as Hex) : null,
      closed: !!slot && 'closed' in slot,
    };
  },
  async claimAuth(id: string, auth: HandoffAuth, ttlSec: number) {
    const r = await kvSetNxGet(handoffAuthKey(id), JSON.stringify(auth), ttlSec);
    if (!r.ok) return null;
    // 生の null だけが「新しく置けた」。既存値が読めない (壊れている) ときは置けていないので、
    // 成功とは言わず KV 障害として止める (偽の成功を出さない)。
    if (r.value === null) return { existing: null };
    const slot = parseAuthSlot(r.value);
    if (!slot) return null;
    return 'closed' in slot ? { existing: null, closed: true } : { existing: slot.auth };
  },
  async closeSlot(id: string, mark: HandoffClosedMark, ttlSec: number) {
    const r = await kvSetNxGet(handoffAuthKey(id), JSON.stringify(mark), ttlSec);
    if (!r.ok) return null;
    if (r.value === null) return { closed: true };
    // 既存が読めない値なら締め切れたとは言わない (止める)。
    const slot = parseAuthSlot(r.value);
    if (!slot) return null;
    return 'closed' in slot ? { closed: true } : { closed: false, existing: slot.auth };
  },
  async putTx(id: string, txHash: Hex, ttlSec: number) {
    const r = await kvSetNxGet(handoffTxKey(id), txHash, ttlSec);
    if (!r.ok) return null;
    // 既に記録済みならその hash (端末の再送・別の送信)。読めない値なら記録できたとは言わない。
    if (r.value === null) return txHash;
    return /^0x[0-9a-fA-F]{64}$/.test(r.value) ? (r.value as Hex) : null;
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

const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

function publicClientFor(chainId: number) {
  const chain = chainObjectForId(chainId);
  if (!chain) throw new Error('unsupported_chain');
  return createPublicClient({ chain, transport: transportForChain(chainId) });
}

const handoffFeeReceiverFor = (chainId: number) => {
  const r = feeReceiverFor(chainId);
  return r && isAddress(r) ? getAddress(r) : null;
};

export function resolveDeps(): StoreHandoffResolveDeps {
  return {
    expectedChainId: storeGasWalletChain().id,
    nowSec: () => Math.floor(Date.now() / 1000),
    jpycAddressFor,
    forwarderFor: jpycForwarderFor,
    feeReceiverFor: handoffFeeReceiverFor,
    async successfulReceipt(chainId: number, txHash: Hex) {
      try {
        const receipt = await publicClientFor(chainId).getTransactionReceipt({ hash: txHash });
        return receipt.status === 'success'
          ? { logs: receipt.logs as Log[], blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }
          : null;
      } catch (error) {
        // 「見つからない」だけを null にする。RPC 障害は throw のまま (判定は結論を出さない)。
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    async usedAtFinalized(chainId: number, token: Address, from: Address, nonce: Hex) {
      // 確定ブロックで使用済みか。読んだ後で同じ番号の正規ブロックの hash を確かめる (reorg 中は false)。
      const client = publicClientFor(chainId);
      const block = await client.getBlock({ blockTag: 'finalized' });
      if (typeof block.number !== 'bigint' || typeof block.hash !== 'string') return false;
      const used = await client.readContract({
        address: token,
        abi: AUTHORIZATION_STATE_ABI,
        functionName: 'authorizationState',
        args: [from, nonce],
        blockNumber: block.number,
      });
      const canonical = await client.getBlock({ blockNumber: block.number });
      return used === true && canonical.hash === block.hash;
    },
    async isFinalizedCanonical(chainId: number, blockNumber: bigint, blockHash: Hex) {
      // 確定ブロックがそのブロック以降まで進み、いまの正規チェーンの同じ番号のブロックが同じ hash か
      // (reorg で消えた成功を「支払い済み」にしない)。
      const client = publicClientFor(chainId);
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      if (typeof finalized.number !== 'bigint' || finalized.number < blockNumber) return false;
      const canonical = await client.getBlock({ blockNumber });
      return canonical.hash === blockHash;
    },
    hasMatchingSettlement: hasMatchingForwarderSettlement,
    readAuthorizationUsed,
    findAuthorizationUsedTransactionHash,
    expiredUnused: ({ chainId, ...input }) =>
      authorizationExpiredUnused({
        ...input,
        client: publicClientFor(chainId) as unknown as AuthorizationExpiryClient,
      }),
  };
}
