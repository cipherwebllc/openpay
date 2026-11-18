'use client';

// お店の画面 (/create の決済QR・レジ) が QR を出している間と、閉じた後 60 秒、forwarder の `Settled` を RPC で読み、
// 会計ごとの印 (bill key) から計算し直した nonce とちょうど一致した入金だけを、この端末の取引履歴 (localStorage) に
// 1 行書く。通常決済の QR (mode=standard) の会計は、JPYC の `Transfer` とその tx の input の印で確かめる (下の
// 「通常決済の会計」)。ガスレスの QR を払う側で通常決済に切り替えて払った入金も、同じく `Transfer` と印で確かめる (下の
// 「ガスレスの会計の、通常決済で払われた入金」)。server へは何も送らない。hooks/useQrBillKey.ts が dynamic import して使う
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
//     重ね (前回 − 10) は、制限のあるチェーンでも小さくしない (普段の回の getLogs は 2 回になる。Transfer だけ、残りの
//     枠で読み切れない回は重ねを読まない = 下の「通常決済の会計」)。
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
//   - そのチェーンに通常決済の会計か、ガスレスの会計 (下の「ガスレスの会計の、通常決済で払われた入金」) があれば、JPYC の
//     deployment の `Transfer` (この受取先宛て = getLogs の topic の to で絞る) も読む。読む位置は、チェーンと種類
//     (Settled・Transfer) ごとに持つ (始まり・重ね・先頭 − 90・10 block ずつ・途中で失敗したら読めた所まで、は上と同じ)。
//     片方の種類だけ読めた回は、読めた種類の位置だけを進める (読めなかった種類は、次の回に同じ所から読み直す = 範囲を
//     飛ばさない)。新しい通常決済の会計が加わったら Transfer の位置を消す。新しいガスレスの会計が加わったら Settled の位置を
//     消し、Transfer の位置は、その受取先の Transfer をまだ読んでいないときだけ消す (同じ受取先の Transfer は、もう読んで
//     照合してあるので読み直さない: QR を出し直すたびに Transfer を先頭 − 90 へ戻すと、10 block ずつのチェーンで、直近の
//     block に届く前に次の出し直しが来る)。
//   - Settled が先・Transfer は後ろ (Settled の回は Transfer を待たない): 1 回 (チェーンごと) は「先頭 → Settled の getLogs →
//     Settled の照合・保存・位置」までで、ここは Transfer の RPC (getLogs・block の時刻・tx) を 1 つも待たない (ガスレスの
//     会計だけのチェーンの、今までの回と同じ時機)。Transfer の読み取りと照合は、その後ろで切り離して走る (Transfer の回)。
//     Transfer の回が次の回までに終わっていなければ、そのチェーンの次の回は Transfer を読まない (重ねない)。Transfer の回の
//     遅れ・失敗・待つ間に /create を離れたことは、同じ回に読めた Settled の行・知らせに影響しない。
//   - getLogs の回数の上限 (1 回・チェーンごとに 10 回) は種類を合わせた数。Settled が先に使い、Transfer は残りの回数で
//     読む (Transfer の側の読み取りは、ガスレスの会計の読む範囲を狭めない)。10 block ずつのチェーンで Settled が 10 回を
//     使い切った回は、Transfer はその回は読まず、読むはずだった範囲の始まりを覚えて、次の回にそこから読む (次の回の先頭が
//     進んでいても、最初の回の対象だった block を飛ばさない・先頭 − 180 より前は読まない)。残りの枠で範囲を読み切れない回
//     (新しいガスレスの会計で Settled が 9 回使った回など) は、重ね (前回 − 10) を読まずに続きから読む (残りが 1 回でも
//     10 block 進む = 枠の少ない回が続いても先頭に近づく)。RPC の失敗で 1 つも読めなかった回は、今までどおり (位置が
//     無ければ、次の回の先頭 − 90 から)。
//   - 1 tx 1 行は、先に照合した会計の行。同じ回に Settled と Transfer の両方が拾った tx は、Settled の会計の行 (ガスレスの
//     行)。次の回に回す (block の時刻・tx を読めない・上限) のは、その種類の、その log から後ろだけ (Transfer の照合の
//     失敗を、ガスレスの会計の照合へ波及させない)。
//   - 見つけた Transfer ごとに、まず受取先・額が、生きている通常決済の会計のどれかの期待値とちょうど同じで、送り手が
//     forwarder でないかを見る (transferMatchesExpected)。どれとも違えば、block の時刻も tx も読まない。同じなら block の
//     時刻を読み、その時刻に生きていた会計があれば tx (getTransaction) を読み、input に会計の印が付いた transfer があるかを
//     見る (stdMarkCount: EOA が直接送った tx はちょうど同じ input・スマートアカウントは「transfer + 印」の並び)。
//   - tx を読めない (失敗・時間切れ・tx が無い・形の違う応答) Transfer は「読んだ」ことにせず、block の時刻と同じく、その
//     log から後ろ (Transfer) を次の回に回す。1 回 (チェーンごと) に読む tx は 4 つまで (超える log から後ろを次の回に回す)。
//     nonce の計算の組の上限 (4 つ) は Settled だけに数える。
//   - 印 1 つ (input の「transfer + 印」の並び 1 つ) を数えるのは Transfer 1 つまで。同じ tx に同じ額の Transfer が
//     2 つあり、印が別の 2 つの会計のものなら、それぞれの会計に 1 つずつ数える (行は tx ごとに 1 つ)。
//   - 受け入れている限界: 払う側が印を付けない支払い (今、印を付けるのは、試しのスイッチを入れた端末だけ・
//     hooks/useStdBillMark.ts) は行にならない。ウォレットが calldata を書き換えて印を落とすと行にならない。ERC-4337 の bundle で、同じお店・同じ額の 2 件が 1 つの tx に入ると 1 行。
//     中の呼び出しが失敗した UserOp の印は input に残るが、Transfer の log が無いので候補にならない。
//
// ガスレスの会計の、通常決済で払われた入金 (ガスレスの QR を、払う側の画面で通常決済に切り替えて払った):
//   - ガスレスで払えないウォレット (ERC-4337 のマイナウォレットなど) は、ガスレスの QR を読んで、払う側で通常決済に切り替えて
//     払う。払う側は、その送金にも同じ bill key の印を付ける (transfer(受取先, 額) + 印)。forwarder は通らないので Settled は
//     出ない。そこでガスレスの会計には、Settled の期待値 (回収の後の着金額・利用料) とは別に、同じ URL・同じ bill key から
//     作った通常決済の期待値 (額 = calcBreakdown の standard の着金額 = 今は請求額そのもの・印 = billKeyStdMark) も持たせる
//     (lib/qrSaleHistory.ts の readQrSwitchedStdBill)。例: 請求 1,000 JPYC・回収 2 JPYC の会計は、Settled なら着金 998 +
//     利用料 2、切り替えた後の Transfer なら 1,000 (回収の後の額 998 の Transfer・通常決済の額 1,000 の Settled は一致しない)。
//   - 確かめ方は、上の「通常決済の会計」とまったく同じ (受取先・額・送り手が forwarder でない → block の時刻に会計が
//     生きていた → tx の input の印・stdCallsExceedTransfers・印 1 つに Transfer 1 つ)。額だけの一致では書かない。行も通常決済の
//     行 (buildQrStdSaleEntry: payMode standard・gasMode null・お客様は Transfer の from)。getLogs の回数 (種類を合わせて
//     10 回・Settled が先)・tx の読み取りの上限 (4 つ)・片方の種類だけ読めた回の扱いも同じものを使う。
//   - 会計の件数 (何件目か)・明細 (1 件目だけ)・知らせは、Settled の入金と Transfer の入金で共有する (1 つの会計に 1 つの数)。
//     同じ会計に、ガスレスの入金と通常決済の入金が別の tx で届けば 2 行。1 件目は先に照合した方 (同じ回に両方が見つかれば
//     Settled の入金・回が分かれれば先に見つかった方)。
//   - 1 つの tx を、同じ会計の Settled と Transfer の両方が拾ったら、その tx はその会計のガスレスの入金: 数えるのも保存も
//     Settled の 1 回だけ (今までの Settled の記録と同じ結果・行はガスレスの行)。同じ tx の Transfer では数えず、保存もせず、
//     tx も読まない。Transfer が先に数えて、後から読めた Settled の行を通常決済の行に変えることが無いように、ガスレスの
//     会計の期待値に合う Transfer は、その block の Settled を照合し終えた後にだけ照合する (Settled の getLogs が失敗した・
//     上限で次の回に回した間は、その Transfer から後ろを次の回に回す)。forwarder の settle の tx は、Settled と
//     「forwarder → 受取先」の Transfer の両方を出すが、送り手が forwarder の Transfer は候補にしないので、ガスレスの行
//     1 つだけになる (tx は読まない)。
//   - 増える RPC: ガスレスの会計だけだったチェーンで、表示中 (と閉じた後 60 秒) は 6 秒ごとに Transfer の getLogs が 1 回
//     (10 block ずつのチェーンは普段 2 回)。block の時刻・tx を読むのは、受取先・額の合う Transfer が届いたときだけ。
//   - 受け入れている限界: 同じ回に見つかった Settled の入金と Transfer の入金は、チェーンの順に関わらず Settled が先
//     (同じ会計なら Settled の入金が 1 件目 = 明細つき)。Settled と Transfer は読む位置が別なので、片方の種類だけ読めなかった
//     回の後は、同じ会計への古い入金が新しい入金より後に見つかることがある (明細は先に見つかった方に付く = 下の「行に
//     するもの」の限界と同じ)。10 block ずつのチェーンでは、そのチェーンを初めて読んでから Transfer が先頭に届くまで 3 回
//     ほど (約 18 秒) かかる (その間の入金は、届いた回に行になる)。受取先の違うガスレスの QR を回ごとに出し続けると、
//     Transfer の位置がそのたびに先頭 − 90 へ戻る。同じ会計の Settled と Transfer の両方が一致する tx で、RPC がその block の
//     Settled を後の回になってから返した (古い node) ときは、Transfer が先に通常決済の行になりうる (その後の Settled は
//     数えるが、行は tx ごとに 1 つ)。Settled・Transfer とも、印を書けなかった入金の行は書き直さない (今までの保存の決まりと
//     同じ)。ガスレスの会計にならない QR (forwarder の無いチェーン・回収の額を引くと着金額が残らない額) は、今までどおり
//     見張らない (通常決済に切り替えた入金も行にならない)。
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
/**
 * ガスレスの会計 (forwarder の Settled で確かめる)。std = 同じ QR を、払う側で通常決済に切り替えて払われたときの期待値
 * (JPYC の Transfer と tx の input の印で確かめる・頭の注記の「ガスレスの会計の、通常決済で払われた入金」)。null = 通常決済の
 * 期待値を作れない会計 (Transfer では確かめない)。
 */
