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
import { logger } from '@/lib/logger';
import type { JpycLiveErrorCode } from './liveSchema';

export const JPYC_LIVE_SCHEMA_VERSION = '2.2';
/**
 * 応答に載せる notice は短いコードにする (反復購入する AI の入力トークンを毎回消費しないため)。
 * 全文は JPYC_LIVE_NOTICE_TEXT として OpenAPI の description と Schema の description に置き、
 * 法的表示は termsUrl (利用規約) が担う — 表示を消すのでなく置き場所を変える (2026-08-23 裁定)。
 */
export const JPYC_LIVE_NOTICE_CODE = 'onchain-facts-only';
export const JPYC_LIVE_NOTICE_TEXT =
  'On-chain facts read directly from public RPC endpoints at request time. Informational only — not financial advice, not an offer, quote or solicitation. Verify independently before acting.';
export const JPYC_LIVE_TERMS_URL = 'https://open-pay.jp/en/terms';

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
    | { status: 'unavailable'; errorCode: JpycLiveErrorCode; retryable: boolean }
  );

export type BalanceRow = ChainRowBase &
  (
    | {
        status: 'ok';
        blockNumber: string;
        balance: string;
        balanceFormatted: string;
      }
    | { status: 'unavailable'; errorCode: JpycLiveErrorCode; retryable: boolean }
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

/**
 * 差分取得の位置。「(block, logIndex) までは見た」を表し、次回はそれより新しい Transfer だけ返す。
 * logIndex=-1 は「その block のログは 1 件も見ていない (= block 内の全ログが新しい)」。
 * 文字列表現は `${block}:${logIndex}` (応答 nextCursor をそのまま cursor に渡せる)。
 */
export type TransferCursor = { block: bigint; logIndex: number };

export const TRANSFER_CURSOR_PATTERN = '^[0-9]+:(?:-1|[0-9]+)$';

export function formatCursor(c: TransferCursor): string {
  return `${c.block.toString()}:${c.logIndex}`;
}

/** 省略は undefined、形式不正は null (= 400)。 */
export function parseCursorParam(raw: string | null): TransferCursor | undefined | null {
  if (raw === null || raw === '') return undefined;
  const m = /^([0-9]+):(-1|[0-9]+)$/.exec(raw);
  if (!m) return null;
  return { block: BigInt(m[1]), logIndex: Number(m[2]) };
}

function isNewerThan(block: bigint, logIndex: number, c: TransferCursor): boolean {
  return block > c.block || (block === c.block && logIndex > c.logIndex);
}

export type TransfersResult = ChainRowBase &
  (
    | {
        status: 'ok';
        fromBlock: string;
        toBlock: string;
        items: TransferItem[];
        /** snapshot (cursor なし・新しい順) / delta (cursor あり・古い順)。hasMore の意味が異なる。 */
        mode: 'snapshot' | 'delta';
        /** 次回 `cursor` に渡すと、この応答より新しい Transfer だけが返る。入力 cursor より後退しない。 */
        nextCursor: string;
        /** limit で打ち切った (cursor 付きなら nextCursor で続きを取る)。 */
        hasMore: boolean;
        /** cursor が走査窓より古く、cursor〜fromBlock の間のイベントは走査していない。 */
        truncated: boolean;
      }
    | { status: 'unavailable'; errorCode: JpycLiveErrorCode; retryable: boolean }
    /** cursor.block が現在の chain head を **許容量を超えて** 先行している = 実運用の
     * ラグ/リオーグでは説明できない位置。items:[] のまま同じ cursor を echo し続けると
     * 買い手が空振り課金し続けるので settle 前に 400 で止める。形式不正 (invalid_query) と
     * 区別できるよう別コードにする (route が cursorAheadOfHead() を返す)。 */
    | { status: 'cursor_ahead_of_head' }
  );

/**
 * cursor が chain head より先行していても「まだ新着なし」として扱うブロック数。
 *
 * なぜ必要か (E10 の残欠陥): 「新着なし」応答の nextCursor はその時点の head (live.ts の
 * items 0 件分岐) なので、正常な polling でも **次の呼び出しが head より前を見ている RPC
 * ノードに当たる**ことがある (負荷分散された複数ノードのラグ・リオーグ後の巻き戻し)。
 * これを一律 400 にすると、買い手側に非がないのにフィードが止まる。数ブロック程度の
 * 先行は空応答 (課金は発生するが状態は壊れない) で吸収し、それを超える場合だけ 400 にする。
 */
export const CURSOR_HEAD_TOLERANCE_BLOCKS = 64n;

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
  // 上限超は黙って丸めず 400 (Schema/OpenAPI の契約と一致・AI 向けは補正より予測可能性)。
  if (!Number.isSafeInteger(n) || n < 1 || n > TRANSFERS_MAX_LIMIT) return null;
  return n;
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

export type JpycLiveFailure = { errorCode: JpycLiveErrorCode; retryable: boolean };

/**
 * RPC 失敗を応答用の errorCode に分類する。**生のメッセージは応答に載せない**
 * (viem のメッセージは RPC URL を含み得る)。
 *   - contract_read_failed: コントラクト呼び出し自体が revert / ABI 不一致 (再試行しても同じ) → retryable=false
 *   - rpc_unavailable: timeout・HTTP・transport 障害 (時間を置けば直り得る) → retryable=true
 */
/**
 * ログ用に RPC エラー文を無害化する。URL は host だけ残す (Alchemy 等の鍵付き RPC URL を
 * Vercel ログに残さない)・`api_key|apikey|token|authorization=…` は伏せる・300 字に切る。
 */
export function sanitizeRpcError(message: string): string {
  return message
    .replace(/https?:\/\/[^\s)"'`]+/g, (url) => {
      try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}/[redacted]`;
      } catch {
        return '[redacted-url]';
      }
    })
    .replace(/\b(api[_-]?key|token|authorization|secret)=([^&\s"']+)/gi, '$1=[redacted]')
    .slice(0, 300);
}

export function classifyFailure(
  e: unknown,
  ctx?: { op: 'supply' | 'balance' | 'transfers'; chain: JpycChainSlug },
): JpycLiveFailure {
  const name = e instanceof Error ? e.name : '';
  const failure: JpycLiveFailure =
    name === 'ContractFunctionExecutionError' || name === 'ContractFunctionRevertedError'
      ? { errorCode: 'contract_read_failed', retryable: false }
      : { errorCode: 'rpc_unavailable', retryable: true };
  // 応答には分類コードだけを出すが、**サーバログには原因を残す** (2026-08-23 の本番 503 は
  // ログが無く切り分けできなかった)。メッセージは sanitizeRpcError で URL/鍵を伏せて 300 字に切る。
  if (ctx) {
    logger.warn('jpyc.live.rpc_failed', {
      op: ctx.op,
      chain: ctx.chain,
      errorCode: failure.errorCode,
      errorName: name || typeof e,
      message: sanitizeRpcError(e instanceof Error ? e.message : String(e)),
    });
  }
  return failure;
}

async function perChain<T>(
  op: 'supply' | 'balance',
  chains: readonly JpycChainSlug[],
  read: (slug: JpycChainSlug, dep: TokenDeployment) => Promise<T>,
  onError: (base: ChainRowBase, failure: JpycLiveFailure) => T,
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
      classifyFailure(r.reason, { op, chain: chains[i] }),
    );
  });
}

export async function readSupply(chains: readonly JpycChainSlug[]): Promise<SupplyRow[]> {
  return perChain<SupplyRow>(
    'supply',
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
    (base, failure) => ({ ...base, status: 'unavailable', ...failure }),
  );
}

export async function readBalance(
  address: Address,
  chains: readonly JpycChainSlug[],
): Promise<BalanceRow[]> {
  return perChain<BalanceRow>(
    'balance',
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
    (base, failure) => ({ ...base, status: 'unavailable', ...failure }),
  );
}

export async function readTransfers(
  chain: JpycChainSlug,
  opts: { limit: number; address?: Address; cursor?: TransferCursor },
): Promise<TransfersResult> {
  const dep = deploymentFor(chain);
  const base: ChainRowBase = { chain, chainId: dep.chainId, contract: dep.address };
  type TransferContent =
    | { kind: 'cursor_ahead_of_head' }
    | {
        kind: 'ok';
        fromBlock: string;
        toBlock: string;
        items: TransferItem[];
        mode: 'snapshot' | 'delta';
        nextCursor: string;
        hasMore: boolean;
        truncated: boolean;
      };
  try {
    const result = await withTimeout<TransferContent>(
      (async (): Promise<TransferContent> => {
        const client = clientFor(dep.chainId);
        const toBlock = await client.getBlockNumber();
        const window = TRANSFER_WINDOW_BLOCKS[chain];
        const fromBlock = toBlock > window ? toBlock - window : 0n;
        // cursor があれば走査の下端を cursor.block まで縮める (それより古い block は読まない)。
        // cursor が窓より古い場合は窓の下端までしか読めない = truncated。
        const cursor = opts.cursor;
        // cursor が現在の chain head より新しい = 未来の位置 (E10)。
        //   - 許容量以内: RPC ノードのラグやリオーグで通常の polling でも起こるので
        //     「まだ新着なし」= items:[] + **入力 cursor をそのまま echo** で返す
        //     (getLogs は呼ばない。cursor を head へ後退させると既読分を再取得させてしまう)
        //   - 許容量超: 実運用では説明できないので settle 前に 400 (課金されない)
        if (cursor !== undefined && cursor.block > toBlock) {
          if (cursor.block > toBlock + CURSOR_HEAD_TOLERANCE_BLOCKS) {
            return { kind: 'cursor_ahead_of_head' };
          }
          return {
            kind: 'ok',
            fromBlock: fromBlock.toString(),
            toBlock: toBlock.toString(),
            items: [],
            mode: 'delta',
            nextCursor: formatCursor(cursor),
            hasMore: false,
            truncated: false,
          };
        }
        const truncated = cursor !== undefined && cursor.block < fromBlock;
        const scanFrom =
          cursor !== undefined && cursor.block > fromBlock ? cursor.block : fromBlock;

        // 2 モード (2026-08-23 裁定):
        //   - snapshot (cursor なし): 新しい順。直近の様子を見る用途
        //   - delta (cursor あり): **古い順**。cursor 直後から limit 件ずつ消化する差分ストリーム。
        //     新しい順で limit 打ち切りにすると、間のイベントが永久に返らない (取りこぼし)
        // チャンク列もモードに合わせて並べ、limit に達したら残りは読まない (早期終了)。
        const delta = cursor !== undefined;
        const ranges: { from: bigint; to: bigint }[] = [];
        if (delta) {
          for (let start = scanFrom; start <= toBlock; start += TRANSFER_CHUNK_BLOCKS) {
            const end = start + TRANSFER_CHUNK_BLOCKS - 1n;
            ranges.push({ from: start, to: end < toBlock ? end : toBlock });
          }
        } else {
          for (let end = toBlock; end >= scanFrom; end -= TRANSFER_CHUNK_BLOCKS) {
            const start = end - TRANSFER_CHUNK_BLOCKS + 1n;
            ranges.push({ from: start > scanFrom ? start : scanFrom, to: end });
            if (start <= scanFrom) break;
          }
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
        // limit+1 件まで集めて hasMore を判定する (余分の 1 件は返さない)。
        const want = opts.limit + 1;
        for (let i = 0; i < ranges.length && items.length < want; i += TRANSFER_CHUNK_CONCURRENCY) {
          const batch = ranges.slice(i, i + TRANSFER_CHUNK_CONCURRENCY);
          const logs = (await Promise.all(batch.map(fetchChunk))).flat();
          // snapshot: 新しい順 (desc) / delta: 古い順 (asc)。blockNumber → logIndex
          logs.sort((a, b) => {
            const sign = delta ? 1 : -1;
            if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? sign : -sign;
            return ((a.logIndex ?? 0) - (b.logIndex ?? 0)) * sign;
          });
          for (const log of logs) {
            // cursor 以前 (見た分) は除外。同一 block 内は logIndex で厳密に比較する
            if (cursor !== undefined && !isNewerThan(log.blockNumber, log.logIndex, cursor)) continue;
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
            if (items.length >= want) break;
          }
        }
        const hasMore = items.length > opts.limit;
        if (hasMore) items.length = opts.limit;

        // nextCursor = 返した中で**最新**の位置 (delta は末尾・snapshot は先頭)。0 件なら
        // 「toBlock まで見た」= (toBlock, -1)。ただし**入力 cursor より後退させない**
        // (同一 block で 0 件だと (block,-1) < (block,k) となり既読ログを次回再取得してしまう)。
        let next: TransferCursor =
          items.length > 0
            ? (() => {
                const edge = delta ? items[items.length - 1] : items[0];
                return { block: BigInt(edge.blockNumber), logIndex: edge.logIndex };
              })()
            : { block: toBlock, logIndex: -1 };
        if (cursor !== undefined && !isNewerThan(next.block, next.logIndex, cursor)) next = cursor;
        return {
          kind: 'ok',
          fromBlock: fromBlock.toString(),
          toBlock: toBlock.toString(),
          items,
          mode: delta ? ('delta' as const) : ('snapshot' as const),
          nextCursor: formatCursor(next),
          hasMore,
          truncated,
        };
      })(),
    );
    if (result.kind === 'cursor_ahead_of_head') {
      return { ...base, status: 'cursor_ahead_of_head' };
    }
    const { kind: _kind, ...rest } = result;
    return { ...base, status: 'ok', ...rest };
  } catch (e) {
    return { ...base, status: 'unavailable', ...classifyFailure(e, { op: 'transfers', chain }) };
  }
}

/** 全チェーンが unavailable なら「RPC 到達不能」= route は 503 (settle されない)。 */
export function allFailed(rows: readonly { status: 'ok' | 'unavailable' }[]): boolean {
  return rows.length > 0 && rows.every((r) => r.status === 'unavailable');
}
