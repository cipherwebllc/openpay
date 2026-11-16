'use client';

// お店の画面 (/create の決済QR・レジ) が QR を出している間と、閉じた後 60 秒、forwarder の `Settled` を RPC で読み、
// 会計ごとの印 (bill key) から計算し直した nonce とちょうど一致した入金だけを、この端末の取引履歴 (localStorage) に
// 1 行書く。server へは何も送らない。hooks/useQrBillKey.ts が dynamic import して使う (/create の初期の chunk に入れない)。
//
// 見張りは、この module に 1 つ (画面の部品ではなく module が持つ): QR を閉じた後の 60 秒も、決済QR / レジのタブの
// 切り替えで部品が外れても続き、StrictMode の二重の effect でも 2 つにならない。/create を離れたら止める
// (stopQrSaleWatch)。出した bill key は、出し直しの分も含めて全部、表示をやめてから 60 秒まで memory に持つ
// (会計の写しと一緒・localStorage / sessionStorage には保存しない)。生きている bill key が無くなったら、読むのをやめる。
//
// 読み方 (チェーンごと・6 秒おき):
//   - getBlockNumber → getLogs (forwarder の Settled・この受取先宛て)。範囲は「前回読んだ最後の block − 10」から
//     「先頭 − 1 (Polygon は先頭 − 3)」。前回から間が空いても、先頭 − 90 より前は読まない。読む block が無ければ何もしない。
//   - 読んだ log (tx と log の番号) は覚えておき、重ねて読んだ分は落とす。
//   - タブが裏のあいだは読まない。RPC の失敗・時間切れは、その回を飛ばす (次の回に同じ範囲から読み直す)。
//   - 見つけた Settled ごとに、block の時刻を読み、生きている bill key のどれかに一致するかを計算する
//     (lib/qrSaleHistory.ts の matchSettledToBill)。一致しない Settled は何もしない。
//
// 行にするもの:
//   - その会計の 1 件目の一致で、着金額と利用料も会計の期待値と同じ → 会計の写しの明細・管理番号つきの行。
//   - 同じ会計の 2 件目以降の一致 (同じ QR への 2 回目の入金)・金額が期待値と違う一致 → 明細なしの行 (金額・お客様・tx)。
//   - 同じ tx に一致が 2 つ以上あるときは、どれも書かない (履歴の行は tx ごとに 1 つで、2 つの入金を 1 行にできない)。
//
// 保存の決まり (受注の書き手 lib/orderFeedHistoryRecorder.ts と同じ):
//   - 同じ tx の行が履歴にあれば書かない (txHash・大文字小文字を無視)。
//   - 印 (lib/qrSaleMarks.ts) を先に書けたときだけ行を書く。印は外さない。印 (自分の印と、受注の書き手の印) を読めない
//     端末では書かない。確かめるのは保存の直前 (block の時刻を待った後)。
//   - 受け入れている限界: 印を書いた後に履歴の保存が失敗した入金は、この端末の履歴に入らない。localStorage には、タブを
//     またいで読み書きの順を守らせる仕組みが無いので、別のタブが「読む → 書く」のあいだに割り込んだ結果は受け入れる
//     (既存の appendHistory・受注の書き手と同じ性質)。
//
// 付帯の処理 (掟 13): ここで起きた失敗 (RPC・計算・履歴と印の保存) は、QR の表示・残高の見張り・レジの操作へ波及させない。
// 外に出す関数は throw せず、何も返さない。

import { polygon, polygonAmoy } from 'viem/chains';
import { appendHistory, loadHistory } from './history';
import { logger } from './logger';
import { isTxHashLike } from './orderRelay';
import {
  buildQrSaleEntry,
  matchSettledToBill,
  readQrBill,
  readSettledLog,
  settledMatchesExpected,
  type QrBill,
  type QrBillInput,
  type SettledLog,
} from './qrSaleHistory';
import { addQrSaleMark, ORDER_FEED_MARKS_KEY, QR_SALE_MARKS_KEY, readTxMarks } from './qrSaleMarks';
import { QR_SALE_RPC_TIMEOUT_MS, readBlockTime, readChainHead, readSettledLogs } from './qrSaleRpc';

