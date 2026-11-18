'use client';

// お店の画面 (/create の決済QR・レジ) が QR を出している間と、閉じた後 60 秒、forwarder の `Settled` を RPC で読み、
// 会計ごとの印 (bill key) から計算し直した nonce とちょうど一致した入金だけを、この端末の取引履歴 (localStorage) に
// 1 行書く。通常決済の QR (mode=standard) の会計は、JPYC の `Transfer` とその tx の input の印で確かめる (下の
// 「通常決済の会計」)。server へは何も送らない。hooks/useQrBillKey.ts が dynamic import して使う (/create の初期の chunk に
// 入れない)。
//
// 見張りは、この module に 1 つ (画面の部品ではなく module が持つ): QR を閉じた後の 60 秒も、決済QR / レジのタブの
// 切り替えで部品が外れても続き、StrictMode の二重の effect でも 2 つにならない。/create を離れたら止める
// (stopQrSaleWatch)。出した bill key は、出し直しの分も含めて全部、表示をやめてから 60 秒まで memory に持つ
// (会計の写しと一緒・localStorage / sessionStorage には保存しない)。生きている bill key が無くなったら、読むのをやめる。
// 表示を始めた時刻・やめた時刻は、画面の側 (hooks/useQrBillKey.ts) がその瞬間に決めて渡す (この module の読み込みを
// 待った後の時刻にしない)。60 秒はその時刻から数え、届いた時点でもう 60 秒を過ぎていた会計は持たない。
//
// 読み方 (チェーンごと・6 秒おき):
//   - getBlockNumber → getLogs (forwarder の Settled・この受取先宛て)。範囲の終わりは「先頭 − 1 (Polygon は先頭 − 3)」。
//     始まりは、そのチェーンを初めて読む回と、新しい会計が加わった後の回は「先頭 − 90」(見張りの読み込みが遅れても、
//     表示を始めた後の入金を覆う。古すぎる log は下の時刻の窓で落ちる)。それ以外は「前回、照合し終えた block − 10」
//     (先頭 − 90 より前は読まない)。読む block が無ければ何もしない。
//   - getLogs の 1 回の範囲に制限のある RPC がある (Alchemy の無料枠は両端を含めて 10 block まで・11 block で HTTP 400)。
//     まず範囲を 1 回で読み、範囲の制限の error が返ったら、そのチェーンを「10 block ずつ」と覚えて (この画面にいる間)、
//     同じ回の中で同じ所から、古い方へ 10 block ずつ読み直す。以後そのチェーンは初めから 10 block ずつ。制限の無い RPC は
//     今までどおり 1 回で読む。分けて読む途中の 1 つが失敗したら (rate limit・時間切れ・ほかの error)、そこで読むのをやめ、
//     読めた所までを照合する (次の回は、読めた所の続きから = 読めていない範囲を飛ばさない)。getLogs は 1 回 (チェーン
//     ごと) に 10 回まで (範囲の制限を知る 1 回 + 90 block を 10 block ずつ 9 回 = 初めての回を 1 回で読み切れる数)。
//     重ね (前回 − 10) は、制限のあるチェーンでも小さくしない (普段の回の getLogs は 2 回になる)。
//   - 読んだ log (tx と log の番号) は覚えておき、重ねて読んだ分は落とす。
//   - タブが裏のあいだは読まない。RPC の失敗・時間切れは、その回を飛ばす (次の回に同じ範囲から読み直す)。
//   - 見つけた Settled ごとに、まず受取先・着金額・利用料が、生きている会計のどれかの期待値とちょうど同じかを見る
//     (lib/qrSaleHistory.ts の settledMatchesExpected)。どれとも違えば、block の時刻も読まず、nonce も計算しない。
//     同じ会計があれば block の時刻を読み、その時刻に生きていた (表示を始めてから、やめて 60 秒まで) 会計についてだけ
//     nonce を計算して比べる (matchSettledToBill)。判断は block の時刻で行う: RPC の読み取りが遅れただけの入金は落とさず、
//     やめて 60 秒より後に取り込まれた入金は、その会計の支払いにしない。端末の時計と block の時刻のずれは 30 秒まで許す。
//   - 計算の量 = 金額の合う log × 金額の合う会計 × 最大 1,230 回。同じ金額の会計をいくつも出したまま、同じ金額の関係ない
//     入金がいくつも届く順でも重くなりすぎないように、1 回 (チェーンごと) に照合する (log, 会計) の組は 4 つまでにして、
//     残りの log は次の回に回す (読んだことにしない)。1 回に最低 1 つの log は照合する (進まなくならない)。
//
// 通常決済の会計 (QR の URL の mode=standard・JPYC・lib/qrSaleHistory.ts の readQrStdBill):
//   - そのチェーンに通常決済の会計があれば、JPYC の deployment の `Transfer` (この受取先宛て = getLogs の topic の to で
//     絞る) も読む。読む位置は、チェーンと種類 (Settled・Transfer) ごとに持つ (始まり・重ね・先頭 − 90・10 block ずつ・
//     途中で失敗したら読めた所まで、は上と同じ)。片方の種類だけ読めた回は、読めた種類の位置だけを進める (読めなかった
//     種類は、次の回に同じ所から読み直す = 範囲を飛ばさない)。新しい会計が加わったら、その会計の種類の位置を消す。
//   - getLogs の回数の上限 (1 回・チェーンごとに 10 回) は種類を合わせた数。Settled が先に読み、Transfer は残りの回数で
//     読む (Transfer の側の読み取りは、ガスレスの会計の読む範囲を狭めない)。10 block ずつのチェーンで Settled が 10 回を
//     使い切った回は、Transfer はその回は読まず、次の回に (先頭 − 90 から・続きから) 読む。
//   - Settled と Transfer は 1 本の古い順 (block → log の番号) に混ぜて処理する (1 tx 1 行は、先に見た log の会計の行)。
//     次の回に回す (block の時刻・tx を読めない・上限) のは、その種類の、その log から後ろだけ。もう 1 つの種類は続ける
//     (通常決済の照合の失敗を、ガスレスの会計の照合へ波及させない・逆も同じ)。
//   - 見つけた Transfer ごとに、まず受取先・額が、生きている通常決済の会計のどれかの期待値とちょうど同じで、送り手が
//     forwarder でないかを見る (transferMatchesExpected)。どれとも違えば、block の時刻も tx も読まない。同じなら block の
//     時刻を読み、その時刻に生きていた会計があれば tx (getTransaction) を読み、input に会計の印が付いた transfer があるかを
//     見る (stdMarkCount: EOA が直接送った tx はちょうど同じ input・スマートアカウントは「transfer + 印」の並び)。
//   - tx を読めない (失敗・時間切れ・tx が無い・形の違う応答) Transfer は「読んだ」ことにせず、block の時刻と同じく、その
//     log から後ろ (Transfer) を次の回に回す。1 回 (チェーンごと) に読む tx は 4 つまで (超える log から後ろを次の回に回す)。
//     nonce の計算の組の上限 (4 つ) は Settled だけに数える。
//   - 印 1 つ (input の「transfer + 印」の並び 1 つ) を数えるのは Transfer 1 つまで。同じ tx に同じ額の Transfer が
//     2 つあり、印が別の 2 つの会計のものなら、それぞれの会計に 1 つずつ数える (行は tx ごとに 1 つ)。
//   - 受け入れている限界: 払う側が印を付けるまで (別の変更)、通常決済の入金は行にならない。ウォレットが calldata を
//     書き換えて印を落とすと行にならない。ERC-4337 の bundle で、同じお店・同じ額の 2 件が 1 つの tx に入ると 1 行。
//     中の呼び出しが失敗した UserOp の印は input に残るが、Transfer の log が無いので候補にならない。
//
// 行にするもの (log を 1 つずつ、必ず古い順 = block → log の番号の順に):
//   - その会計の 1 件目の一致 → 会計の写しの明細・管理番号つきの行。
//   - 同じ会計の 2 件目以降の一致 (同じ QR への 2 回目の入金) → 明細なしの行 (金額・お客様・tx)。
//   - 照合の上限・block の時刻の読み取りの失敗で次の回に回すのは、その log から後ろだけ。次の回は、照合し終えた所の
//     続きから読む。= 同じ会計への入金は、チェーンに取り込まれた順に 1 件目が決まる。受け入れている限界: 読み取りの都合
//     (RPC が古い node から空を返した、など) で、同じ会計への古い入金が新しい入金より後に見つかった場合、明細は先に
//     見つかった方に付く。
//   - 行は tx ごとに 1 つ (同じ tx の行・印があれば書かない)。受け入れている限界: 1 つの tx に、このお店の会計への
//     Settled が 2 つ以上ある場合 (OpenPay の relayer は 1 つの tx に settle を 1 つしか送らないので、第三者がまとめて
//     送ったときだけ)、行は最初に見つけた 1 つだけ。払った側の行も 1 tx 1 行。
//
// 保存の決まり (受注の書き手 lib/orderFeedHistoryRecorder.ts と同じ):
//   - 同じ tx の行が履歴にあれば書かない (txHash・大文字小文字を無視)。
//   - 印 (lib/qrSaleMarks.ts) を先に書けたときだけ行を書く。印は外さない。印 (自分の印と、受注の書き手の印) を読めない
//     端末では書かない。確かめるのは保存の直前 (block の時刻を待った後)。
//   - 受け入れている限界: 印を書いた後に履歴の保存が失敗した入金は、この端末の履歴に入らない。localStorage には、タブを
//     またいで読み書きの順を守らせる仕組みが無いので、別のタブが「読む → 書く」のあいだに割り込んだ結果は受け入れる
//     (既存の appendHistory・受注の書き手と同じ性質)。
//
// 画面への知らせ (行を書いた後だけ):
//   - この書き手が行を書き、その行が履歴にあると読み直せたときだけ、その会計を出した画面 (showQrBill に渡した受け手) に
//     bill key・何件目か・額を知らせる。行を書かなかった入金 (同じ tx の行・印が先にあった・保存の失敗) は知らせない。
//   - 何件目か = 上の「行にするもの」の数え方 (1 = 明細つきの行・2 以上 = 明細なしの行)。
//   - 額 = 書いた行の売上総額 (saleAmount = 着金額 + 利用料 = お客様が払った請求額 = QR の画面に出している金額)。
//   - 表示中か (閉じた後・出し直した後の会計か) は、受け手 (hooks/useQrBillKey.ts) が決める。ここは書いた行をそのまま知らせる。
//   - 知らせは書き込みの後に足しただけ: 行を書く条件・順・印・RPC の読み方は変えない。
//
// 付帯の処理 (掟 13): ここで起きた失敗 (RPC・計算・履歴と印の保存・画面への知らせ) は、QR の表示・残高の見張り・レジの操作へ
// 波及させない。外に出す関数は throw せず、何も返さない。

