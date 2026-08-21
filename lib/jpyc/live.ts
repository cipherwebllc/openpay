// JPYC のオンチェーン事実 (総供給・残高・直近 Transfer) を公開 RPC から読む純粋寄りの
// モジュール。AI エージェント向け有料 API (/api/paid/usdc/jpyc/*) の content 部で使う。
//
// 設計の肝:
//   - **事実の提示のみ**。助言・予測・価格の解釈は一切しない (応答の notice で固定宣言)。
//   - チェーン単位の RPC 失敗は **その行だけ status:'error'** にして他チェーンを返す
//     (隣へ波及させない・掟 13)。全チェーン失敗の判定は呼び出し側 (route) が行う。
//   - 1 チェーンの hang が全体を止めないよう timeout + allSettled (lib/walletBalances と同じ)。
//   - transfers の走査は **固定ブロック窓** (チェーン別に約 1 時間) と limit で上限を切る。
//     窓を広げるときは RPC コストを計測してから (plans/jpyc-live-data-api.md)。
//   - アドレス定数は lib/tokens.ts (JPYC_CHAINS 連動) を単一情報源とし、ここで増やさない。

import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  isAddress,
  parseAbiItem,
  type Address,
} from 'viem';
import {
  JPYC_CHAINS,
  chainForSlug,
  chainObjectForId,
  isJpycChainSlug,
  transportForChain,
  type JpycChainSlug,
} from '@/lib/chains';
import { deploymentsForSymbol, type TokenDeployment } from '@/lib/tokens';

export const JPYC_LIVE_SCHEMA_VERSION = '1.0';
export const JPYC_LIVE_NOTICE =
  'On-chain facts read directly from public RPC endpoints at request time. Informational only — not financial advice, not an offer, quote or solicitation. Verify independently before acting.';

/** 公開 RPC の hang 対策 (lib/walletBalances の BALANCE_TIMEOUT_MS と同じ発想・少し長め)。 */
const RPC_TIMEOUT_MS = 5_000;

/**
 * transfers の走査窓 (ブロック数)。各チェーンの平均ブロック時間で約 1 時間:
 * Polygon ≈2s → 1,800 / Kaia ≈1s → 3,600 / Avalanche ≈2s → 1,800 / Ethereum ≈12s → 300。
 * 定数で持つのは「RPC コストの上限を設計時に固定する」ため。
 */
export const TRANSFER_WINDOW_BLOCKS: Readonly<Record<JpycChainSlug, bigint>> = {
  polygon: 1_800n,
  kaia: 3_600n,
  avalanche: 1_800n,
  ethereum: 300n,
};

export const TRANSFERS_DEFAULT_LIMIT = 20;
export const TRANSFERS_MAX_LIMIT = 100;

/**
 * eth_getLogs の 1 リクエスト当たりブロック数。公開 RPC は範囲を厳しく制限する
 * (Polygon の viem 既定 drpc 無料枠は ≈100 ブロック超で拒否・2026-08-21 実測: 1,800 一括は
 * 即エラー、100×18 逐次で 2.95s / JPYC 56 件)。100 にしておけばどの公開 RPC でも通る。
 */
export const TRANSFER_CHUNK_BLOCKS = 100n;
/** チャンクの同時実行数。公開 RPC の rate limit と timeout (5s) の折り合い。 */
const TRANSFER_CHUNK_CONCURRENCY = 4;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

type ChainRowBase = {
  chain: JpycChainSlug;
  chainId: number;
  contract: Address;
};

export type SupplyRow = ChainRowBase &
  (
    | {
        status: 'ok';
        blockNumber: string;
        totalSupply: string;
        totalSupplyFormatted: string;
      }
    | { status: 'error'; error: string }
  );

export type BalanceRow = ChainRowBase &
  (
    | {
        status: 'ok';
        blockNumber: string;
        balance: string;
        balanceFormatted: string;
      }
    | { status: 'error'; error: string }
  );