/** 読む間隔。 */
export const QR_SALE_POLL_MS = 6_000;
/** QR の表示をやめてから、その bill key を持っておく時間。 */
export const QR_SALE_KEEP_AFTER_HIDE_MS = 60_000;
/** 前回読んだ最後の block から、重ねて読み直す block の数。 */
export const QR_SALE_OVERLAP_BLOCKS = 10n;
/** 先頭から、これより前の block は読まない (間が空いたとき)。 */
export const QR_SALE_MAX_BACK_BLOCKS = 90n;

// 先頭から何 block 手前までを読むか (取り込まれたばかりの block を読まない)。Polygon は 3・ほかは 1。
const HEAD_MARGIN_BLOCKS: Record<number, bigint> = { [polygon.id]: 3n, [polygonAmoy.id]: 3n };
const headMargin = (chainId: number) => HEAD_MARGIN_BLOCKS[chainId] ?? 1n;

type WatchedBill = {
  bill: QrBill;
  /** 表示をやめた時刻 (表示中は null)。 */
  hiddenAt: number | null;
  /** この会計に一致した Settled の数。 */
  matched: number;
};
type ChainCursor = {
  /** 前回読んだ最後の block (まだ読めていなければ null)。 */
  lastTo: bigint | null;
  /** まだ 1 回も読めていないあいだに、読めなかった回 (RPC の失敗・タブが裏) があった。 */
  missed: boolean;
};

const bills = new Map<string, WatchedBill>();
const cursors = new Map<number, ChainCursor>();
const seenLogs = new Set<string>();
const blockTimes = new Map<string, bigint>();
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
// stopQrSaleWatch のたびに進める。RPC を待っている間に止められた回は、戻った後に何も書かない。
let generation = 0;
let warned = false;

function warnOnce(event: string, error?: unknown): void {
  if (warned) return;
  warned = true;
  logger.warn(event, error === undefined ? {} : { error });
}

function clearState(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  bills.clear();
  cursors.clear();
  seenLogs.clear();
  blockTimes.clear();
}

function cursorFor(chainId: number): ChainCursor {
  let cursor = cursors.get(chainId);
  if (!cursor) {
    cursor = { lastTo: null, missed: false };
    cursors.set(chainId, cursor);
  }
  return cursor;
}

// 返らない読み取りが 1 つあると、その後の回が全部止まる (running が戻らない) = その後の会計が 1 つも記帳されない。
// 読み取りの実装 (transport の timeout) に預けず、ここで待ち時間を切る。切った後に返った値は使わない。
function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('qr_sale_rpc_timeout')), QR_SALE_RPC_TIMEOUT_MS + 1_000);
    promise.then(
      (value) => {
        clearTimeout(id);
        resolve(value);
      },
      (error) => {
        clearTimeout(id);
        reject(error);
      },
    );
  });
}

async function blockTimeOf(chainId: number, blockNumber: bigint): Promise<bigint> {
  const key = `${chainId}:${blockNumber}`;
  const known = blockTimes.get(key);
  if (known !== undefined) return known;
  const time = await withDeadline(readBlockTime(chainId, blockNumber));
  if (typeof time !== 'bigint' || time <= 0n) throw new Error('qr_sale_block_time_unreadable');
  blockTimes.set(key, time);
  return time;
}

function historyHasTx(hash: string): boolean {
  return loadHistory().some((e) => e.txHash?.toLowerCase() === hash);
}

type Found = { watched: WatchedBill; settled: SettledLog; txHash: string; blockTime: bigint; withDetail: boolean };