import { isAddress, isHex, type Address, type Hash } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { appendHistory, loadHistory, type HistoryEntry } from './history';
import { logger } from './logger';
import { isTxHashLike } from './orderRelay';
import {
  buildQrSaleEntry,
  buildQrStdSaleEntry,
  matchSettledToBill,
  readQrBill,
  readQrStdBill,
  readSettledLog,
  readTransferLog,
  settledMatchesExpected,
  stdMarkCount,
  transferMatchesExpected,
  type QrBill,
  type QrBillInput,
  type QrStdBill,
  type SettledLog,
  type StdTx,
  type TransferLog,
} from './qrSaleHistory';
import { addQrSaleMark, ORDER_FEED_MARKS_KEY, QR_SALE_MARKS_KEY, readTxMarks } from './qrSaleMarks';
import {
  QR_SALE_RPC_TIMEOUT_MS,
  readBlockTime,
  readChainHead,
  readSettledLogs,
  readTransaction,
  readTransferLogs,
  type QrSaleLog,
} from './qrSaleRpc';

/** 読む間隔。 */
export const QR_SALE_POLL_MS = 6_000;
/** QR の表示をやめてから、その bill key を持っておく時間。 */
export const QR_SALE_KEEP_AFTER_HIDE_MS = 60_000;
/** 前回読んだ最後の block から、重ねて読み直す block の数。 */
export const QR_SALE_OVERLAP_BLOCKS = 10n;
/** 先頭から、これより前の block は読まない (間が空いたとき)。 */
export const QR_SALE_MAX_BACK_BLOCKS = 90n;
/** 端末の時計と block の時刻のずれを、ここまで許す (会計が生きていた間に取り込まれたかを見るとき)。 */
export const QR_SALE_CLOCK_SKEW_MS = 30_000;
/**
 * 1 回 (チェーンごと) に照合する (log, 会計) の組の数の上限。組 1 つは最大 1,230 回の nonce の計算 (手元の Mac で約 19 ms)。
 * 超える log は次の回に回す。1 回に最低 1 つの log は照合する。
 */