export type TransferItem = {
  blockNumber: string;
  txHash: string;
  logIndex: number;
  from: Address;
  to: Address;
  value: string;
  valueFormatted: string;
};

export type TransfersResult = ChainRowBase &
  (
    | {
        status: 'ok';
        fromBlock: string;
        toBlock: string;
        items: TransferItem[];
      }
    | { status: 'error'; error: string }
  );

// ---------- 入力の検証 (純関数・route は支払い要求より先にこれで 400 を返す) ----------

/** `chain` クエリ。省略は「全対応チェーン」、未知の値は null (= 400)。 */
export function parseChainParam(
  raw: string | null,
): JpycChainSlug[] | null {
  if (raw === null || raw === '') return [...JPYC_CHAINS];
  const v = raw.toLowerCase();
  return isJpycChainSlug(v) ? [v] : null;
}

/** `chain` 必須版 (transfers)。 */
export function parseRequiredChainParam(raw: string | null): JpycChainSlug | null {
  if (raw === null || raw === '') return null;
  const v = raw.toLowerCase();
  return isJpycChainSlug(v) ? v : null;
}

export function parseAddressParam(raw: string | null): Address | null {
  if (raw === null || raw === '') return null;
  return isAddress(raw) ? (raw as Address) : null;
}

/** 任意アドレス (transfers の絞り込み)。省略は undefined、不正は null。 */
export function parseOptionalAddressParam(
  raw: string | null,
): Address | undefined | null {
  if (raw === null || raw === '') return undefined;
  return isAddress(raw) ? (raw as Address) : null;
}

export function parseLimitParam(raw: string | null): number | null {
  if (raw === null || raw === '') return TRANSFERS_DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return Math.min(n, TRANSFERS_MAX_LIMIT);
}

// ---------- RPC ----------

function deploymentFor(slug: JpycChainSlug): TokenDeployment {
  const chainId = chainForSlug(slug).id;
  const dep = deploymentsForSymbol('jpyc').find((d) => d.chainId === chainId);
  if (!dep) {
    // JPYC_CHAINS と TOKEN_DEPLOYMENTS は同じ配列から作られるので、ここに来るのは配線ミス。
    throw new Error(`jpyc/live: no JPYC deployment for ${slug} (chainId ${chainId})`);
  }
  return dep;
}

function clientFor(chainId: number) {
  const chain = chainObjectForId(chainId);
  if (!chain) throw new Error(`jpyc/live: chain ${chainId} is not in supportedChains`);
  return createPublicClient({ chain, transport: transportForChain(chain.id) });
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  // timeout 後に RPC が遅れて reject しても unhandled rejection にしない。
  p.catch(() => {});
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`rpc timeout (${RPC_TIMEOUT_MS}ms)`)), RPC_TIMEOUT_MS),
  );
  return Promise.race([p, timeout]);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function perChain<T>(
  chains: readonly JpycChainSlug[],
  read: (slug: JpycChainSlug, dep: TokenDeployment) => Promise<T>,
  onError: (base: ChainRowBase, error: string) => T,
): Promise<T[]> {
  const settled = await Promise.allSettled(
    chains.map((slug) => {
      const dep = deploymentFor(slug);
      return withTimeout(read(slug, dep));
    }),
  );
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const dep = deploymentFor(chains[i]);
    return onError(
      { chain: chains[i], chainId: dep.chainId, contract: dep.address },
      errorMessage(r.reason),
    );
  });
}

export async function readSupply(chains: readonly JpycChainSlug[]): Promise<SupplyRow[]> {
  return perChain<SupplyRow>(
    chains,
    async (slug, dep) => {
      const client = clientFor(dep.chainId);
      const [blockNumber, totalSupply] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({
          address: dep.address,
          abi: erc20Abi,
          functionName: 'totalSupply',
        }) as Promise<bigint>,
      ]);
      return {
        chain: slug,
        chainId: dep.chainId,
        contract: dep.address,
        status: 'ok',
        blockNumber: blockNumber.toString(),
        totalSupply: totalSupply.toString(),
        totalSupplyFormatted: formatUnits(totalSupply, dep.decimals),
      };
    },
    (base, error) => ({ ...base, status: 'error', error }),
  );
}

