import 'server-only';

import {
  AGENT_ACTIVITY_PAGE_SIZE,
  type AgentActivityItem,
  type AgentActivityResponse,
} from '@/lib/agent/activityTypes';
import { isKvConfigured, kvIncr } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

const inFlight = new Map<string, Promise<AgentActivityResponse>>();

function matches(value: unknown, pattern: RegExp): value is string {
  // $ は末尾改行の直前にも一致する。改行付き入力による正規形・行検証の迂回を断つ。
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function upstream(
  kind: 'request' | 'http' | 'json' | 'shape' | 'row',
): AgentActivityResponse {
  // 例外 message / 上流本文にはキー入り URL が混ざり得るため、ログへの秘密の波及を断つ。
  logger.warn('agent.activity.upstream', { kind });
  return { ok: false, reason: 'upstream' };
}

async function consumeBudgetWindow(
  key: string,
  max: number,
  ttlSec: number,
): Promise<boolean> {
  // 守るのは無料 API 枠で決済ではない。KV 障害 (カウントそのものが取れない) を閲覧へ波及させないため fail-open。
  // 枠が尽きても上流の NOTOK が upstream になるだけで、履歴なしの偽成功にはしない。
  // INCR と初回 TTL は 1 回の EVAL に閉じる (lib/kv.ts INCR_EXPIRE_ON_FIRST): TTL の設定失敗を理由に、
  // 既に取得できた「超過」の判定まで捨てて通すことをしない。KV コマンドも 1 窓 1 回で済む。
  try {
    const count = await kvIncr(key, { initialTtlSec: ttlSec });
    if (!count.ok) return true;
    return count.value <= max;
  } catch {
    return true;
  }
}

async function consumeBudget(): Promise<boolean> {
  // KV 未設定も閲覧を止めない (上の fail-open と同じ隔離境界)。
  if (!isKvConfigured()) return true;
  const now = Date.now();
  if (!(await consumeBudgetWindow(
    `agent:activity:budget:m:${Math.floor(now / 60_000)}`,
    120,
    120,
  ))) return false;
  return consumeBudgetWindow(
    `agent:activity:budget:d:${new Date(now).toISOString().slice(0, 10)}`,
    30_000,
    2 * 24 * 60 * 60,
  );
}

async function fetchActivity(
  address: string,
  contractAddress: string,
  apiKey: string,
): Promise<AgentActivityResponse> {
  // 全アドレスの取得が同じ API 枠を消費するため、IP を分散した枯渇の波及を断つ。
  if (!(await consumeBudget())) return { ok: false, reason: 'busy' };

  const url = new URL('https://api.etherscan.io/v2/api');
  url.search = new URLSearchParams({
    chainid: '137',
    module: 'account',
    action: 'tokentx',
    contractaddress: contractAddress,
    address,
    page: '1',
    offset: String(AGENT_ACTIVITY_PAGE_SIZE),
    sort: 'desc',
    apikey: apiKey,
  }).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      // 上流の停滞を閲覧リクエストへ長時間波及させず、redirect 先へのキー流出も断つ。
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    return upstream('request');
  }
  if (!response.ok) return upstream('http');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return upstream('json');
  }
  // 上流障害を「履歴なし」として表示する波及を断ち、確認済みの正常空だけを受理する。
  if (!isRecord(body) || !Array.isArray(body.result)) return upstream('shape');
  if (!(body.status === '1' || (
    body.status === '0' &&
    body.message === 'No transactions found' &&
    body.result.length === 0
  ))) return upstream('shape');

  const forwarder = jpycForwarderFor(137)?.toLowerCase();
  const occurrences = new Map<string, number>();
  const nowSec = Math.floor(Date.now() / 1000);
  let previousTimestamp = Number.MAX_SAFE_INTEGER;
  const items: AgentActivityItem[] = [];
  for (const row of body.result) {
    // 行を捨てて続行すると欠けた履歴を完全と見せるため、不正行は全体を失敗にする。
    if (
      !isRecord(row) ||
      !matches(row.hash, /^0x[0-9a-f]{64}$/i) ||
      !matches(row.from, /^0x[0-9a-f]{40}$/i) ||
      !matches(row.to, /^0x[0-9a-f]{40}$/i) ||
      !matches(row.value, /^[0-9]{1,78}$/) ||
      !matches(row.timeStamp, /^[0-9]+$/) ||
      typeof row.contractAddress !== 'string' ||
      row.contractAddress.toLowerCase() !== contractAddress
    ) return upstream('row');

    // 時刻だけを数値化する。丸められた時刻が期間判定へ波及しないよう安全な整数に限定。
    const timestamp = Number(row.timeStamp);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return upstream('row');
    // 極端な未来時刻は client の Date 変換を RangeError にし、残高カードごと描画を落とす。表示へ波及する前に断つ。
    if (timestamp > nowSec + 86_400) return upstream('row');
    // 期間集計の「完全」判定は、上流が新しい順 (sort=desc) で返すことに依存する。順序が崩れた応答を
    // 完全な履歴として集計へ渡さない。
    if (timestamp > previousTimestamp) return upstream('row');
    previousTimestamp = timestamp;

    const hash = row.hash.toLowerCase() as `0x${string}`;
    const from = row.from.toLowerCase() as `0x${string}`;
    const to = row.to.toLowerCase() as `0x${string}`;
    if (from !== address && to !== address) return upstream('row');
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    if (from === address && to === address) continue;
    // 0 円の transfer は誰でも安価に送れる。似せたアドレスを相手欄に出させる address poisoning と、
    // 直近 50 件の枠を埋めて本物の履歴を押し出す嫌がらせが、表示へ波及するのを断つ。
    if (/^0+$/.test(row.value)) continue;

    const direction = from === address ? 'out' : 'in';
    items.push({
      key: `${hash}:${from}:${to}:${row.value}:${occurrence}`,
      hash,
      timestamp,
      direction,
      counterparty: direction === 'out' ? to : from,
      valueAtomic: row.value,
      viaOpenPay: direction === 'out' && to === forwarder,
    });
  }

  return {
    ok: true,
    chainId: 137,
    items,
    rawCount: body.result.length,
    truncated: body.result.length >= AGENT_ACTIVITY_PAGE_SIZE,
    asOf: nowSec,
  };
}

export async function fetchAgentActivity(address: string): Promise<AgentActivityResponse> {
  // route 以外の呼出元から不正な照会が上流へ波及するのを断つ。
  if (!matches(address, /^0x[0-9a-f]{40}$/)) {
    return { ok: false, reason: 'invalid_address' };
  }
  const deployment = defaultDeploymentForSymbol('jpyc');
  if (deployment.chainId !== 137) return { ok: false, reason: 'unsupported_chain' };
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: 'not_configured' };

  const pending = inFlight.get(address);
  if (pending) return pending;
  // 同じアドレスの同時閲覧が予算と API 呼出数へ重複して波及するのを断つ。
  const request = fetchActivity(address, deployment.address.toLowerCase(), apiKey)
    .finally(() => inFlight.delete(address));
  inFlight.set(address, request);
  return request;
}