export const QR_SALE_MAX_PAIRS_PER_PASS = 4;
/** getLogs の範囲に制限のある RPC で、1 回に読む block の数 (両端を含む・Alchemy の無料枠の上限)。 */
export const QR_SALE_SMALL_RANGE_BLOCKS = 10n;
/** 1 回 (チェーンごと) の getLogs の回数の上限 (範囲の制限を知る 1 回 + 90 block を 10 block ずつ 9 回)。 */
export const QR_SALE_MAX_GETLOGS_PER_PASS = 10;
/**
 * 1 回 (チェーンごと) に読む tx (getTransaction) の数の上限 (通常決済の会計の照合)。超える Transfer は次の回に回す。
 * 1 回に最低 1 つは読む (上限が 1 以上)。
 */
export const QR_SALE_MAX_TX_READS_PER_PASS = 4;

// getLogs の「1 回の範囲が広すぎる」の error か (RPC の提供者ごとに文面が違うので、部分一致)。範囲を小さくすれば通る
// error だけを拾う。rate limit を先に見て外す (時間を置けば同じ範囲が通る・範囲を小さくしても通らない)。JSON-RPC の
// code -32005 は rate limit と「結果が多すぎる」の両方に使われるので、code では決めない。
// (lib/crossChain/burnMarker.ts の isRangeError と同じ考え方。あの module は import しない = この遅延 chunk に閉じる)
const RANGE_LIMIT_PATTERNS = [
  // Alchemy の無料枠: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. …"
  'block range',
  // QuickNode: "eth_getLogs is limited to a 10,000 blocks range"
  'blocks range',
  'range is too large',
  'range too large',
  'too many blocks',
  'exceed maximum block range',
  // Infura など: "query returned more than 10000 results"
  'query returned more than',
];
const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate-limit',
  'too many requests',
  'compute units',
  'request limit reached',
  'throttled',
  'over quota',
];

export function isBlockRangeLimitError(error: unknown): boolean {
  const texts: string[] = [];
  let status429 = false;
  // viem の error は provider の生の文面を details・shortMessage・metaMessages・cause に分けて持つ。
  const visit = (e: unknown, depth: number): void => {
    if (depth > 4 || e === null || typeof e !== 'object') return;
    const rec = e as { message?: unknown; details?: unknown; shortMessage?: unknown; status?: unknown; cause?: unknown };
    for (const v of [rec.message, rec.details, rec.shortMessage]) if (typeof v === 'string') texts.push(v.toLowerCase());
    if (rec.status === 429) status429 = true;
    visit(rec.cause, depth + 1);
  };
  visit(error, 0);
  const text = texts.join(' | ');
  if (status429 || RATE_LIMIT_PATTERNS.some((p) => text.includes(p))) return false;
  return RANGE_LIMIT_PATTERNS.some((p) => text.includes(p));
}