// 保存の直前の確認 → 印 → 行 (頭の注記の「保存の決まり」)。
function save(found: Found): void {
  const hash = found.txHash.toLowerCase();
  const own = readTxMarks(QR_SALE_MARKS_KEY);
  const feed = readTxMarks(ORDER_FEED_MARKS_KEY);
  // 印を読めない端末では書かない (消した行を書き戻さない側に倒す)。
  if (!own || !feed) return;
  // 前に書いた tx (この書き手か、受注の書き手が書いて、店主が履歴から消した行を含む)。書き戻さない。
  if (own.has(hash) || feed.has(hash)) return;
  // 同じ tx の行がもうある (払った側の画面・お店の端末で送る・受注の書き手が書いた)。その行にも印を付ける。
  if (historyHasTx(hash)) {
    addQrSaleMark(hash);
    return;
  }
  // 先に印を書く。書けなければ行を書かない (この書き手が書いた行には、必ず印がある)。
  if (!addQrSaleMark(hash)) return;
  appendHistory(
    buildQrSaleEntry(found.watched.bill, found.settled, found.txHash, found.blockTime, found.withDetail),
  );
}

async function pollChain(chainId: number, startedGeneration: number): Promise<void> {
  const watched = [...bills.values()].filter((w) => w.bill.chainId === chainId);
  // 同じチェーンの会計は、同じ forwarder (lib/relay/forwarderConfig の jpycForwarderFor)。
  const forwarder = watched[0].bill.forwarder;
  const merchants = [...new Set(watched.map((w) => w.bill.merchant))];
  const cursor = cursorFor(chainId);

  const head = await withDeadline(readChainHead(chainId));
  if (startedGeneration !== generation) return;
  if (typeof head !== 'bigint') throw new Error('qr_sale_head_unreadable');
  const toBlock = head - headMargin(chainId);
  const oldest = head - QR_SALE_MAX_BACK_BLOCKS;
  let fromBlock: bigint;
  if (cursor.lastTo !== null) {
    const next = cursor.lastTo - QR_SALE_OVERLAP_BLOCKS;
    fromBlock = next > oldest ? next : oldest;
  } else {
    // 初めて読む回。QR を出してから読めない回があったら、その間の block も読む。
    fromBlock = cursor.missed ? oldest : toBlock - QR_SALE_OVERLAP_BLOCKS;
  }
  if (fromBlock < 0n) fromBlock = 0n;
  if (toBlock < fromBlock) return;

  const logs = await withDeadline(readSettledLogs(chainId, forwarder, merchants, fromBlock, toBlock));
  if (startedGeneration !== generation) return;
  // チェーンの順 (block → log の番号) に見る (同じ会計への 1 件目・2 件目の順)。番号の無い log (取り込み前) は読まない。
  const ordered = logs
    .flatMap((log) =>
      isTxHashLike(log.transactionHash) && typeof log.logIndex === 'number' && typeof log.blockNumber === 'bigint'
        ? [{ log, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber }]
        : [],
    )
    .sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );

  const found: Found[] = [];
  let complete = true;
  for (const { log, txHash, logIndex, blockNumber } of ordered) {
    const id = `${chainId}:${txHash.toLowerCase()}:${logIndex}`;
    if (seenLogs.has(id)) continue;
    const settled = readSettledLog(log, forwarder);
    if (!settled) {
      seenLogs.add(id);
      continue;
    }
    let blockTime: bigint;
    try {
      blockTime = await blockTimeOf(chainId, blockNumber);
    } catch {
      // block の時刻を読めなかった log は「読んだ」ことにしない。ここまでに一致した分は書き、残りは次の回に同じ範囲から読み直す。
      complete = false;
      break;
    }
    if (startedGeneration !== generation) return;
    seenLogs.add(id);
    // bill key は会計ごとに違う乱数なので、1 つの Settled が一致する会計は多くても 1 つ。
    for (const w of bills.values()) {
      if (w.bill.chainId !== chainId || matchSettledToBill(settled, blockTime, w.bill) === null) continue;
      // 明細を付けるのは、その会計の 1 件目の一致で、金額も期待値と同じときだけ。
      found.push({
        watched: w,
        settled,
        txHash,
        blockTime,
        withDetail: w.matched === 0 && settledMatchesExpected(settled, w.bill),
      });
      w.matched += 1;
      break;
    }
  }

  const perTx = new Map<string, number>();
  for (const f of found) perTx.set(f.txHash.toLowerCase(), (perTx.get(f.txHash.toLowerCase()) ?? 0) + 1);
  for (const f of found) {
    // 同じ tx に一致が 2 つ以上: 履歴の行は tx ごとに 1 つ (id = batch-<tx>) で、2 つの入金を 1 行にできないので書かない。
    if (perTx.get(f.txHash.toLowerCase()) !== 1) {
      warnOnce('qrSale.multiple_matches_in_tx');
      continue;
    }
    try {
      save(f);
    } catch (error) {
      // 1 件の保存の失敗 (履歴の読み書き・行の組み立て) を、残りの入金の記録へ波及させない。
      warnOnce('qrSale.save_failed', error);
    }
  }
  if (!complete) throw new Error('qr_sale_block_time_unreadable');
  cursor.lastTo = toBlock;
  cursor.missed = false;
}