type WatchedSettled = WatchedBase & { rail: 'settled'; bill: QrBill; std: QrStdBill | null };
/** 通常決済の会計 (JPYC の Transfer と tx の input の印で確かめる)。 */
type WatchedTransfer = WatchedBase & { rail: 'transfer'; bill: QrStdBill };
type WatchedBill = WatchedSettled | WatchedTransfer;
/** 読む log の種類 (Settled・Transfer)。会計の rail と同じ値 (ガスレスの会計は Transfer も読む)。 */
type LogKind = WatchedBill['rail'];
/** Transfer で確かめる会計と、その通常決済の期待値 (通常決済の会計は自分の会計・ガスレスの会計は std)。 */
type StdCandidate = { w: WatchedBill; std: QrStdBill };
type ChainCursor = {
  /** 前回、照合し終えた最後の block (null = 次の回は先頭 − 90 から読む: 初めての回・新しい会計が加わった後)。 */
  lastTo: bigint | null;
  /**
   * Transfer だけ: 位置がまだ無い (lastTo が null) うちに、getLogs の枠が残っていなくて 1 回も読めなかった回の、読むはずだった
   * 範囲の始まり (null = 無い)。次に読めるとき、ここから読む (頭の注記の「getLogs の回数の上限」)。
   */
  unreadFrom: bigint | null;
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
// ガスレスの会計の入金 (Settled) として数えた tx (`チェーン:tx:bill key`)。同じ tx の Transfer を、同じ会計の入金として
// もう 1 回数えない (頭の注記の「ガスレスの会計の、通常決済で払われた入金」)。
const settledTxBills = new Set<string>();
// Transfer の回 (pollTransfers) が進行中のチェーン。Settled の回から切り離して走るので、前の回がまだ RPC を待っている間は、
// そのチェーンの Transfer を重ねて読まない。stopQrSaleWatch で空にする。
const transferPasses = new Set<number>();
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
  txMarkUses.clear();
  settledTxBills.clear();
}