// 先頭から何 block 手前までを読むか (取り込まれたばかりの block を読まない)。Polygon は 3・ほかは 1。
const HEAD_MARGIN_BLOCKS: Record<number, bigint> = { [polygon.id]: 3n, [polygonAmoy.id]: 3n };
const headMargin = (chainId: number) => HEAD_MARGIN_BLOCKS[chainId] ?? 1n;

/** 見張りがこの会計の入金を取引履歴に書いた (画面への知らせ・頭の注記の「画面への知らせ」)。 */
export type QrBillRecorded = {
  billKey: string;
  /** この会計に一致した入金の何件目か (1 = 1 件目 = 明細つきの行・2 以上 = 同じ会計への 2 件目以降 = 明細なしの行)。 */
  count: number;
  /** 書いた行の売上総額 (saleAmount・wei の 10 進文字列) = お客様が払った請求額 = QR の画面に出している金額。 */
  amount: string;
};
export type QrBillRecordedListener = (event: QrBillRecorded) => void;

type WatchedBase = {
  /** 表示を始めた時刻 (ms・画面の側が決めた値)。 */
  shownAt: number;
  /** 表示をやめた時刻 (ms・画面の側が決めた値・表示中は null)。 */
  hiddenAt: number | null;
  /** この会計に一致した入金 (Settled・印の付いた Transfer) の数。 */
  matched: number;
  /** 行を書いたときに知らせる受け手 (この会計を出した画面・無ければ知らせない)。 */
  onRecorded: QrBillRecordedListener | null;
};
/** ガスレスの会計 (forwarder の Settled で確かめる)。 */
type WatchedSettled = WatchedBase & { rail: 'settled'; bill: QrBill };
/** 通常決済の会計 (JPYC の Transfer と tx の input の印で確かめる)。 */
type WatchedTransfer = WatchedBase & { rail: 'transfer'; bill: QrStdBill };
type WatchedBill = WatchedSettled | WatchedTransfer;
/** 読む log の種類 (ガスレスの会計の Settled・通常決済の会計の Transfer)。会計の rail と同じ値。 */
type LogKind = WatchedBill['rail'];
type ChainCursor = {
  /** 前回、照合し終えた最後の block (null = 次の回は先頭 − 90 から読む: 初めての回・新しい会計が加わった後)。 */
  lastTo: bigint | null;
};

const bills = new Map<string, WatchedBill>();
// 読む位置は、チェーンと log の種類ごと (`チェーン:種類`)。
const cursors = new Map<string, ChainCursor>();
const seenLogs = new Set<string>();
const blockTimes = new Map<string, bigint>();
// 読めた tx (`チェーン:tx`)。同じ tx の 2 つ目の Transfer で読み直さない。
const txs = new Map<string, StdTx>();
// 会計ごとに、1 つの tx の印を何回数えたか (`チェーン:tx:bill key`)。印 1 つ (transfer + 印 の並び 1 つ) を数えるのは
// Transfer 1 つまで (同じ tx に、同じ額の別の会計への Transfer がもう 1 つあっても、同じ印で 2 回数えない)。
const txMarkUses = new Map<string, number>();
// getLogs の範囲に制限のある RPC と分かったチェーン (10 block ずつ読む)。/create を離れるまで持つ (会計が無くなって
// 読むのをやめた間も、同じ画面の RPC は変わらない = もう一度 1 回で読もうとして失敗しない)。
const smallRangeChains = new Set<number>();
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
  txs.clear();
  txMarkUses.clear();
}

const cursorKey = (chainId: number, kind: LogKind) => `${chainId}:${kind}`;

