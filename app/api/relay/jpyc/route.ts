// JPYC EIP-3009 relay endpoint (Phase 1: Polygon・Gelato sponsoredCall)。
//
// 顧客が transferWithAuthorization に EIP-712 署名 (eth_signTypedData_v4・任意ウォレットで可) →
// ここで検証 (署名 recover==from / 残高 / rate-limit) → Gelato REST sponsoredCall で submit
// (Gelato relayer が gas を 1Balance から負担) → poll → {txHash}。委任不要なので現行 7702 経路
// より到達が広い。詳細・段階計画は memory:jpyc-eip3009。
//
// env-gate: GELATO_SPONSOR_API_KEY 未設定なら relay_not_configured を返し、client は他 provider
// (7702 sponsorship / standard) に fallback する。実依存 (viem balanceOf / Gelato fetch / KV
// rate-limit) を inject して lib/relay/jpycRelay の純コアに委譲 (分岐は unit test で担保)。

import { NextResponse } from 'next/server';
import {
  createPublicClient,
  http,
  erc20Abi,
  isAddress,
  isHex,
  getAddress,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { kvLpush, kvLrange, kvLtrim, isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { resolveDeployment } from '@/lib/tokens';
import {
  relayJpycAuthorization,
  type RelayDeps,
  type RelayTaskOutcome,
} from '@/lib/relay/jpycRelay';

export const runtime = 'nodejs';

const GELATO_API_KEY = process.env.GELATO_SPONSOR_API_KEY;
const GELATO_BASE =
  process.env.GELATO_RELAY_BASE_URL ?? 'https://api.gelato.digital';
// relay 単発の上限 (濫用ガード)。GELATO_RELAY_MAX_JPYC は human JPYC (既定 100 万)。
const MAX_VALUE = (() => {
  const raw = process.env.GELATO_RELAY_MAX_JPYC;
  const human = raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 1_000_000n;
  return human * 10n ** 18n;
})();
const RL_MAX = 5; // window 内の最大 relay 回数 (per key)
const RL_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 4 * 1024;

// Gelato は Polygon 対応・Kaia 非対応 (memory:jpyc-eip3009)。Kaia は将来自前 relayer。
const SUPPORTED_CHAINS: Record<number, { chain: Chain; rpc?: string }> =
  {
    [polygon.id]: { chain: polygon, rpc: process.env.NEXT_PUBLIC_POLYGON_RPC_URL },
    [polygonAmoy.id]: {
      chain: polygonAmoy,
      rpc: process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL,
    },
  };

function jpycAddressFor(chainId: number): Address | null {
  if (!(chainId in SUPPORTED_CHAINS)) return null;
  const d = resolveDeployment('jpyc', chainId);
  return d ? d.address : null;
}

async function getBalance(
  chainId: number,
  token: Address,
  owner: Address,
): Promise<bigint> {
  const cfg = SUPPORTED_CHAINS[chainId];
  const client = createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpc ?? cfg.chain.rpcUrls.default.http[0]),
  });
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
}

// KV sliding-window rate-limit (kv は list ops のみなので timestamp list で近似)。
// KV 未設定時は通す (本番は KV 設定が前提)。
async function checkRateLimit(keys: string[]): Promise<boolean> {
  if (!isKvConfigured()) return true;
  const now = Date.now();
  for (const key of keys) {
    const k = `relay:rl:${key}`;
    await kvLpush(k, String(now));
    await kvLtrim(k, 0, RL_MAX * 4);
    const r = await kvLrange(k, 0, RL_MAX * 4);
    const recent = (r.ok ? r.value : []).filter(
      (ts) => now - Number(ts) < RL_WINDOW_MS,
    );
    if (recent.length > RL_MAX) return false;
  }
  return true;
}

async function submitSponsoredCall(
  chainId: number,
  target: Address,
  data: Hex,
): Promise<{ taskId: string }> {
  const res = await fetch(`${GELATO_BASE}/relays/v2/sponsored-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId,
      target,
      data,
      sponsorApiKey: GELATO_API_KEY,
    }),
  });
  if (!res.ok) throw new Error(`gelato_http_${res.status}`);
  const j = (await res.json()) as { taskId?: string };
  if (!j.taskId) throw new Error('gelato_no_task_id');
  return { taskId: j.taskId };
}

async function pollTask(taskId: string): Promise<RelayTaskOutcome> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${GELATO_BASE}/tasks/status/${taskId}`);
    if (res.ok) {
      const { task } = (await res.json()) as {
        task?: { taskState?: string; transactionHash?: Hex };
      };
      const state = task?.taskState;
      if (state === 'ExecSuccess' && task?.transactionHash) {
        return { state: 'success', txHash: task.transactionHash };
      }
      if (state === 'ExecReverted') {
        return { state: 'reverted', txHash: task?.transactionHash };
      }
      if (state === 'Cancelled' || state === 'Blacklisted' || state === 'NotFound') {
        return { state: 'error', detail: state };
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { state: 'error', detail: 'timeout' };
}

function anonymizeIp(ip: string): string {
  const first = ip.split(',')[0].trim();
  if (first.includes(':')) return first.split(':').slice(0, 4).join(':') + '::/64';
  const p = first.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : 'unknown';
}

function isDec(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

export async function POST(req: Request): Promise<NextResponse> {
  // relay 未構成なら早期に signal (client が fallback 判定できるよう専用コード)。
  if (!GELATO_API_KEY) {
    return NextResponse.json(
      { ok: false, error: 'relay_not_configured' },
      { status: 503 },
    );
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // shape 検証 (純コアに渡す前に型を固める)。
  if (
    typeof raw.chainId !== 'number' ||
    !Number.isInteger(raw.chainId) ||
    !isAddress(raw.from as string) ||
    !isAddress(raw.to as string) ||
    !isDec(raw.value) ||
    !isDec(raw.validAfter) ||
    !isDec(raw.validBefore) ||
    typeof raw.nonce !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.nonce) ||
    typeof raw.signature !== 'string' ||
    !isHex(raw.signature)
  ) {
    return NextResponse.json(
      { ok: false, error: 'invalid_payload' },
      { status: 400 },
    );
  }

  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );
  const auth = {
    from: getAddress(raw.from as string),
    to: getAddress(raw.to as string),
    value: BigInt(raw.value),
    validAfter: BigInt(raw.validAfter),
    validBefore: BigInt(raw.validBefore),
    nonce: raw.nonce as Hex,
  };

  const deps: RelayDeps = {
    nowSec: () => Math.floor(Date.now() / 1000),
    maxValue: MAX_VALUE,
    jpycAddressFor,
    getBalance,
    checkRateLimit,
    submitSponsoredCall,
    pollTask,
  };

  const result = await relayJpycAuthorization(
    { chainId: raw.chainId, auth, signature: raw.signature as Hex, rateLimitKeys: [auth.from, ipPrefix] },
    deps,
  );

  switch (result.kind) {
    case 'success':
      return NextResponse.json({ ok: true, txHash: result.txHash });
    case 'reverted':
      logger.warn('relay.jpyc.reverted', { txHash: result.txHash, chainId: raw.chainId });
      return NextResponse.json({ ok: false, reverted: true, txHash: result.txHash });
    case 'rejected':
      return NextResponse.json(
        { ok: false, error: result.reason },
        { status: result.httpStatus },
      );
    case 'relay_error':
      logger.warn('relay.jpyc.relay_error', { detail: result.detail, chainId: raw.chainId });
      return NextResponse.json(
        { ok: false, error: 'relay_error' },
        { status: 502 },
      );
  }
}