export async function readBalance(
  address: Address,
  chains: readonly JpycChainSlug[],
): Promise<BalanceRow[]> {
  return perChain<BalanceRow>(
    chains,
    async (slug, dep) => {
      const client = clientFor(dep.chainId);
      const [blockNumber, balance] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({
          address: dep.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }) as Promise<bigint>,
      ]);
      return {
        chain: slug,
        chainId: dep.chainId,
        contract: dep.address,
        status: 'ok',
        blockNumber: blockNumber.toString(),
        balance: balance.toString(),
        balanceFormatted: formatUnits(balance, dep.decimals),
      };
    },
    (base, error) => ({ ...base, status: 'error', error }),
  );
}

export async function readTransfers(
  chain: JpycChainSlug,
  opts: { limit: number; address?: Address },
): Promise<TransfersResult> {
  const dep = deploymentFor(chain);
  const base: ChainRowBase = { chain, chainId: dep.chainId, contract: dep.address };
  try {
    const result = await withTimeout(
      (async () => {
        const client = clientFor(dep.chainId);
        const toBlock = await client.getBlockNumber();
        const window = TRANSFER_WINDOW_BLOCKS[chain];
        const fromBlock = toBlock > window ? toBlock - window : 0n;

        // 窓を新しい順のチャンクに割る。limit に達したら残りは読まない (早期終了)。
        const ranges: { from: bigint; to: bigint }[] = [];
        for (let end = toBlock; end >= fromBlock; end -= TRANSFER_CHUNK_BLOCKS) {
          const start = end - TRANSFER_CHUNK_BLOCKS + 1n;
          ranges.push({ from: start > fromBlock ? start : fromBlock, to: end });
          if (start <= fromBlock) break;
        }
        const fetchChunk = async (r: { from: bigint; to: bigint }) => {
          const common = {
            address: dep.address,
            event: TRANSFER_EVENT,
            fromBlock: r.from,
            toBlock: r.to,
          } as const;
          // address 絞り込みは from/to どちらか一致 = 2 クエリの和集合 (eth_getLogs は OR できない)。
          return opts.address
            ? (
                await Promise.all([
                  client.getLogs({ ...common, args: { from: opts.address } }),
                  client.getLogs({ ...common, args: { to: opts.address } }),
                ])
              ).flat()
            : client.getLogs(common);
        };

        const seen = new Set<string>();
        const items: TransferItem[] = [];
        for (let i = 0; i < ranges.length && items.length < opts.limit; i += TRANSFER_CHUNK_CONCURRENCY) {
          const batch = ranges.slice(i, i + TRANSFER_CHUNK_CONCURRENCY);
          const logs = (await Promise.all(batch.map(fetchChunk))).flat();
          // 新しい順 (blockNumber desc → logIndex desc)
          logs.sort((a, b) => {
            if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
            return (b.logIndex ?? 0) - (a.logIndex ?? 0);
          });
          for (const log of logs) {
            const key = `${log.transactionHash}:${log.logIndex}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const { from, to, value } = log.args as { from: Address; to: Address; value: bigint };
            items.push({
              blockNumber: log.blockNumber.toString(),
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              from,
              to,
              value: value.toString(),
              valueFormatted: formatUnits(value, dep.decimals),
            });
            if (items.length >= opts.limit) break;
          }
        }
        return { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), items };
      })(),
    );
    return { ...base, status: 'ok', ...result };
  } catch (e) {
    return { ...base, status: 'error', error: errorMessage(e) };
  }
}

/** 全チェーンが error なら「RPC 到達不能」= route は 503 (settle されない)。 */
export function allFailed(rows: readonly { status: 'ok' | 'error' }[]): boolean {
  return rows.length > 0 && rows.every((r) => r.status === 'error');
}