function cursorFor(chainId: number, kind: LogKind): ChainCursor {
  const key = cursorKey(chainId, kind);
  let cursor = cursors.get(key);
  if (!cursor) {
    cursor = { lastTo: null };
    cursors.set(key, cursor);
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

// 通常決済の会計の照合に使う tx (送り手・宛先・input)。読めない (RPC の失敗・時間切れ・tx が無い) ときは throw する
// (呼ぶ側は、その Transfer を「読んだ」ことにせず、次の回に読み直す)。形の違う応答も読めないものとして扱う: 壊れた応答を
// 「印の無い tx」として読んだことにすると、その入金を二度と照合しない (落とす) ため。
async function txOf(chainId: number, hash: string): Promise<StdTx> {
  const key = `${chainId}:${hash.toLowerCase()}`;
  const known = txs.get(key);
  if (known) return known;
  const tx = await withDeadline(readTransaction(chainId, hash as Hash));
  const readable =
    typeof tx?.from === 'string' &&
    isAddress(tx.from, { strict: false }) &&
    (tx.to === null || (typeof tx.to === 'string' && isAddress(tx.to, { strict: false }))) &&
    typeof tx.input === 'string' &&
    isHex(tx.input);
  if (!readable) throw new Error('qr_sale_tx_unreadable');
  const read: StdTx = { from: tx.from, to: tx.to, input: tx.input };
  txs.set(key, read);
  return read;
}

function historyHasTx(hash: string): boolean {
  return loadHistory().some((e) => e.txHash?.toLowerCase() === hash);
}

// この会計が、block の時刻 (unix 秒) に生きていたか (表示を始めてから、表示をやめて 60 秒まで・時計のずれは 30 秒まで許す)。
function aliveAt(w: WatchedBill, blockTime: bigint): boolean {
  const at = Number(blockTime) * 1000;
  if (at < w.shownAt - QR_SALE_CLOCK_SKEW_MS) return false;
  return w.hiddenAt === null || at <= w.hiddenAt + QR_SALE_KEEP_AFTER_HIDE_MS + QR_SALE_CLOCK_SKEW_MS;
}

// このチェーンのガスレスの会計で、受取先・着金額・利用料がこの Settled とちょうど同じもの (nonce を探す前のふるい)。
function billsFitting(chainId: number, settled: SettledLog): WatchedSettled[] {
  return [...bills.values()].filter(
    (w): w is WatchedSettled =>
      w.rail === 'settled' && w.bill.chainId === chainId && settledMatchesExpected(settled, w.bill),
  );
}

// このチェーンの通常決済の会計で、受取先・額がこの Transfer とちょうど同じで、送り手が forwarder でないもの (tx を読む前のふるい)。
function stdBillsFitting(chainId: number, transfer: TransferLog): WatchedTransfer[] {
  return [...bills.values()].filter(
    (w): w is WatchedTransfer =>
      w.rail === 'transfer' && w.bill.chainId === chainId && transferMatchesExpected(transfer, w.bill),
  );
}

// 保存の直前の確認 → 印 → 行 (頭の注記の「保存の決まり」)。true = この書き手が行を書き、その行が履歴にある (画面に知らせる)。
function save(bill: QrBill, settled: SettledLog, txHash: string, blockTime: bigint, withDetail: boolean): boolean {
  return saveRow(txHash, () => buildQrSaleEntry(bill, settled, txHash, blockTime, withDetail));
}

// 保存の決まりの本体 (ガスレスの行と通常決済の行で同じ)。build = 書く行 (印を書けた後にだけ組む)。
function saveRow(txHash: string, build: () => HistoryEntry): boolean {
  const hash = txHash.toLowerCase();
  const own = readTxMarks(QR_SALE_MARKS_KEY);
  const feed = readTxMarks(ORDER_FEED_MARKS_KEY);
  // 印を読めない端末では書かない (消した行を書き戻さない側に倒す)。
  if (!own || !feed) return false;
  // 前に書いた tx (この書き手か、受注の書き手が書いて、店主が履歴から消した行を含む)。書き戻さない。
  if (own.has(hash) || feed.has(hash)) return false;
  // 同じ tx の行がもうある (払った側の画面・お店の端末で送る・受注の書き手が書いた)。その行にも印を付ける。
  if (historyHasTx(hash)) {
    addQrSaleMark(hash);
    return false;
  }
  // 先に印を書く。書けなければ行を書かない (この書き手が書いた行には、必ず印がある)。
  if (!addQrSaleMark(hash)) return false;
  appendHistory(build());
  // appendHistory は localStorage の書き込みの失敗 (容量の上限など) を握りつぶして返る。画面に「取引履歴に記録しました」と
  // 出すのは、行が履歴にあると読み直せたときだけ (書けていない行を「記録した」と言う偽の成功を断つ・掟 13)。
  return historyHasTx(hash);
}

// 書いた行を、その会計を出した画面に知らせる (頭の注記の「画面への知らせ」)。受け手の失敗 (画面の側の throw) を、
// 残りの入金の記録と見張りの回へ波及させない (掟 13)。行はもう書いてあり、知らせられなくても履歴は変わらない。
// amount = 書いた行の saleAmount と同じ値。
function notifyRecorded(w: WatchedBill, amount: bigint): void {
  if (!w.onRecorded) return;
  try {
    w.onRecorded({
      billKey: w.bill.billKey,
      count: w.matched,
      amount: amount.toString(),
    });
  } catch (error) {
    warnOnce('qrSale.notify_failed', error);
  }
}

/** 読む log の種類と、その log を出す contract と、getLogs の読み方。 */
type LogSource =
  | { kind: 'settled'; forwarder: Address; read: (from: bigint, to: bigint) => Promise<QrSaleLog[]> }
  | { kind: 'transfer'; token: Address; read: (from: bigint, to: bigint) => Promise<QrSaleLog[]> };

/** 1 つの種類の、この回に読めた範囲と log。stoppedAt = 次の回に回した最初の log の block (null = 全部を照合し終えた)。 */
type LogStream = {
  source: LogSource;
  cursor: ChainCursor;
  readTo: bigint;
  logs: QrSaleLog[];
  stoppedAt: bigint | null;
};

/**
 * 1 つの種類の log を、その種類の位置の続きから古い方へ読む (頭の注記の「getLogs の 1 回の範囲に制限のある RPC」)。
 * budget = この回 (チェーンごと) に使った getLogs の回数 (種類を合わせて QR_SALE_MAX_GETLOGS_PER_PASS まで・この関数が
 * 書き足す)。null = この種類は読む block が無い・1 つも読めなかった (位置を変えない = 次の回に同じ範囲から読み直す)。
 * 'stale' = 待つ間に止められた。
 */
async function readStream(
  chainId: number,
  source: LogSource,
  cursor: ChainCursor,
  toBlock: bigint,
  oldest: bigint,
  budget: { calls: number },
  startedGeneration: number,
): Promise<LogStream | null | 'stale'> {
  // 初めての回・新しい会計が加わった後の回は先頭 − 90 から。それ以外は、照合し終えた所の続き − 10 から (先頭 − 90 まで)。
  const next = cursor.lastTo === null ? oldest : cursor.lastTo - QR_SALE_OVERLAP_BLOCKS;
  let fromBlock = next > oldest ? next : oldest;
  if (fromBlock < 0n) fromBlock = 0n;
  if (toBlock < fromBlock) return null;

  // readTo = 読めた最後の block。
  const logs: QrSaleLog[] = [];
  let readTo = fromBlock - 1n;
  while (readTo < toBlock && budget.calls < QR_SALE_MAX_GETLOGS_PER_PASS) {
    budget.calls += 1;
    const from = readTo + 1n;
    const small = smallRangeChains.has(chainId);
    const end = from + QR_SALE_SMALL_RANGE_BLOCKS - 1n;
    const to = small && end < toBlock ? end : toBlock;
    let part: QrSaleLog[];
    try {
      part = await withDeadline(source.read(from, to));
    } catch (error) {
      if (startedGeneration !== generation) return 'stale';
      // 範囲の制限: このチェーンは以後 10 block ずつ。同じ回の中で、同じ所から読み直す。
      if (!small && isBlockRangeLimitError(error)) {
        smallRangeChains.add(chainId);
        continue;
      }
      // rate limit・時間切れ・ほかの error: ここで読むのをやめ、読めた所までを照合する。
      break;
    }
    if (startedGeneration !== generation) return 'stale';
    logs.push(...part);
    readTo = to;
  }
  // 1 つも読めなかった (前回の位置を変えない = 次の回に同じ範囲から読み直す)。
  if (readTo < fromBlock) return null;
  return { source, cursor, readTo, logs, stoppedAt: null };
}

/**
 * 通常決済の Transfer 1 つを照合する (頭の注記の「通常決済の会計」)。'done' = 照合し終えた (読んだ log にした)・
 * 'defer' = この log から後ろを次の回に回す (block の時刻・tx を読めない・tx の数の上限)・'stale' = 待つ間に止められた。
 * reads = この回に読んだ tx の数 (この関数が書き足す)。
 */
async function checkTransfer(
  chainId: number,
  token: Address,
  log: QrSaleLog,
  txHash: string,
  blockNumber: bigint,
  id: string,
  reads: { count: number },
  startedGeneration: number,
): Promise<'done' | 'defer' | 'stale'> {
  const transfer = readTransferLog(log, token);
  // 受取先・額・送り手が、どの通常決済の会計の期待値とも違う log は照合しない (block の時刻も tx も読まない)。
  if (!transfer || stdBillsFitting(chainId, transfer).length === 0) {
    seenLogs.add(id);
    return 'done';
  }
  let blockTime: bigint;
  try {
    blockTime = await blockTimeOf(chainId, blockNumber);
  } catch {
    // block の時刻を読めなかった log は「読んだ」ことにしない (ガスレスと同じ)。
    return 'defer';
  }
  if (startedGeneration !== generation) return 'stale';
  // その block の時刻に生きていた会計が無ければ、tx を読まない。
  if (!stdBillsFitting(chainId, transfer).some((w) => aliveAt(w, blockTime))) {
    seenLogs.add(id);
    return 'done';
  }
  let tx = txs.get(`${chainId}:${txHash.toLowerCase()}`);
  if (!tx) {
    // tx の数の上限 (頭の注記)。超えたら、この log から後ろを次の回に回す。上限は 1 以上 = 1 回に最低 1 つは読む。
    if (reads.count >= QR_SALE_MAX_TX_READS_PER_PASS) return 'defer';
    reads.count += 1;
    try {
      tx = await txOf(chainId, txHash);
    } catch {
      // tx を読めなかった (失敗・時間切れ・無い・形の違う応答) Transfer は「読んだ」ことにしない (block の時刻と同じ)。
      if (startedGeneration !== generation) return 'stale';
      return 'defer';
    }
    if (startedGeneration !== generation) return 'stale';
  }
  // 待つ間に増えた・表示をやめた会計も入れて選び直す。その block の時刻に生きていた会計だけ。
  const candidates = stdBillsFitting(chainId, transfer).filter((w) => aliveAt(w, blockTime));
  seenLogs.add(id);
  for (const w of candidates) {
    // この会計の印の付いた transfer が、この tx の input にいくつあるか。そのうち、まだ別の Transfer に数えていない分だけ使う。
    const key = `${chainId}:${txHash.toLowerCase()}:${w.bill.billKey}`;
    const used = txMarkUses.get(key) ?? 0;
    if (stdMarkCount(tx, transfer, w.bill) <= used) continue;
    txMarkUses.set(key, used + 1);
    // 明細を付けるのは、その会計の 1 件目の一致だけ (ガスレスと同じ)。
    const withDetail = w.matched === 0;
    w.matched += 1;
    let recorded = false;
    try {
      recorded = saveRow(txHash, () => buildQrStdSaleEntry(w.bill, transfer, txHash, blockNumber, blockTime, withDetail));
    } catch (error) {
      // 1 件の保存の失敗 (履歴の読み書き・行の組み立て) を、残りの入金の記録へ波及させない (ガスレスと同じ)。
      warnOnce('qrSale.save_failed', error);
    }
    // 額は書いた行の saleAmount (lib/qrSaleHistory.ts の buildQrStdSaleEntry: 請求額)。
    if (recorded) notifyRecorded(w, w.bill.expected.saleAmount);
    // 1 つの Transfer に一致する会計は 1 つまで。
    break;
  }
  return 'done';
}

async function pollChain(chainId: number, startedGeneration: number): Promise<void> {
  const watched = [...bills.values()].filter((w) => w.bill.chainId === chainId);
  const settledBills = watched.filter((w): w is WatchedSettled => w.rail === 'settled');
  const transferBills = watched.filter((w): w is WatchedTransfer => w.rail === 'transfer');
  // 読む log の種類 (このチェーンにある会計の分だけ)。ガスレスの会計の Settled を先に読む (下の getLogs の回数)。
  const sources: LogSource[] = [];
  if (settledBills.length > 0) {
    // 同じチェーンのガスレスの会計は、同じ forwarder (lib/relay/forwarderConfig の jpycForwarderFor)。
    const forwarder = settledBills[0].bill.forwarder;
    const merchants = [...new Set(settledBills.map((w) => w.bill.merchant))];
    sources.push({
      kind: 'settled',
      forwarder,
      read: (from, to) => readSettledLogs(chainId, forwarder, merchants, from, to),
    });
  }
  if (transferBills.length > 0) {
    // 同じチェーンの通常決済の会計は、同じ JPYC の deployment。
    const token = transferBills[0].bill.deployment.address;
    const merchants = [...new Set(transferBills.map((w) => w.bill.merchant))];
    sources.push({ kind: 'transfer', token, read: (from, to) => readTransferLogs(chainId, token, merchants, from, to) });
  }
  // 位置は先頭を読む前に持つ (読んでいる間に新しい会計が加わって位置が消されたら、この回はその前の位置に書く = 次の回は
  // 先頭 − 90 から読み直す)。
  const positions = sources.map((source) => ({ source, cursor: cursorFor(chainId, source.kind) }));

  const head = await withDeadline(readChainHead(chainId));
  if (startedGeneration !== generation) return;
  if (typeof head !== 'bigint') throw new Error('qr_sale_head_unreadable');
  const toBlock = head - headMargin(chainId);
  const oldest = head - QR_SALE_MAX_BACK_BLOCKS;

  // 種類ごとに、その種類の位置の続きから読む。getLogs の回数は種類を合わせて 1 回に 10 回まで: Settled が先に使い、
  // Transfer は残りで読む (Transfer の側の読み取りが、ガスレスの会計の読む範囲を狭めない)。読めなかった種類は、その種類の
  // 位置を変えない (片方だけ読めた回に、もう片方の範囲を飛ばさない)。
  const budget = { calls: 0 };
  const streams: LogStream[] = [];
  for (const { source, cursor } of positions) {
    const stream = await readStream(chainId, source, cursor, toBlock, oldest, budget, startedGeneration);
    if (stream === 'stale') return;
    if (stream) streams.push(stream);
  }
  // どの種類も読めなかった回は飛ばす。
  if (streams.length === 0) return;
  // チェーンの順 (block → log の番号) に見る (同じ会計への 1 件目・2 件目の順)。Settled と Transfer は 1 本の順に混ぜる。
  // 番号の無い log (取り込み前) は読まない。
  const ordered = streams
    .flatMap((stream) =>
      stream.logs.flatMap((log) =>
        isTxHashLike(log.transactionHash) && typeof log.logIndex === 'number' && typeof log.blockNumber === 'bigint'
          ? [{ stream, log, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber }]
          : [],
      ),
    )
    .sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );

  // この回に照合した (Settled の log, 会計) の組の数 (上限 QR_SALE_MAX_PAIRS_PER_PASS)。
  let pairs = 0;
  // この回に読んだ tx の数 (上限 QR_SALE_MAX_TX_READS_PER_PASS)。
  const txReads = { count: 0 };
  for (const { stream, log, txHash, logIndex, blockNumber } of ordered) {
    // この種類は、前の log から後ろを次の回に回した (古い log を飛ばして新しい log を先に照合しない)。もう 1 つの種類は
    // 続ける (Transfer の側の読み取りの失敗を、ガスレスの会計の照合へ波及させない・逆も同じ)。
    if (stream.stoppedAt !== null) continue;
    const id = `${chainId}:${txHash.toLowerCase()}:${logIndex}`;
    if (seenLogs.has(id)) continue;
    const { source } = stream;
    if (source.kind === 'transfer') {
      const step = await checkTransfer(chainId, source.token, log, txHash, blockNumber, id, txReads, startedGeneration);
      if (step === 'stale') return;
      // ここまでの分は書き、この log から後ろ (Transfer) は次の回に回す。
      if (step === 'defer') stream.stoppedAt = blockNumber;
      continue;
    }
    const settled = readSettledLog(log, source.forwarder);
    // 受取先・金額が、どの会計の期待値とも違う log は照合しない (block の時刻も読まない・nonce も計算しない)。
    if (!settled || billsFitting(chainId, settled).length === 0) {
      seenLogs.add(id);
      continue;
    }
    let blockTime: bigint;
    try {
      blockTime = await blockTimeOf(chainId, blockNumber);
    } catch {
      // block の時刻を読めなかった log は「読んだ」ことにしない。ここまでの分は書き、この log から後ろは次の回に回す。
      stream.stoppedAt = blockNumber;
      continue;
    }
    if (startedGeneration !== generation) return;
    // 待つ間に増えた・表示をやめた会計も入れて選び直す。その block の時刻に生きていた会計だけ。
    const candidates = billsFitting(chainId, settled).filter((w) => aliveAt(w, blockTime));
    // 照合の量の上限 (頭の注記)。超えたら、この log から後ろを次の回に回す (古い log を飛ばして新しい log を先に
    // 照合しない)。この回の最初の log は必ず照合する。
    if (pairs > 0 && pairs + candidates.length > QR_SALE_MAX_PAIRS_PER_PASS) {
      stream.stoppedAt = blockNumber;
      continue;
    }
    pairs += candidates.length;
    seenLogs.add(id);
    for (const w of candidates) {
      if (matchSettledToBill(settled, blockTime, w.bill) === null) continue;
      // 明細を付けるのは、その会計の 1 件目の一致だけ (2 件目以降 = 同じ会計への 2 回目の入金)。
      const withDetail = w.matched === 0;
      w.matched += 1;
      let recorded = false;
      try {
        recorded = save(w.bill, settled, txHash, blockTime, withDetail);
      } catch (error) {
        // 1 件の保存の失敗 (履歴の読み書き・行の組み立て) を、残りの入金の記録へ波及させない。
        warnOnce('qrSale.save_failed', error);
      }
      // 額は書いた行の saleAmount と同じ式 (lib/qrSaleHistory.ts の buildQrSaleEntry: 着金額 + 利用料)。
      if (recorded) notifyRecorded(w, settled.merchantValue + settled.feeValue);
      // bill key は会計ごとに違う乱数なので、1 つの Settled が一致する会計は多くても 1 つ。
      break;
    }
  }
  // 次の回は、種類ごとに、照合し終えた所の続きから (読めた所まで・回した log の block から読み直す)。
  for (const stream of streams) {
    stream.cursor.lastTo = stream.stoppedAt === null ? stream.readTo : stream.stoppedAt - 1n;
  }
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
  if (document.visibilityState === 'hidden') return;
  running = true;
  const startedGeneration = generation;
  try {
    for (const chainId of chainIds) {
      try {
        await pollChain(chainId, startedGeneration);
      } catch {
        // RPC の失敗・時間切れ・読めない応答は、その回を飛ばす (前回の位置を変えない = 次の回に同じ範囲から読み直す)。
      }
      if (startedGeneration !== generation) return;
    }
  } finally {
    running = false;
  }
}

/**
 * QR を出した (または出し直した)。この会計を見張りに足す。同じ bill key をもう一度出したら、表示中に戻す。
 * shownAt = 表示を始めた時刻 (画面の側が、始めた瞬間に決めた値)。onRecorded = この会計の行を書いたときの受け手
 * (同じ bill key を出し直したら、新しい受け手に替える)。
 */
export function showQrBill(input: QrBillInput, shownAt: number, onRecorded?: QrBillRecordedListener): void {
  try {
    const known = bills.get(input.billKey);
    if (known) {
      known.hiddenAt = null;
      known.onRecorded = onRecorded ?? null;
    } else {
      // ガスレスの会計 (readQrBill) か、通常決済の会計 (readQrStdBill・URL の mode=standard)。2 つは mode で分かれる。
      const settledBill = readQrBill(input);
      const stdBill = settledBill ? null : readQrStdBill(input);
      const base = { shownAt, hiddenAt: null, matched: 0, onRecorded: onRecorded ?? null };
      const watched: WatchedBill | null = settledBill
        ? { ...base, rail: 'settled', bill: settledBill }
        : stdBill
          ? { ...base, rail: 'transfer', bill: stdBill }
          : null;
      // 見張れない QR (lib/qrSaleHistory.ts の readQrBill・readQrStdBill) は足さない = RPC を読まない。
      if (!watched) return;
      bills.set(input.billKey, watched);
      // 新しい会計が加わった: そのチェーンの次の回は先頭 − 90 から読み直す (表示を始めた後の入金を覆う・読んだ log は落とす)。
      // 位置を消す (null にしない): 読んでいる途中の回が、終わった後に古い位置を書き戻さないように、別の物にする。
      cursors.delete(cursorKey(watched.bill.chainId, watched.rail));
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

/**
 * QR の表示をやめた (閉じた・出し直した・タブを切り替えた)。hiddenAt = やめた時刻 (画面の側が、やめた瞬間に決めた値)。
 * この bill key は、その時刻から 60 秒だけ持つ。
 */
export function hideQrBill(billKey: string, hiddenAt: number): void {
  const known = bills.get(billKey);
  if (!known || known.hiddenAt !== null) return;
  known.hiddenAt = hiddenAt;
  // この module の読み込みが遅く、やめてから 60 秒を過ぎて届いた (show と続けて届く): その会計は持たない。
  if (Date.now() - hiddenAt > QR_SALE_KEEP_AFTER_HIDE_MS) bills.delete(billKey);
}

/** /create を離れた。見張りを止めて、持っている bill key と会計の写しを全部捨てる。 */
export function stopQrSaleWatch(): void {
  generation += 1;
  clearState();
  smallRangeChains.clear();
  // 警告は /create を開いている間に 1 回 (開き直したら、また 1 回は残す)。
  warned = false;
}
