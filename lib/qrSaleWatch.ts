'use client';

// お店の画面 (/create の決済QR・レジ) が QR を出している間と、閉じた後 60 秒、forwarder の `Settled` を RPC で読み、
// 会計ごとの印 (bill key) から計算し直した nonce とちょうど一致した入金だけを、この端末の取引履歴 (localStorage) に
// 1 行書く。通常決済の QR (mode=standard) の会計は、JPYC の `Transfer` とその tx の input の印で確かめる (下の
// 「通常決済の会計」)。ガスレスの QR を、払う側で通常決済に切り替えて払った入金も、`Transfer` と印で確かめる (下の
// 「ガスレスの会計の、切り替えた入金」)。server へは何も送らない。hooks/useQrBillKey.ts が dynamic import して使う
// (/create の初期の chunk に入れない)。
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
// ガスレスの会計の、切り替えた入金 (ガスレスの QR を、払う側の画面で通常決済に切り替えて払った入金):
//   - ガスレスで払えないウォレット (ERC-4337 のマイナウォレットなど) は、ガスレスの QR を読んで、払う側で通常決済に切り替えて
//     払う。払う側は、その送金にも同じ bill key の印を付ける (transfer(受取先, 額) + 印)。forwarder は通らないので Settled は
//     出ない。そこでガスレスの会計には、Settled の期待値 (回収の後の着金額・利用料) とは別に、同じ URL・同じ bill key から
//     作った通常決済の期待値 (額 = calcBreakdown の standard の着金額 = 今は請求額そのもの・印 = billKeyStdMark) も持たせる
//     (lib/qrSaleHistory.ts の readQrSwitchedStdBill)。例: 請求 1,000 JPYC・回収 2 JPYC の会計は、Settled なら着金 998 +
//     利用料 2、切り替えた後の Transfer なら 1,000 (回収の後の額 998 の Transfer・通常決済の額 1,000 の Settled は一致しない)。
//   - これは、今までの回の後ろに足すだけの、できる範囲の読み取り (ベストエフォート)。約束は 4 つ:
//     (1) Settled と通常決済の会計の記録は、今までと同じ時機・同じ結果。1 回 (tick) は、まず全チェーンの今までの回 (上の読み方・
//         照合・保存・位置) を終え、その後で、チェーンごとに切り替えた入金を読む (回は今までどおり 1 つずつ・並行には走らせない)。
//     (2) 切り替えた入金が行を書くのは、その tx の block が、同じ回に Settled がその受取先を読んで照合し終えた範囲 (始まりと
//         終わりの両方) の中にあり、その会計が回の始まりにあったときだけ。= 同じ tx を、同じ会計の Settled と Transfer の両方が
//         拾ったら、必ず Settled が先に数えて、行はガスレスの行 (同じ tx の Transfer は数えず、tx も読まない)。
//     (3) 1 つの tx を同じ会計に数えるのは 1 回 (会計ごとに、数えた tx を覚える)。Settled が数えた tx は、切り替えた入金では
//         数えない。切り替えた入金が先に数えた tx (RPC がその block の Settled を欠いて返した回の後) に Settled が届いても、
//         件数は増やさない (保存は今までどおり試みる: その tx の行・印があれば書かない)。
//     (4) 切り替えた入金の読み取りの失敗は、共有の状態 (Settled と通常決済の会計の位置・読んだ log の覚え・10 block ずつ読む
//         チェーンの覚え) を変えない。その回の切り替えた入金をやめるだけ。
//   - 読むもの: JPYC の `Transfer` (lib/qrSaleRpc.ts の readSwitchedTransferLogs) を、その回の始まりにあったガスレスの会計の
//     受取先について、その回の Settled が照合し終えた範囲と同じ範囲だけ。位置は持たない (Settled が重ねて読む範囲は、ここでも
//     毎回読み直す。数えた tx は (3) で二重にならない)。Settled を読めなかった回・Settled が読み飛ばした範囲 (間が空いた後の
//     先頭 − 90 より前など) は、ここでも読まない。
//   - 枠: getLogs の回数 (1 回・チェーンごとに 10 回) は 3 種類を合わせた数で、ここは最後に残りで読む。新しい block から古い方へ
//     読み、枠が尽きたら残りは読まない。tx の読み取りは、通常決済の会計の照合と合わせて 1 回 4 つまで。
//   - 確かめ方は「通常決済の会計」と同じ (受取先・額・送り手が forwarder でない → block の時刻に会計が生きていた → tx の
//     input の印・stdCallsExceedTransfers)。額だけの一致では書かない。行は通常決済の行 (buildQrStdSaleEntry)。件数 (何件目か)・
//     明細 (1 件目だけ)・知らせは、Settled の入金と合わせて 1 つの数。
//   - 増える RPC: ガスレスの会計のあるチェーンで、表示中 (と閉じた後 60 秒) は 6 秒ごとに getLogs が 1 回 (10 block ずつの
//     チェーンは普段 2 回)。block の時刻・tx を読むのは、受取先・額の合う Transfer が届いたときだけ。
//   - 受け入れている限界 (行が出ないだけ = 今までと同じ): 枠が足りない回 (10 block ずつのチェーンで、Settled が先頭 − 90 から
//     読み直す回は、新しい 10 block だけ)・RPC の失敗・block の時刻や tx を読めないまま Settled の重ねの範囲を過ぎた入金・
//     Settled が読み飛ばした範囲・回の途中で加わった会計の最初の回では、切り替えた入金は行にならない。同じ回に見つかった
//     Settled の入金と切り替えた入金は、チェーンの順に関わらず Settled が先 (同じ会計なら Settled が 1 件目 = 明細つき)。
//     RPC がその block の Settled を欠いて返した tx は、切り替えた入金の行 (通常決済の行) になりうる。ガスレスの会計に
//     ならない QR (forwarder の無いチェーン・回収の額を引くと着金額が残らない額) は、今までどおり見張らない。
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
//   - 受け入れている限界: 印を書いた後に履歴の保存が失敗した入金は、この端末の履歴に入らない (自動では書き直さない。
//     その会計の QR を出した画面に、書けなかったかもしれないことを知らせる = 下の「画面への知らせ」)。localStorage には、タブを
//     またいで読み書きの順を守らせる仕組みが無いので、別のタブが「読む → 書く」のあいだに割り込んだ結果は受け入れる
//     (既存の appendHistory・受注の書き手と同じ性質)。
//
// 画面への知らせ (行を書きにいった入金だけ):
//   - この書き手が行を書き、その行が履歴にあると読み直せたときに、その会計を出した画面 (showQrBill に渡した受け手) に
//     bill key・何件目か・額を知らせる。行を書かなかった入金 (同じ tx の行・印が先にあった・印を書けなかった) は知らせない。
//   - このタブが印を書いた後に、行を履歴に読み直せなかった (保存の失敗: 容量の上限・private mode の拒否・throw。
//     appendHistory は失敗を握りつぶして返る) ときは、同じ知らせに notSaved を付ける (「入金を確かめたが、この端末の履歴に
//     書けなかったかもしれない」)。印は残るので、その tx は後から当たっても書かない (書き直しはしない)。印を確かめた後に
//     別のタブが同じ tx の印を書いていた (このタブは印を書いていない) ときは、行を読み直せなくても知らせない (その tx の行の
//     行方は、そのタブの保存しだい)。警告 qrSale.row_not_confirmed は固定のイベント名だけ (例外の本文・tx・bill key を出さない)。
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
  readQrSwitchedStdBill,
  readSettledLog,
  readTransferLog,
  settledMatchesExpected,
  stdCallsExceedTransfers,
  stdMarkCount,
  transferMatchesExpected,
  type QrBill,
  type QrBillInput,
  type QrStdBill,
  type SettledLog,
  type StdTx,
  type TransferLog,
} from './qrSaleHistory';
import { addQrSaleMark, ORDER_FEED_MARKS_KEY, putQrSaleMark, QR_SALE_MARKS_KEY, readTxMarks } from './qrSaleMarks';
import {
  QR_SALE_RPC_TIMEOUT_MS,
  readBlockTime,
  readChainHead,
  readSettledLogs,
  readSwitchedTransferLogs,
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
  /**
   * 印を書いた後に、行を履歴に読み直せなかった (この端末の履歴に書けなかったかもしれない)。書けたときは付けない。
   * count と amount は、書けたときと同じ数え方・額。
   */
  notSaved?: true;
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
/** ガスレスの会計 (forwarder の Settled で確かめる)。切り替えた入金 (頭の注記) は、JPYC の Transfer と tx の input の印で確かめる。 */
type WatchedSettled = WatchedBase & {
  rail: 'settled';
  bill: QrBill;
  /** 同じ QR を、払う側で通常決済に切り替えて払われたときの期待値 (null = 作れない会計: 切り替えた入金は確かめない)。 */
  std: QrStdBill | null;
  /** この会計のガスレスの入金 (Settled) として数えた tx (小文字の hash)。同じ tx を、切り替えた入金としてもう 1 回数えない。 */
  settledTxs: Set<string>;
  /** この会計の切り替えた入金として数えた tx (小文字の hash → 何件目か)。同じ tx を、どちらの経路でも、もう 1 回数えない。 */
  switchedTxs: Map<string, number>;
};
/** 通常決済の会計 (JPYC の Transfer と tx の input の印で確かめる)。 */
type WatchedTransfer = WatchedBase & { rail: 'transfer'; bill: QrStdBill };
type WatchedBill = WatchedSettled | WatchedTransfer;
/** 読む log の種類 (ガスレスの会計の Settled・通常決済の会計の Transfer)。会計の rail と同じ値。 */
type LogKind = WatchedBill['rail'];
type ChainCursor = {
  /** 前回、照合し終えた最後の block (null = 次の回は先頭 − 90 から読む: 初めての回・新しい会計が加わった後)。 */
  lastTo: bigint | null;
};
/** 切り替えた入金で確かめるガスレスの会計と、その通常決済の期待値。 */
type SwitchedCandidate = { w: WatchedSettled; std: QrStdBill };
/**
 * 切り替えた入金の段に渡すもの (1 つのチェーン・1 回)。どれも、その回の今までの処理が決めた値 (頭の注記の約束 (2)):
 * 会計は回の始まりの写し・範囲はその回の Settled が照合し終えた範囲。
 */
type SwitchedJob = {
  chainId: number;
  /** その回 (tick) の始まりにあったガスレスの会計のうち、通常決済の期待値を持つもの (回の途中で加わった会計は入らない)。 */
  bills: readonly SwitchedCandidate[];
  /** その回の Settled が読んで照合し終えた block の範囲 (両端を含む)。 */
  fromBlock: bigint;
  toBlock: bigint;
  /** その回 (チェーンごと) に使った getLogs の回数・読んだ tx の数 (Settled と通常決済の会計が使った後の残りを使う)。 */
  budget: { calls: number };
  txReads: { count: number };
};

const bills = new Map<string, WatchedBill>();
// 読む位置は、チェーンと log の種類ごと (`チェーン:種類`)。
const cursors = new Map<string, ChainCursor>();
const seenLogs = new Set<string>();
const blockTimes = new Map<string, bigint>();
// 読めた tx (`チェーン:tx`)。同じ tx の 2 つ目の Transfer で読み直さない。
const txs = new Map<string, StdTx>();
// 切り替えた入金の段が読んだ block の時刻・tx (同じ key)。上の 2 つ (Settled と通常決済の会計の照合が使う) には書かない:
// 切り替えた入金が先に読んだ tx を、通常決済の会計の照合が「もう読んだ tx」として使うと、1 回に読む tx の上限 (4 つ) を
// 越えて照合が進み、今までと違う回に行を書く (頭の注記の約束 (1))。切り替えた入金の側は、上の 2 つを読むだけ。
const switchedBlockTimeCache = new Map<string, bigint>();
const switchedTxCache = new Map<string, StdTx>();
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
// 「行を読み直せなかった」の警告は、ほかの警告 (watch_failed・save_failed = 例外つき) と別に 1 回。共通の 1 回を使うと、
// この警告が先に出た /create の間は、見張りの失敗の例外が Sentry に届かなくなる (main より原因を追えなくなるのを断つ)。
let warnedRowNotConfirmed = false;

function warnOnce(event: string, error?: unknown): void {
  if (warned) return;
  warned = true;
  logger.warn(event, error === undefined ? {} : { error });
}

function warnRowNotConfirmedOnce(): void {
  if (warnedRowNotConfirmed) return;
  warnedRowNotConfirmed = true;
  logger.warn('qrSale.row_not_confirmed', {});
}

function clearState(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  bills.clear();
  cursors.clear();
  seenLogs.clear();
  blockTimes.clear();
  txs.clear();
  switchedBlockTimeCache.clear();
  switchedTxCache.clear();
  txMarkUses.clear();
}

const cursorKey = (chainId: number, kind: LogKind) => `${chainId}:${kind}`;

/**
 * 保存の結果。recorded = この書き手が行を書き、読み直せた・notSaved = この書き手が印を書いた後に、行を読み直せなかった
 * (画面に「書けなかったかもしれない」を知らせる)・skipped = 書かなかった (知らせない)。
 */
type SaveOutcome = 'recorded' | 'notSaved' | 'skipped';

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

// store = 読めた値の置き場 (既定 = Settled と通常決済の会計の照合の置き場。切り替えた入金の段は、自分の置き場を渡す)。
async function blockTimeOf(chainId: number, blockNumber: bigint, store = blockTimes): Promise<bigint> {
  const key = `${chainId}:${blockNumber}`;
  const known = store.get(key);
  if (known !== undefined) return known;
  const time = await withDeadline(readBlockTime(chainId, blockNumber));
  if (typeof time !== 'bigint' || time <= 0n) throw new Error('qr_sale_block_time_unreadable');
  store.set(key, time);
  return time;
}

// 通常決済の会計の照合に使う tx (送り手・宛先・input)。読めない (RPC の失敗・時間切れ・tx が無い) ときは throw する
// (呼ぶ側は、その Transfer を「読んだ」ことにせず、次の回に読み直す)。形の違う応答も読めないものとして扱う: 壊れた応答を
// 「印の無い tx」として読んだことにすると、その入金を二度と照合しない (落とす) ため。
// store = 読めた tx の置き場 (blockTimeOf と同じ)。
async function txOf(chainId: number, hash: string, store = txs): Promise<StdTx> {
  const key = `${chainId}:${hash.toLowerCase()}`;
  const known = store.get(key);
  if (known) return known;
  const tx = await withDeadline(readTransaction(chainId, hash as Hash));
  const readable =
    typeof tx?.from === 'string' &&
    isAddress(tx.from, { strict: false }) &&
    (tx.to === null || (typeof tx.to === 'string' && isAddress(tx.to, { strict: false }))) &&
    typeof tx.input === 'string' &&
    isHex(tx.input) &&
    // isHex は奇数桁も通す。末尾の 1 桁が欠けた応答を「印の無い tx」として読んだことにすると、その入金を落とすので、
    // byte にならない input も読めないものとして扱う。
    tx.input.length % 2 === 0;
  if (!readable) throw new Error('qr_sale_tx_unreadable');
  const read: StdTx = { from: tx.from, to: tx.to, input: tx.input };
  store.set(key, read);
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

// 保存の直前の確認 → 印 → 行 (頭の注記の「保存の決まり」)。
function save(bill: QrBill, settled: SettledLog, txHash: string, blockTime: bigint, withDetail: boolean): SaveOutcome {
  return saveRow(txHash, () => buildQrSaleEntry(bill, settled, txHash, blockTime, withDetail));
}

// 保存の決まりの本体 (ガスレスの行と通常決済の行で同じ)。build = 書く行 (印を書けた後にだけ組む)。
function saveRow(txHash: string, build: () => HistoryEntry): SaveOutcome {
  const hash = txHash.toLowerCase();
  const own = readTxMarks(QR_SALE_MARKS_KEY);
  const feed = readTxMarks(ORDER_FEED_MARKS_KEY);
  // 印を読めない端末では書かない (消した行を書き戻さない側に倒す)。
  if (!own || !feed) return 'skipped';
  // 前に書いた tx (この書き手か、受注の書き手が書いて、店主が履歴から消した行を含む)。書き戻さない。
  if (own.has(hash) || feed.has(hash)) return 'skipped';
  // 同じ tx の行がもうある (払った側の画面・お店の端末で送る・受注の書き手が書いた)。その行にも印を付ける。
  if (historyHasTx(hash)) {
    addQrSaleMark(hash);
    return 'skipped';
  }
  // 先に印を書く。書けなければ行を書かない (この書き手が書いた行には、必ず印がある)。確かめた後に別のタブがこの tx の印を
  // 書いていた ('present') ときも、今までどおり行を書く (addQrSaleMark と同じ流れ)。
  const mark = putQrSaleMark(hash);
  if (mark === null) return 'skipped';
  try {
    appendHistory(build());
    // appendHistory は localStorage の書き込みの失敗 (容量の上限など) を握りつぶして返る。画面に「取引履歴に記録しました」と
    // 出すのは、行が履歴にあると読み直せたときだけ (書けていない行を「記録した」と言う偽の成功を断つ・掟 13)。
    if (historyHasTx(hash)) return 'recorded';
  } catch {
    // 1 件の行の組み立て・保存・読み直しの throw を、残りの入金の記録へ波及させない (掟 13)。黙った失敗と同じに扱う (下)。
    // 例外の本文は logger に渡さない (本文に tx が入りうる・共通の logger の伏せ字の対象外)。そのため行の組み立ての不具合は、
    // main (save_failed + 例外) と違い Sentry から原因を追えない (受け入れた限界・画面の注意で店主には見える)。
  }
  // 行を読み直せなかった。警告は固定のイベント名だけ (例外の本文・名前・tx・bill key を出さない)。
  warnRowNotConfirmedOnce();
  // 画面に「書けなかったかもしれない」を出すのは、このタブが印を書いたときだけ ('present' = 確かめた後に別のタブがこの tx の
  // 印を書いていた: その tx の行の行方は、そのタブの保存しだいで、このタブからは分からない)。
  return mark === 'added' ? 'notSaved' : 'skipped';
}

// 保存の結果を、その会計を出した画面に知らせる (頭の注記の「画面への知らせ」)。受け手の失敗 (画面の側の throw) を、
// 残りの入金の記録と見張りの回へ波及させない (掟 13)。知らせられなくても履歴は変わらない。
// amount = 書く行の saleAmount と同じ値。count = この入金が、その会計の何件目か (既定 = 今の件数 = いま数えた入金)。
function notifyRecorded(w: WatchedBill, amount: bigint, outcome: SaveOutcome, count: number = w.matched): void {
  if (outcome === 'skipped' || !w.onRecorded) return;
  try {
    w.onRecorded({
      billKey: w.bill.billKey,
      count,
      amount: amount.toString(),
      ...(outcome === 'notSaved' ? { notSaved: true as const } : {}),
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
  /** 読んだ範囲の始まり (切り替えた入金の段が、同じ範囲を読むのに使う)。 */
  fromBlock: bigint;
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
  return { source, cursor, fromBlock, readTo, logs, stoppedAt: null };
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
  sameTxTransfers: (txHash: string) => readonly TransferLog[],
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
    // 1 つの入金で複数の会計を確かめたことにしない: input の transfer の数が、同じ tx のこの会計に合う Transfer の数を
    // 超える tx は、どの会計の入金ともしない (lib/qrSaleHistory.ts の stdCallsExceedTransfers)。
    const fitting = sameTxTransfers(txHash).filter((t) => transferMatchesExpected(t, w.bill)).length;
    if (stdCallsExceedTransfers(tx, w.bill, fitting)) continue;
    if (stdMarkCount(tx, transfer, w.bill) <= used) continue;
    txMarkUses.set(key, used + 1);
    // 明細を付けるのは、その会計の 1 件目の一致だけ (ガスレスと同じ)。
    const withDetail = w.matched === 0;
    w.matched += 1;
    let outcome: SaveOutcome = 'skipped';
    try {
      outcome = saveRow(txHash, () => buildQrStdSaleEntry(w.bill, transfer, txHash, blockNumber, blockTime, withDetail));
    } catch (error) {
      // 1 件の保存の失敗を、残りの入金の記録へ波及させない (ガスレスと同じ)。行の組み立て・保存・読み直しの throw は
      // saveRow の中で受け止めるので、ここに届くのは印を書く前の確認 (履歴・印の読み取り) の throw。
      warnOnce('qrSale.save_failed', error);
    }
    // 額は書いた行の saleAmount (lib/qrSaleHistory.ts の buildQrStdSaleEntry: 請求額)。
    notifyRecorded(w, w.bill.expected.saleAmount, outcome);
    // 1 つの Transfer に一致する会計は 1 つまで。
    break;
  }
  return 'done';
}

/**
 * 切り替えた入金 (頭の注記の「ガスレスの会計の、切り替えた入金」) の Transfer を、その回の Settled が照合し終えた範囲について
 * 読む。位置は持たない。新しい block から古い方へ読み、getLogs の枠 (Settled と通常決済の会計が使った後の残り) が尽きたら・
 * 読み取りが失敗したら、読めた所までを返す (残りは読まない)。'stale' = 待つ間に止められた。
 */
async function readSwitchedRange(job: SwitchedJob, startedGeneration: number): Promise<QrSaleLog[] | 'stale'> {
  const token = job.bills[0].std.deployment.address;
  const merchants = [...new Set(job.bills.map(({ std }) => std.merchant))];
  const logs: QrSaleLog[] = [];
  // 10 block ずつ読むか: このチェーンがそうだと分かっている (Settled・通常決済の会計の読み取りが覚えた) か、この読み取りが、この回に
  // 範囲の制限の error を受けたか。この読み取りの error は、この回のこの読み取りの中だけで使う (共有の smallRangeChains には
  // 入れない = 切り替えた入金の失敗で、Settled と通常決済の会計の読み方を変えない)。
  let small = smallRangeChains.has(job.chainId);
  // hi = まだ読んでいない一番新しい block。
  let hi = job.toBlock;
  while (hi >= job.fromBlock && job.budget.calls < QR_SALE_MAX_GETLOGS_PER_PASS) {
    job.budget.calls += 1;
    const span = hi - QR_SALE_SMALL_RANGE_BLOCKS + 1n;
    const lo = small && span > job.fromBlock ? span : job.fromBlock;
    let part: QrSaleLog[];
    try {
      part = await withDeadline(readSwitchedTransferLogs(job.chainId, token, merchants, lo, hi));
    } catch (error) {
      if (startedGeneration !== generation) return 'stale';
      if (!small && isBlockRangeLimitError(error)) {
        small = true;
        continue;
      }
      // rate limit・時間切れ・ほかの error: ここで読むのをやめる (読めた所までを照合する)。
      break;
    }
    if (startedGeneration !== generation) return 'stale';
    logs.push(...part);
    hi = lo - 1n;
  }
  return logs;
}

/**
 * 切り替えた入金の Transfer 1 つを照合する。'done' = 照合し終えた・'stop' = この回の切り替えた入金を、ここでやめる
 * (block の時刻や tx を読めない・tx の数の上限・待つ間に止められた)。確かめ方は通常決済の会計 (checkTransfer) と同じ
 * (受取先・額・送り手が forwarder でない → block の時刻 → tx の input の印)。候補は、その回の始まりにあった会計だけ。
 */
async function checkSwitched(
  job: SwitchedJob,
  token: Address,
  log: QrSaleLog,
  txHash: string,
  blockNumber: bigint,
  startedGeneration: number,
  sameTxTransfers: (txHash: string) => readonly TransferLog[],
): Promise<'done' | 'stop'> {
  const { chainId } = job;
  const transfer = readTransferLog(log, token);
  if (!transfer) return 'done';
  // 受取先・額・送り手が、どの会計の通常決済の期待値とも違う log は照合しない (block の時刻も tx も読まない)。
  const fitting = job.bills.filter(({ std }) => transferMatchesExpected(transfer, std));
  if (fitting.length === 0) return 'done';
  let blockTime: bigint;
  try {
    // 今までの照合が読んだ時刻があれば使う (読むだけ)。この段が読んだ時刻は、この段の置き場に入れる。
    blockTime =
      blockTimes.get(`${chainId}:${blockNumber}`) ?? (await blockTimeOf(chainId, blockNumber, switchedBlockTimeCache));
  } catch {
    return 'stop';
  }
  if (startedGeneration !== generation) return 'stop';
  const txKey = txHash.toLowerCase();
  // その block の時刻に生きていた会計で、この tx をまだ数えていないもの (Settled の入金としても、切り替えた入金としても、
  // 1 つの tx を同じ会計に数えるのは 1 回 = 重ねて読んだ log を二重にしない)。
  const open = fitting.filter(
    ({ w }) => aliveAt(w, blockTime) && !w.settledTxs.has(txKey) && !w.switchedTxs.has(txKey),
  );
  // 残る会計が無ければ、tx を読まない。
  if (open.length === 0) return 'done';
  // 今までの照合が読んだ tx があれば使う (読むだけ)。この段が読んだ tx は、この段の置き場に入れる。
  let tx = txs.get(`${chainId}:${txKey}`) ?? switchedTxCache.get(`${chainId}:${txKey}`);
  if (!tx) {
    // tx の数の上限 (通常決済の会計の照合と合わせて、1 回・チェーンごとに QR_SALE_MAX_TX_READS_PER_PASS)。
    if (job.txReads.count >= QR_SALE_MAX_TX_READS_PER_PASS) return 'stop';
    job.txReads.count += 1;
    try {
      tx = await txOf(chainId, txHash, switchedTxCache);
    } catch {
      return 'stop';
    }
    if (startedGeneration !== generation) return 'stop';
  }
  for (const { w, std } of open) {
    // 1 つの入金で複数の会計を確かめたことにしない (lib/qrSaleHistory.ts の stdCallsExceedTransfers)。
    const sameTx = sameTxTransfers(txHash).filter((t) => transferMatchesExpected(t, std)).length;
    if (stdCallsExceedTransfers(tx, std, sameTx)) continue;
    // この会計の印の付いた transfer が、この tx の input に無ければ、この会計の入金ではない (額だけの一致では書かない)。
    if (stdMarkCount(tx, transfer, std) < 1) continue;
    // 件数は Settled の入金と合わせて数える。明細を付けるのは、その会計の 1 件目の一致だけ。
    const count = w.matched + 1;
    w.matched = count;
    w.switchedTxs.set(txKey, count);
    let outcome: SaveOutcome = 'skipped';
    try {
      outcome = saveRow(txHash, () => buildQrStdSaleEntry(std, transfer, txHash, blockNumber, blockTime, count === 1));
    } catch (error) {
      // 1 件の保存の失敗を、残りの入金の記録へ波及させない (ここに届くのは、印を書く前の確認の throw)。
      warnOnce('qrSale.save_failed', error);
    }
    // 額は書いた行の saleAmount (請求額)。
    notifyRecorded(w, std.expected.saleAmount, outcome, count);
    // 1 つの Transfer に一致する会計は 1 つまで。
    break;
  }
  return 'done';
}

/**
 * 切り替えた入金の段 (1 つのチェーン): 全チェーンの今までの回が終わった後に走る (tick)。読む → 古い順に照合。位置・読んだ log の
 * 覚え・共有の状態 (Settled と通常決済の会計の位置・smallRangeChains) は変えない。途中でやめた分は、次の回の Settled の範囲に
 * 入っていれば読み直す (入っていなければ、その入金は行にならない)。
 */
async function pollSwitched(job: SwitchedJob, startedGeneration: number): Promise<void> {
  const logs = await readSwitchedRange(job, startedGeneration);
  if (logs === 'stale') return;
  const token = job.bills[0].std.deployment.address;
  // tx ごとの受取先への Transfer (この回に読んだ範囲の全部・1 つの tx の log は同じ block にある)。stdCallsExceedTransfers の
  // 「同じ tx の Transfer の数」に使う。
  const transfersByTx = new Map<string, TransferLog[]>();
  const ordered: { log: QrSaleLog; txHash: string; logIndex: number; blockNumber: bigint }[] = [];
  for (const log of logs) {
    // 番号の無い log (取り込み前) は読まない。照合するのは、その回の Settled が照合し終えた範囲の中の log だけ (RPC が範囲の
    // 外の log を返しても使わない)。
    if (!isTxHashLike(log.transactionHash) || typeof log.logIndex !== 'number' || typeof log.blockNumber !== 'bigint') {
      continue;
    }
    if (log.blockNumber < job.fromBlock || log.blockNumber > job.toBlock) continue;
    ordered.push({ log, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
    const t = readTransferLog(log, token);
    if (!t) continue;
    const k = log.transactionHash.toLowerCase();
    transfersByTx.set(k, [...(transfersByTx.get(k) ?? []), t]);
  }
  ordered.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  for (const { log, txHash, blockNumber } of ordered) {
    const step = await checkSwitched(
      job,
      token,
      log,
      txHash,
      blockNumber,
      startedGeneration,
      (hash) => transfersByTx.get(hash.toLowerCase()) ?? [],
    );
    if (step === 'stop') return;
  }
}

// 返す値 = この回の後ろで走らせる、切り替えた入金の段 (無ければ何も返さない)。
async function pollChain(chainId: number, startedGeneration: number): Promise<SwitchedJob | void> {
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

  // 通常決済の照合に使う、tx ごとの受取先への Transfer (この回に読んだ範囲の全部・1 つの tx の log は同じ block にあるので、
  // その tx の Transfer はこの回にそろっている)。stdCallsExceedTransfers の「同じ tx の Transfer の数」に使う。
  const transfersByTx = new Map<string, TransferLog[]>();
  for (const stream of streams) {
    if (stream.source.kind !== 'transfer') continue;
    for (const log of stream.logs) {
      if (!isTxHashLike(log.transactionHash)) continue;
      const t = readTransferLog(log, stream.source.token);
      if (!t) continue;
      const k = log.transactionHash.toLowerCase();
      transfersByTx.set(k, [...(transfersByTx.get(k) ?? []), t]);
    }
  }

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
      const step = await checkTransfer(
        chainId,
        source.token,
        log,
        txHash,
        blockNumber,
        id,
        txReads,
        startedGeneration,
        (hash) => transfersByTx.get(hash.toLowerCase()) ?? [],
      );
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
      // この tx を、この会計の切り替えた入金としてもう数えていたら (RPC がその block の Settled を欠いて返した回の後に届いた
      // Settled)、件数は増やさず、その時の「何件目か」を使う。保存は今までどおり試みる (その tx の行・印があれば書かない)。
      // 数えていなければ、今までどおり 1 つ数える。
      const txKey = txHash.toLowerCase();
      const switchedCount = w.switchedTxs.get(txKey);
      const count = switchedCount ?? w.matched + 1;
      if (switchedCount === undefined) w.matched = count;
      w.settledTxs.add(txKey);
      // 明細を付けるのは、その会計の 1 件目の一致だけ (2 件目以降 = 同じ会計への 2 回目の入金)。
      const withDetail = count === 1;
      let outcome: SaveOutcome = 'skipped';
      try {
        outcome = save(w.bill, settled, txHash, blockTime, withDetail);
      } catch (error) {
        // 1 件の保存の失敗を、残りの入金の記録へ波及させない。行の組み立て・保存・読み直しの throw は saveRow の中で
        // 受け止めるので、ここに届くのは印を書く前の確認 (履歴・印の読み取り) の throw。
        warnOnce('qrSale.save_failed', error);
      }
      // 額は書いた行の saleAmount と同じ式 (lib/qrSaleHistory.ts の buildQrSaleEntry: 着金額 + 利用料)。
      notifyRecorded(w, settled.merchantValue + settled.feeValue, outcome, count);
      // bill key は会計ごとに違う乱数なので、1 つの Settled が一致する会計は多くても 1 つ。
      break;
    }
  }
  // 次の回は、種類ごとに、照合し終えた所の続きから (読めた所まで・回した log の block から読み直す)。
  for (const stream of streams) {
    stream.cursor.lastTo = stream.stoppedAt === null ? stream.readTo : stream.stoppedAt - 1n;
  }

  // 切り替えた入金の段 (頭の注記) に渡すもの。ここまで (Settled と通常決済の会計の読み取り・照合・保存・位置) は、今までの回と
  // 同じ。段は、全チェーンのここまでが終わった後に走る (tick)。範囲 = この回の Settled が読んで照合し終えた範囲 (読めなかった
  // 回・1 つも照合し終えていない回は、段を作らない)。会計 = このチェーンの回の始まりにあったガスレスの会計 (tick が、回 (tick) の
  // 始まりにあった会計だけに絞る)。
  const settledStream = streams.find((stream) => stream.source.kind === 'settled');
  if (!settledStream) return;
  // 範囲の終わり = 読めた所 (readTo) と、照合し終えた所 (回した log の手前) の小さい方。RPC が範囲の外 (読めた所より後ろ) の
  // log を返して、その log で照合を回した回は、照合し終えた所が読めた所を越える: 読んでいない block を範囲に入れない。
  const settledTo =
    settledStream.stoppedAt !== null && settledStream.stoppedAt - 1n < settledStream.readTo
      ? settledStream.stoppedAt - 1n
      : settledStream.readTo;
  const switchedBills = settledBills.flatMap((w) => (w.std ? [{ w, std: w.std }] : []));
  if (settledTo < settledStream.fromBlock || switchedBills.length === 0) return;
  return { chainId, bills: switchedBills, fromBlock: settledStream.fromBlock, toBlock: settledTo, budget, txReads };
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
  // この回 (tick) の始まりにあった会計。切り替えた入金の候補は、この中の会計だけ (頭の注記の約束 (2)): 先のチェーンの RPC を
  // 待つ間に、後ろのチェーンに加わった会計は、次の回から。
  const billsAtStart = new Set<WatchedBill>(bills.values());
  // タブが裏のあいだは読まない (戻ったら、前回の続き・先頭 − 90 のうち新しい方から読む)。
  if (document.visibilityState === 'hidden') return;
  running = true;
  const startedGeneration = generation;
  try {
    const switchedJobs: SwitchedJob[] = [];
    for (const chainId of chainIds) {
      try {
        const job = await pollChain(chainId, startedGeneration);
        if (job) {
          const atStart = job.bills.filter(({ w }) => billsAtStart.has(w));
          if (atStart.length > 0) switchedJobs.push({ ...job, bills: atStart });
        }
      } catch {
        // RPC の失敗・時間切れ・読めない応答は、その回を飛ばす (前回の位置を変えない = 次の回に同じ範囲から読み直す)。
      }
      if (startedGeneration !== generation) return;
    }
    // 切り替えた入金の段 (頭の注記): 全チェーンの今までの回 (Settled と通常決済の会計) が終わった後に、チェーンごとに。
    for (const job of switchedJobs) {
      try {
        await pollSwitched(job, startedGeneration);
      } catch {
        // この段の失敗は、その回の切り替えた入金をやめるだけ (今までの回の記録・位置・ほかのチェーンへ波及させない・掟 13)。
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
        ? {
            ...base,
            rail: 'settled',
            bill: settledBill,
            // 払う側で通常決済に切り替えて払われたときの期待値 (頭の注記の「ガスレスの会計の、切り替えた入金」)。
            std: readQrSwitchedStdBill(input),
            settledTxs: new Set(),
            switchedTxs: new Map(),
          }
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
  warnedRowNotConfirmed = false;
}