const cursorKey = (chainId: number, kind: LogKind) => `${chainId}:${kind}`;
const billTxKey = (chainId: number, txHash: string, billKey: string) => `${chainId}:${txHash.toLowerCase()}:${billKey}`;
// この会計を Transfer で確かめるときの期待値 (無ければ null)。
const stdOf = (w: WatchedBill): QrStdBill | null => (w.rail === 'transfer' ? w.bill : w.std);

/**
 * 保存の結果。recorded = この書き手が行を書き、読み直せた・notSaved = この書き手が印を書いた後に、行を読み直せなかった
 * (画面に「書けなかったかもしれない」を知らせる)・skipped = 書かなかった (知らせない)。
 */
type SaveOutcome = 'recorded' | 'notSaved' | 'skipped';

function cursorFor(chainId: number, kind: LogKind): ChainCursor {
  const key = cursorKey(chainId, kind);
  let cursor = cursors.get(key);
  if (!cursor) {
    cursor = { lastTo: null, unreadFrom: null };
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
    isHex(tx.input) &&
    // isHex は奇数桁も通す。末尾の 1 桁が欠けた応答を「印の無い tx」として読んだことにすると、その入金を落とすので、
    // byte にならない input も読めないものとして扱う。
    tx.input.length % 2 === 0;
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

// このチェーンの会計 (通常決済の会計と、ガスレスの会計の通常決済の期待値) で、受取先・額がこの Transfer とちょうど同じで、
// 送り手が forwarder でないもの (tx を読む前のふるい)。
function stdBillsFitting(chainId: number, transfer: TransferLog): StdCandidate[] {
  return [...bills.values()].flatMap((w) => {
    const std = stdOf(w);
    return std && std.chainId === chainId && transferMatchesExpected(transfer, std) ? [{ w, std }] : [];
  });
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
// amount = 書く行の saleAmount と同じ値。
function notifyRecorded(w: WatchedBill, amount: bigint, outcome: SaveOutcome): void {
  if (outcome === 'skipped' || !w.onRecorded) return;
  try {
    w.onRecorded({
      billKey: w.bill.billKey,
      count: w.matched,
      amount: amount.toString(),
      ...(outcome === 'notSaved' ? { notSaved: true as const } : {}),
    });
  } catch (error) {
    warnOnce('qrSale.notify_failed', error);
  }
}

/** 読む log の種類と、その log を出す contract と、getLogs の読み方。 */
type SettledSource = { kind: 'settled'; forwarder: Address; read: (from: bigint, to: bigint) => Promise<QrSaleLog[]> };
type TransferSource = { kind: 'transfer'; token: Address; read: (from: bigint, to: bigint) => Promise<QrSaleLog[]> };
type LogSource = SettledSource | TransferSource;

/** 1 つの種類の、この回に読めた範囲 (readTo = 読めた最後の block) と log。 */
type LogStream = { readTo: bigint; logs: QrSaleLog[] };

/** 番号のそろった log 1 つ (tx・log の番号・block)。 */
type NumberedLog = { log: QrSaleLog; txHash: string; logIndex: number; blockNumber: bigint };

// チェーンの順 (block → log の番号) に並べる (同じ会計への 1 件目・2 件目の順)。番号の無い log (取り込み前) は読まない。
function inChainOrder(logs: readonly QrSaleLog[]): NumberedLog[] {
  return logs
    .flatMap((log) =>
      isTxHashLike(log.transactionHash) && typeof log.logIndex === 'number' && typeof log.blockNumber === 'bigint'
        ? [{ log, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber }]
        : [],
    )
    .sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
}

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
  let fromBlock: bigint;
  if (cursor.lastTo === null) {
    // 初めての回・新しい会計が加わった後の回は先頭 − 90 から。枠が無くて 1 回も読めなかった回の始まり (unreadFrom・
    // Transfer だけが置く) があれば、そこから (先頭 − 180 より前は読まない・先頭が戻っていたら先頭 − 90 から)。
    const kept = cursor.unreadFrom;
    const floor = oldest - QR_SALE_MAX_BACK_BLOCKS;
    fromBlock = kept === null || kept > oldest ? oldest : kept > floor ? kept : floor;
  } else {
    // 照合し終えた所の続き − 10 から (先頭 − 90 まで)。
    const next = cursor.lastTo - QR_SALE_OVERLAP_BLOCKS;
    fromBlock = next > oldest ? next : oldest;
    // Transfer・10 block ずつのチェーン・この回の残りの枠では範囲を読み切れない (Settled が先に枠を使った): 重ねを読まずに、
    // 照合し終えた所の続きから読む (残りが 1 回でも、新しい block へ 10 block 進む = 枠の少ない回が続いても先頭に追いつく)。
    if (source.kind === 'transfer' && smallRangeChains.has(chainId) && toBlock >= fromBlock) {
      const left = BigInt(QR_SALE_MAX_GETLOGS_PER_PASS - budget.calls);
      const need = (toBlock - fromBlock + QR_SALE_SMALL_RANGE_BLOCKS) / QR_SALE_SMALL_RANGE_BLOCKS;
      const resume = cursor.lastTo + 1n;
      if (need > left && resume > fromBlock) fromBlock = resume;
    }
  }
  if (fromBlock < 0n) fromBlock = 0n;
  if (toBlock < fromBlock) return null;

  // readTo = 読めた最後の block。
  const logs: QrSaleLog[] = [];
  let readTo = fromBlock - 1n;
  // この種類が、この回に getLogs を 1 回でも呼んだか。
  let called = false;
  while (readTo < toBlock && budget.calls < QR_SALE_MAX_GETLOGS_PER_PASS) {
    budget.calls += 1;
    called = true;
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
  if (readTo < fromBlock) {
    // Transfer の位置がまだ無く、枠が残っていなくて 1 回も呼べなかった (10 block ずつのチェーンで Settled が 10 回を使い切った
    // 回): 読むはずだった範囲の始まりを覚える。次の回は先頭が進んでいても、そこから読む (この回の対象だった block を飛ばさない)。
    // RPC の失敗で読めなかった回は覚えない (今までどおり、次の回の先頭 − 90 から)。
    if (source.kind === 'transfer' && cursor.lastTo === null && !called && cursor.unreadFrom === null) {
      cursor.unreadFrom = fromBlock;
    }
    return null;
  }
  return { readTo, logs };
}

/**
 * 読めた Settled を古い順に照合して、一致した入金を行にする (頭の注記の「読み方」「行にするもの」)。Transfer の読み取り・
 * 照合を 1 つも待たない (main の、ガスレスの会計だけの回と同じ await の列: block の時刻だけ)。返す値 = 次の回に回した最初の
 * log の block (null = 全部を照合し終えた)・'stale' = 待つ間に止められた。
 */
async function matchSettledLogs(
  chainId: number,
  forwarder: Address,
  logs: readonly QrSaleLog[],
  startedGeneration: number,
): Promise<bigint | null | 'stale'> {
  // この回に照合した (Settled の log, 会計) の組の数 (上限 QR_SALE_MAX_PAIRS_PER_PASS)。
  let pairs = 0;
  for (const { log, txHash, logIndex, blockNumber } of inChainOrder(logs)) {
    const id = `${chainId}:${txHash.toLowerCase()}:${logIndex}`;
    if (seenLogs.has(id)) continue;
    const settled = readSettledLog(log, forwarder);
    // 受取先・金額が、どの会計の期待値とも違う log は照合しない (block の時刻も読まない・nonce も計算しない)。
    if (!settled || billsFitting(chainId, settled).length === 0) {
      seenLogs.add(id);
      continue;
    }
    let blockTime: bigint;
    try {
      blockTime = await blockTimeOf(chainId, blockNumber);
    } catch {
      // block の時刻を読めなかった log は「読んだ」ことにしない。ここまでの分は書き、この log から後ろは次の回に回す
      // (古い log を飛ばして新しい log を先に照合しない)。
      return blockNumber;
    }
    if (startedGeneration !== generation) return 'stale';
    // 待つ間に増えた・表示をやめた会計も入れて選び直す。その block の時刻に生きていた会計だけ。
    const candidates = billsFitting(chainId, settled).filter((w) => aliveAt(w, blockTime));
    // 照合の量の上限 (頭の注記)。超えたら、この log から後ろを次の回に回す (古い log を飛ばして新しい log を先に
    // 照合しない)。この回の最初の log は必ず照合する。
    if (pairs > 0 && pairs + candidates.length > QR_SALE_MAX_PAIRS_PER_PASS) return blockNumber;
    pairs += candidates.length;
    seenLogs.add(id);
    for (const w of candidates) {
      if (matchSettledToBill(settled, blockTime, w.bill) === null) continue;
      // この tx は、この会計のガスレスの入金として数えた (同じ tx の Transfer では、もう数えない・頭の注記の
      // 「ガスレスの会計の、通常決済で払われた入金」)。
      settledTxBills.add(billTxKey(chainId, txHash, w.bill.billKey));
      // 明細を付けるのは、その会計の 1 件目の一致だけ (2 件目以降 = 同じ会計への 2 回目の入金)。
      const withDetail = w.matched === 0;
      w.matched += 1;
      let outcome: SaveOutcome = 'skipped';
      try {
        outcome = save(w.bill, settled, txHash, blockTime, withDetail);
      } catch (error) {
        // 1 件の保存の失敗を、残りの入金の記録へ波及させない。行の組み立て・保存・読み直しの throw は saveRow の中で
        // 受け止めるので、ここに届くのは印を書く前の確認 (履歴・印の読み取り) の throw。
        warnOnce('qrSale.save_failed', error);
      }
      // 額は書いた行の saleAmount と同じ式 (lib/qrSaleHistory.ts の buildQrSaleEntry: 着金額 + 利用料)。
      notifyRecorded(w, settled.merchantValue + settled.feeValue, outcome);
      // bill key は会計ごとに違う乱数なので、1 つの Settled が一致する会計は多くても 1 つ。
      break;
    }
  }
  return null;
}

/**
 * 通常決済の Transfer 1 つを照合する (頭の注記の「通常決済の会計」)。'done' = 照合し終えた (読んだ log にした)・
 * 'defer' = この log から後ろを次の回に回す (block の時刻・tx を読めない・tx の数の上限・ガスレスの会計の候補があるのに
 * Settled をその block まで照合し終えていない)・'stale' = 待つ間に止められた。
 * reads = この回に読んだ tx の数 (この関数が書き足す)。settledDone = このチェーンの Settled を照合し終えた最後の block
 * (null = まだ 1 度も照合し終えていない・Settled を読まないチェーン)。
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
  settledDone: bigint | null,
): Promise<'done' | 'defer' | 'stale'> {
  const transfer = readTransferLog(log, token);
  // 受取先・額・送り手が、どの会計の通常決済の期待値とも違う log は照合しない (block の時刻も tx も読まない)。
  if (!transfer || stdBillsFitting(chainId, transfer).length === 0) {
    seenLogs.add(id);
    return 'done';
  }
  // ガスレスの会計を Transfer で確かめるのは、その block の Settled を照合し終えた後だけ (同じ tx を、同じ会計の Settled と
  // Transfer の両方が拾ったら、必ず Settled が先に数えて行にする = ガスレスの行を、通常決済の行に変えない)。まだなら、
  // この log から後ろを次の回に回す (RPC は読まない)。
  const waitsForSettled = (candidates: readonly StdCandidate[]) =>
    candidates.some(({ w }) => w.rail === 'settled') && (settledDone === null || blockNumber > settledDone);
  if (waitsForSettled(stdBillsFitting(chainId, transfer))) return 'defer';
  let blockTime: bigint;
  try {
    blockTime = await blockTimeOf(chainId, blockNumber);
  } catch {
    // block の時刻を読めなかった log は「読んだ」ことにしない (ガスレスと同じ)。
    return 'defer';
  }
  if (startedGeneration !== generation) return 'stale';
  // その block の時刻に生きていた会計。この tx を Settled の入金としてもう数えた会計 (同じ tx を、同じ会計の Settled と
  // Transfer の両方が拾った) は外す: その tx は、その会計のガスレスの入金 (数えるのは 1 回・行はガスレスの行)。
  const openBills = () =>
    stdBillsFitting(chainId, transfer).filter(
      ({ w }) => aliveAt(w, blockTime) && !settledTxBills.has(billTxKey(chainId, txHash, w.bill.billKey)),
    );
  // 残る会計が無ければ、tx を読まない。
  if (openBills().length === 0) {
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
  const candidates = openBills();
  // 待つ間に加わったガスレスの会計にも、上と同じ決まり (Settled を照合し終えた block までだけ)。
  if (waitsForSettled(candidates)) return 'defer';
  seenLogs.add(id);
  for (const { w, std } of candidates) {
    // この会計の印の付いた transfer が、この tx の input にいくつあるか。そのうち、まだ別の Transfer に数えていない分だけ使う。
    const key = billTxKey(chainId, txHash, w.bill.billKey);
    const used = txMarkUses.get(key) ?? 0;
    // 1 つの入金で複数の会計を確かめたことにしない: input の transfer の数が、同じ tx のこの会計に合う Transfer の数を
    // 超える tx は、どの会計の入金ともしない (lib/qrSaleHistory.ts の stdCallsExceedTransfers)。
    const fitting = sameTxTransfers(txHash).filter((t) => transferMatchesExpected(t, std)).length;
    if (stdCallsExceedTransfers(tx, std, fitting)) continue;
    if (stdMarkCount(tx, transfer, std) <= used) continue;
    txMarkUses.set(key, used + 1);
    // 明細を付けるのは、その会計の 1 件目の一致だけ (ガスレスと同じ・ガスレスの会計は Settled の入金と合わせて数える)。
    const withDetail = w.matched === 0;
    w.matched += 1;
    let outcome: SaveOutcome = 'skipped';
    try {
      outcome = saveRow(txHash, () => buildQrStdSaleEntry(std, transfer, txHash, blockNumber, blockTime, withDetail));
    } catch (error) {
      // 1 件の保存の失敗を、残りの入金の記録へ波及させない (ガスレスと同じ)。行の組み立て・保存・読み直しの throw は
      // saveRow の中で受け止めるので、ここに届くのは印を書く前の確認 (履歴・印の読み取り) の throw。
      warnOnce('qrSale.save_failed', error);
    }
    // 額は書いた行の saleAmount (lib/qrSaleHistory.ts の buildQrStdSaleEntry: 請求額)。
    notifyRecorded(w, std.expected.saleAmount, outcome);
    // 1 つの Transfer に一致する会計は 1 つまで。
    break;
  }
  return 'done';
}

/**
 * Transfer の回 (1 つのチェーン): Settled の回の後ろで、Transfer を読み、古い順に照合して、位置を進める。Settled の回は
 * これを待たない (pollChain)。budget = 同じ回の Settled が使った後の getLogs の回数 (残りで読む)。
 */
async function pollTransfers(
  chainId: number,
  source: TransferSource,
  cursor: ChainCursor,
  toBlock: bigint,
  oldest: bigint,
  budget: { calls: number },
  settledDone: bigint | null,
  startedGeneration: number,
): Promise<void> {
  const stream = await readStream(chainId, source, cursor, toBlock, oldest, budget, startedGeneration);
  // 読めなかった回は飛ばす (位置を変えない)。
  if (stream === 'stale' || stream === null) return;
  // 照合に使う、tx ごとの受取先への Transfer (この回に読んだ範囲の全部・1 つの tx の log は同じ block にあるので、その tx の
  // Transfer はこの回にそろっている)。stdCallsExceedTransfers の「同じ tx の Transfer の数」に使う。
  const transfersByTx = new Map<string, TransferLog[]>();
  for (const log of stream.logs) {
    if (!isTxHashLike(log.transactionHash)) continue;
    const t = readTransferLog(log, source.token);
    if (!t) continue;
    const k = log.transactionHash.toLowerCase();
    transfersByTx.set(k, [...(transfersByTx.get(k) ?? []), t]);
  }
  // この回に読んだ tx の数 (上限 QR_SALE_MAX_TX_READS_PER_PASS)。
  const txReads = { count: 0 };
  // 次の回に回した最初の log の block (null = 全部を照合し終えた)。
  let stoppedAt: bigint | null = null;
  for (const { log, txHash, logIndex, blockNumber } of inChainOrder(stream.logs)) {
    const id = `${chainId}:${txHash.toLowerCase()}:${logIndex}`;
    if (seenLogs.has(id)) continue;
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
      settledDone,
    );
    if (step === 'stale') return;
    // ここまでの分は書き、この log から後ろは次の回に回す (古い log を飛ばして新しい log を先に照合しない)。
    if (step === 'defer') {
      stoppedAt = blockNumber;
      break;
    }
  }
  // 次の回は、照合し終えた所の続きから (読めた所まで・回した log の block から読み直す)。
  cursor.lastTo = stoppedAt === null ? stream.readTo : stoppedAt - 1n;
  cursor.unreadFrom = null;
}

// Transfer の回を、Settled の回から切り離して走らせる (待たずに戻る)。失敗 (RPC・想定外の throw) は、その回を飛ばすだけ
// (位置を変えない = 次の回に同じ所から読み直す。Settled の回・ほかのチェーン・次の回・timer の外へ波及させない・掟 13)。
// 終わったら、そのチェーンの「Transfer の回が進行中」を外す (止められた後に終わった古い回は、新しい見張りの分を外さない)。
function startTransferPass(chainId: number, startedGeneration: number, pass: () => Promise<void>): void {
  transferPasses.add(chainId);
  pass()
    .catch(() => undefined)
    .finally(() => {
      if (startedGeneration === generation) transferPasses.delete(chainId);
    });
}

async function pollChain(chainId: number, startedGeneration: number): Promise<void> {
  const watched = [...bills.values()].filter((w) => w.bill.chainId === chainId);
  const settledBills = watched.filter((w): w is WatchedSettled => w.rail === 'settled');
  // Transfer で確かめる期待値: 通常決済の会計と、ガスレスの会計の通常決済の期待値 (払う側で通常決済に切り替えた入金)。
  const stdBills = watched.flatMap((w) => {
    const std = stdOf(w);
    return std ? [std] : [];
  });
  // 読む log の種類 (このチェーンにある会計の分だけ)。
  let settledSource: SettledSource | null = null;
  if (settledBills.length > 0) {
    // 同じチェーンのガスレスの会計は、同じ forwarder (lib/relay/forwarderConfig の jpycForwarderFor)。
    const forwarder = settledBills[0].bill.forwarder;
    const merchants = [...new Set(settledBills.map((w) => w.bill.merchant))];
    settledSource = { kind: 'settled', forwarder, read: (from, to) => readSettledLogs(chainId, forwarder, merchants, from, to) };
  }
  let transferSource: TransferSource | null = null;
  if (stdBills.length > 0) {
    // 同じチェーンの会計は、同じ JPYC の deployment。受取先は 2 種類の会計を合わせて、getLogs 1 回で読む。
    const token = stdBills[0].deployment.address;
    const merchants = [...new Set(stdBills.map((std) => std.merchant))];
    transferSource = { kind: 'transfer', token, read: (from, to) => readTransferLogs(chainId, token, merchants, from, to) };
  }
  // 位置は先頭を読む前に持つ (読んでいる間に新しい会計が加わって位置が消されたら、この回はその前の位置に書く = 次の回は
  // 先頭 − 90 から読み直す)。
  const settledCursor = settledSource ? cursorFor(chainId, 'settled') : null;
  const transferCursor = transferSource ? cursorFor(chainId, 'transfer') : null;

  const head = await withDeadline(readChainHead(chainId));
  if (startedGeneration !== generation) return;
  if (typeof head !== 'bigint') throw new Error('qr_sale_head_unreadable');
  const toBlock = head - headMargin(chainId);
  const oldest = head - QR_SALE_MAX_BACK_BLOCKS;

  // getLogs の回数は種類を合わせて 1 回に 10 回まで: Settled が先に使い、Transfer は残りで読む (Transfer の側の読み取りが、
  // ガスレスの会計の読む範囲を狭めない)。
  const budget = { calls: 0 };

  // ガスレスの入金 (Settled): 読む → 照合 → 保存 → 位置、までを先に終える。Transfer の RPC は 1 つも待たない (Transfer の
  // 読み取りの遅れ・失敗・待つ間に /create を離れたことを、ガスレスの入金の記録へ波及させない)。
  if (settledSource && settledCursor) {
    const stream = await readStream(chainId, settledSource, settledCursor, toBlock, oldest, budget, startedGeneration);
    if (stream === 'stale') return;
    // 読めなかった回は飛ばす (位置を変えない)。
    if (stream) {
      const stoppedAt = await matchSettledLogs(chainId, settledSource.forwarder, stream.logs, startedGeneration);
      if (stoppedAt === 'stale') return;
      // 次の回は、照合し終えた所の続きから (読めた所まで・回した log の block から読み直す)。
      settledCursor.lastTo = stoppedAt === null ? stream.readTo : stoppedAt - 1n;
    }
  }

  // Transfer: Settled の後ろで、切り離して走らせる (この関数は待たずに戻る = 次の回の Settled も、ほかのチェーンも待たせない)。
  // 前の回の Transfer がまだ RPC を待っているチェーンは、この回は読まない (同じ log を 2 回処理しない)。
  if (!transferSource || !transferCursor || transferPasses.has(chainId)) return;
  // 待つ間に止められた回 (block の時刻を読めずに戻った Settled の照合は、止められたことを見ない) は、Transfer の回を始めない:
  // 止めた後の「進行中」は、新しい見張りが外せず、そのチェーンの Transfer を読まなくなる。
  if (startedGeneration !== generation) return;
  // Settled を照合し終えた最後の block (この回に読めなかったら前の回までの値・Settled を読まないチェーンは null)。
  const settledDone = settledCursor ? settledCursor.lastTo : null;
  const source = transferSource;
  const cursor = transferCursor;
  startTransferPass(chainId, startedGeneration, () =>
    pollTransfers(chainId, source, cursor, toBlock, oldest, budget, settledDone, startedGeneration),
  );
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
      // ガスレスの会計には、払う側で通常決済に切り替えて払われたときの期待値 (readQrSwitchedStdBill) も持たせる。
      const settledBill = readQrBill(input);
      const stdBill = settledBill ? null : readQrStdBill(input);
      const base = { shownAt, hiddenAt: null, matched: 0, onRecorded: onRecorded ?? null };
      const watched: WatchedBill | null = settledBill
        ? { ...base, rail: 'settled', bill: settledBill, std: readQrSwitchedStdBill(input) }
        : stdBill
          ? { ...base, rail: 'transfer', bill: stdBill }
          : null;
      // 見張れない QR (lib/qrSaleHistory.ts の readQrBill・readQrStdBill) は足さない = RPC を読まない。
      if (!watched) return;
      // ガスレスの会計の受取先の Transfer を、このチェーンのほかの会計がもう読んでいるか (下の Transfer の位置)。
      const std = watched.rail === 'settled' ? watched.std : null;
      const transferAlreadyRead =
        std !== null &&
        [...bills.values()].some((other) => {
          const otherStd = stdOf(other);
          return otherStd !== null && otherStd.chainId === std.chainId && otherStd.merchant === std.merchant;
        });
      bills.set(input.billKey, watched);
      // 新しい会計が加わった: そのチェーンの次の回は先頭 − 90 から読み直す (表示を始めた後の入金を覆う・読んだ log は落とす)。
      // 位置を消す (null にしない): 読んでいる途中の回が、終わった後に古い位置を書き戻さないように、別の物にする。
      cursors.delete(cursorKey(watched.bill.chainId, watched.rail));
      // ガスレスの会計は Transfer も読む。Transfer の位置を消すのは、その受取先の Transfer をまだ読んでいないときだけ
      // (同じ受取先の Transfer は、もう読んで照合してある。出し直すたびに先頭 − 90 へ戻すと、10 block ずつのチェーンで
      // 直近の block に届かない = 頭の注記の「通常決済の会計」)。
      if (std !== null && !transferAlreadyRead) cursors.delete(cursorKey(watched.bill.chainId, 'transfer'));
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
  transferPasses.clear();
  // 警告は /create を開いている間に 1 回 (開き直したら、また 1 回は残す)。
  warned = false;
  warnedRowNotConfirmed = false;
}