async function tick(): Promise<void> {
  // 前の回がまだ RPC を待っている間は重ねない (同じ log を 2 回処理しない)。
  if (running) return;
  const now = Date.now();
  for (const [key, w] of bills) {
    if (w.hiddenAt !== null && now - w.hiddenAt > QR_SALE_KEEP_AFTER_HIDE_MS) bills.delete(key);
  }
  if (bills.size === 0) {
    clearState();
    return;
  }
  const chainIds = [...new Set([...bills.values()].map((w) => w.bill.chainId))];
  // タブが裏のあいだは読まない (戻ったら、前回の続き・先頭 − 90 のうち新しい方から読む)。
  if (document.visibilityState === 'hidden') {
    for (const chainId of chainIds) cursorFor(chainId).missed = true;
    return;
  }
  running = true;
  const startedGeneration = generation;
  try {
    for (const chainId of chainIds) {
      try {
        await pollChain(chainId, startedGeneration);
      } catch {
        // RPC の失敗・時間切れ・読めない応答は、その回を飛ばす (次の回に同じ範囲から読み直す)。
        if (startedGeneration === generation) cursorFor(chainId).missed = true;
      }
      if (startedGeneration !== generation) return;
    }
  } finally {
    running = false;
  }
}

/** QR を出した (または出し直した)。この会計を見張りに足す。同じ bill key をもう一度出したら、表示中に戻す。 */
export function showQrBill(input: QrBillInput): void {
  try {
    const known = bills.get(input.billKey);
    if (known) {
      known.hiddenAt = null;
    } else {
      const bill = readQrBill(input);
      // 見張れない QR (lib/qrSaleHistory.ts の readQrBill) は足さない = RPC を読まない。
      if (!bill) return;
      bills.set(input.billKey, { bill, hiddenAt: null, matched: 0 });
    }
    if (timer === null) {
      timer = setInterval(() => {
        // 見張りの失敗を、timer の外 (未処理の reject) へ出さない。
        tick().catch((error) => warnOnce('qrSale.watch_failed', error));
      }, QR_SALE_POLL_MS);
    }
  } catch (error) {
    // 会計の写しを読めない・timer を作れない失敗を、QR を出した画面の effect へ波及させない。
    warnOnce('qrSale.show_failed', error);
  }
}

/** QR の表示をやめた (閉じた・出し直した・タブを切り替えた)。この bill key は、あと 60 秒だけ持つ。 */
export function hideQrBill(billKey: string): void {
  const known = bills.get(billKey);
  if (known && known.hiddenAt === null) known.hiddenAt = Date.now();
}

/** /create を離れた。見張りを止めて、持っている bill key と会計の写しを全部捨てる。 */
export function stopQrSaleWatch(): void {
  generation += 1;
  clearState();
  // 警告は /create を開いている間に 1 回 (開き直したら、また 1 回は残す)。
  warned = false;
}
