'use client';

// Circle Paymaster (USDC ガスレス) 決済の **二重決済耐性オーケストレータ** (計画 C1)。
//
// 不可逆な merchant 転送を二重に出さないため、送信を FSM (lib/circlePending.ts) で
// 段階管理する:
//   permit 署名(popup1) → UserOp prepare+sign(popup2) → **署名済 op を永続** →
//   submitting を永続 (broadcast_intent・fail-closed) → **raw broadcast** → 確定。
//
// 不変条件:
//   - 永続 (pending store) は fail-closed: 書込が確証できなければ送信しない。
//   - **submitting 到達後は fallback も新規 op 構築も禁止**。応答ロスト / wait timeout は
//     「included しうる unknown」として扱い、recovery は (a) receipt 照会 か
//     (b) *同一署名 op* の冪等 rebroadcast のみ。新しい op は作らない。
//     例外は 1 つだけ: 自分の最初の送信を bundler が検証で拒否し、下の条件で記録を failed に閉じたとき (下の「最初の送信の
//     検証拒否で閉じる」)。bundler がその op の hash を知らないと答えたうえで閉じ、次の押下は新しい支払い (署名から) になる。
//   - cross-invocation (reload / 再クリック): 同一 sender+chain+callHash の submitting
//     宙吊りがあれば、新規送信せず先にそれを recover する。ただし、最後に bundler へ渡してから 30 分より後の、別の key の
//     記録は、EntryPoint の nonce を読んでから決める (下の「古い submitting の記録」)。
//
// 送った後の終わり方 (第 10 回レビュー H-W・H-Y): 自分の markSubmitting が返った後と、submitting / confirmed の記録を扱う枝
// (scan・resume・markSigned の CAS が外れたとき) の終わり方は次だけにする:
//   (1) receipt が取れた・記録が confirmed → 結果
//   (2) まだ bundler に op を渡していない試みが、終わった記録 (failed / abandoned / 記録なし) に当たった → 「既に終了」の error
//   (3) **自分の最初の送信** を bundler が検証で拒否し、記録を failed に閉じられた → 「送信の受付で断られた」error
//       (CircleSendRejectedError・第 10 回レビュー H-X。下の「最初の送信の検証拒否で閉じる」)
//   (4) それ以外すべて → CirclePendingError (確認待ち)
// hook (useBatchPayment の runCirclePayment) は、CirclePendingError と storage の失敗 (PendingStoreUnavailableError・
// PendingStoreWriteError) と、対応を保存できていない押下の停止 (CircleAttemptMappingUnavailableError・下の「対応を保存できて
// いない押下」) 以外の error で attemptId の対応を消す。op を渡したかもしれない後にふつうの error で終わると、次の押下が
// 新しい key になり、後から確定した前の支払い (90 秒より前の confirmed) を「正規のリピート」とみなして 2 本目を払う。なので (4) を
// 1 か所 (inPostSubmit) で保証する。confirmed の記録の枝 (scan・resume) は包まない: resultFromConfirmed が照会の失敗を全部
// 受けて (1) を返し、投げる処理が無い。(2) は何も渡していない・(3) は bundler がその op の hash を知らないと答えた終わり方で、
// 対応を消してよい (次の押下は新しい支払い = 署名から)。
//
// 最初の送信の検証拒否で閉じる (H-X): bundler が最初の送信を検証で拒否した op を確認待ちに残すと、その内容の支払いが、
// 押すたびに 120 秒待ち → 同じ op の送り直し → また拒否 → 120 秒、を繰り返して払えない。なので記録を failed に閉じ、(3) で
// 終える。ただし **検証の拒否だけでは閉じない**: 拒否が示すのは「この送信が断られた」ことだけで、その op が mempool に入って
// いないことは示さない (送信が途中で 2 回届き、1 回目は受理され、重複の配送にだけ拒否が返ることがある。下の (f))。閉じてよい
// 根拠は「bundler がその hash を知らないと答えた」こと。
// 閉じるのは次が **全部** そろったときだけ (そろわなければ今までどおり復旧へ進み、(4) で終える):
//   (a) executeCirclePayment の中の、自分の最初の送信の 1 か所である (**復旧の送り直しの拒否では閉じない**: 前の送信が
//       受理されているかもしれず、送り直しへの拒否は「mempool に無い」ことの証拠にならない)
//   (b) **自分の op の記録を、自分で signed → submitting にした** (markSubmitting を呼ぶ直前に同期で読んだ記録が「signed で、
//       userOpHash が自分の今署名した op のもの」だった)。同じ key の 2 つの試み (複製したタブ) は署名を上書きし合えるので
//       (markSigned は signed からの再入・markSubmitting は submitting からの再入を許す)、記録の op が自分のものでない・別の試みが
//       先に submitting にしていたなら、記録に無い op が bundler に渡っているかもしれない。そのとき閉じると、生きている op の上に
//       新しい支払いを開ける (第 10 回レビュー Codex の指摘 1)
//   (c) 送信の分類が「検証による確定的な拒否」である (HTTP 2xx + ERC-4337 の検証の code の allowlist。Pimlico の経路と同じ
//       定義・同じ bundler。bundler の文が nonce・mempool などに触れているときは拒否と読まない = circleAccount.ts の
//       classifyCircleBroadcastError)
//   (f) **bundler にその op の状態を 1 回聞き、「その hash を知らない」(not_found) と答えた** (circleAccount.ts の
//       readCircleUserOpStatus = pimlico_getUserOperationStatus・再送なし。Pimlico の経路の c2 と同じ 1 つの定義 =
//       pimlicoSend.ts の readBundlerOpStatus)。ほかの status・型に無い値・読めない (通信の失敗・timeout・形の崩れた応答) は
//       閉じない。(c) の語に当たらない拒否 (preVerificationGas が足りない等) も、受理された op の重複の配送にだけ返ることが
//       あるため。(c) の語の確認を残す理由: status と語は別の失敗を断つ。status の記録が bundler の中で反映される前に聞いて
//       しまう場合 (受理した node と聞いた node のずれ) でも、nonce・重複の拒否は語で止まる。
//       聞くのは (d) を測る **前** (await を挟むので)。読みが遅れて (d) の上限を過ぎたら閉じない。bundler の status は最後の
//       書き込みから 1 時間で消え、その後は取り込み済みの op でも not_found を返す (pimlicoIntent.ts の冒頭)。拒否の処理が
//       遅れて再開した場合のその形も、(d) が止める (上限は 1 時間より十分短い)。
//   (d) **時間の柵**: 自分の markSubmitting から拒否の処理 ((f) の答えを受け取った後) までの経過が REJECTION_CLOSE_WINDOW_MS
//       (30 秒) 未満である (壁時計と単調な時計の両方で。下の REJECTION_CLOSE_WINDOW_MS のコメント)
//   (e) 記録がいまも submitting・userOpHash が同じ・updatedAt が自分の markSubmitting の返した値である (書く直前に同期で
//       確かめる = lib/circlePending.ts の markRejected)。確かめられるのは「読んだ時点の記録が、自分の書いたまま」だけで、
//       別のタブとの間で原子的ではない (localStorage に lock は無い)。その窓は (d) が、ほかの試みが送り直しに着く前に閉じる
// 残る前提: bundler が「その hash を知らない」と答えた op は、受理されておらず取り込まれない (Pimlico の経路の c2 と同じ前提・
// 限界は pimlicoIntent.ts の冒頭の「閉じる前に bundler へ聞く」: status の記録が bundler の中で遅れて反映される場合は、語に当たらない
// 拒否で閉じうる。受理された op が not_found 以外を返すことは実測していない)。破れたとき (閉じた op の receipt が取れた) は、
// markConfirmed が failed → confirmed に直して error の log を残す。
// 入口の scan・resume の読み取り・予約の書き込み (境界の外) が storage の失敗で投げたときは、hook の側が対応を残す (この押下は
// 記録の状態を確かめられなかった)。
//   - receipt の待ちの結果は receipt / timeout / error の 3 つ (waitReceipt)。**同じ op の送り直しへ進むのは timeout のとき
//     だけ**。error (bundler の 429・5xx・通信断) では、送り直さず・記録の時刻も書かずに確認待ちで終える。
//   - 送り直しの **前** に、記録がいまも「submitting で同じ userOpHash」であることを確かめて送る時刻を書く (markResending)。
//     確かめられなければ送り直さず、記録の今の状態に従う (followRecord)。
//   - receipt を取った後の記録の更新 (markConfirmed) が失敗しても、結果は返す (取り込まれた支払いを失敗と出さない)。
//   - confirmed の記録の結果は、receipt を 1 回だけ照会し、取れなければ理由によらず保存した値で返す (resultFromConfirmed)。
//
// 古い submitting の記録 (第 10 回レビュー H-Z): 別の key (別のタブ・タブを開き直した後) の submitting の記録を、時間の窓なしで
// 復旧すると、(筋 1) 何日も前に成立した支払いの receipt がすぐ返り、署名を 1 回も求めずに「前の支払い」を今回の成功として出す
// (偽の成功)、または (筋 2) receipt を引けない op を押すたびに 120 秒待って送り直し、そのたびに記録の時刻が進んで 7 日の掃除に
// 届かず、その内容の支払いが止まり続ける。なので、scan の snapshot にある **別の key の submitting** の記録のうち、最後に
// bundler へ渡した時刻 (updatedAt。書くのは markSubmitting と markResending だけ = どちらも渡す直前) から
// STALE_SUBMITTING_WINDOW_MS (30 分) より後のものは、scan の前に次の順で確かめる (judgeStaleSubmitting):
//   1. EntryPoint の getNonce(sender, key) を読む。この経路の nonce の key は試みごとに別 (時刻由来) なので、
//      **未使用 = その op はまだ一度も取り込まれていない** → 今までどおり同じ op を復旧する (新しい op を作ると、古い op と両方
//      成立しうる。押した時点で未使用と確かめているので、その後に取れる receipt は押した後の成立 = 今回の支払いとして正しい)。
//   2. 使用済み = その op は取り込まれた (revert を含む)。**取り込まれた時刻でもう一度判定する**: bundler へ receipt を 1 回
//      照会し、見つかれば chain の時計 (最新の block の timestamp − 取り込まれた block の timestamp。端末の時計を持ち込まない)
//      で経過を測る。経過が窓以下 → 今までどおり復旧 (前の結果を返す)。窓より前・receipt が見つからない → その記録を飛ばして
//      新しい支払いへ進む (古い confirmed と同じ扱い)。
//      取り込まれた時刻を見る理由: 1 で未使用 → 復旧の待ちが失敗して確認待ち → その直後に op が取り込まれる → すぐ押し直す、の
//      押し直しは「最後に渡してから 30 分より後・使用済み」になる。時刻を見ずに進むと、いま成立したばかりの支払いの上に 2 本目を
//      払う。
//   3. 読み取り・照会がそれ以外の理由で失敗した・記録の中身が合わない → 照合の失敗 = 確認待ち (分からないまま進まない・
//      分からないまま前の結果も返さない)。
// 順は nonce が先 (receipt を先に読むと、未使用の op の「まだ無い」と、古すぎて引けない op の「もう無い」を見分けられない)。
// 窓の意味 = 「最後に渡してから」と「取り込まれてから (分かれば)」の遅い方から 30 分。
// **記録は書かない** (confirmed に直さない): markConfirmed は updatedAt を今にするので、古い支払いの記録が「直近の confirmed」に
// なり、次の 90 秒は confirmed の枝が前の結果を返す (同じ偽の成功が別の枝から戻る)。代償: 記録は 7 日の掃除まで残り、同じ内容を
// 払うたびに照合の RPC が増える。
// 同じ key の resume (下の reserveOrResume の後) は変えない: 対応 (sessionStorage) が残っているのは、同じタブで成功を画面に
// 出していない間だけなので、その記録は「この画面の支払いの続き」(このタブが送った支払い、または、このタブが結果を受け取りに
// 行った別の key の支払い = 下の「対応の付け替え」。付け替えるのは窓の内の記録だけ)。
// 残る限界: bundler の索引が遅れる間 (取り込まれた直後で receipt をまだ返さない) の押下は「使用済み・receipt なし」で新しい
// 支払いへ進む / 'latest' の巻き戻し (使用済みと読んだ後に reorg で未使用に戻る) / 未使用のまま永久に実行されない op は、
// 押すたびに今までどおり復旧を試みて止まる / 7 日の掃除の後は記録が無いので照合もしない。
//
// 失効 (第 10 回レビュー H-V): この試みを始めた画面 (hook の instance) が外れた (unmount した) 後も、react-query の mutation は
// 走り続ける。原則は 1 つ: **失効した試みは、新しい効果を始めない** (ウォレットに署名を求めない・記録を書かない = markSigned・
// markSubmitting・abandon・bundler へ op を渡さない)。args.isAlive() を見るのは、新しい効果の直前だけ:
//   (a) 署名 1 (permit) を求める直前  (b) 署名 2 (UserOperation) を求める直前  (c) 署名 2 の後・markSigned の前
//   (d) 署名 1・署名 2 の catch (abandon の前)
//   (e) 古い submitting の記録の照合 (上の「古い submitting の記録」) の await の後・scan の前
// すでに bundler へ渡した op の後始末 (receipt 待ち・復旧の再送・markConfirmed) では見ない (渡した op は画面が無くても成立しうる)。
// attemptId の対応の付け替え (下の「対応の付け替え」) の直前でも見ない: そこに来る試みは生きている。呼び出し元 (hook の
// runCirclePayment) は失効を確かめた同じ tick でこの関数を呼び、入口から scan・付け替えまで await は無い。古い記録の照合の
// await があった押下では (e) が確かめ、(e) から scan・付け替えまで await は無い。
// 失効した試みは payment_cancelled で終わり、記録は awaiting_signature のまま残す (開き直した画面が同じ key を resume する)。
//
// 対応の付け替え (第 10 回レビュー 穴 B = H-V の scan 版): scan が **別の key の記録 R** (別のタブ・閉じたタブの支払い) の結果を
// 受け取りに行く押下は、自分の key の記録を作らない (scan は予約より前)。その途中で画面を離れる (または確認待ちで終わる) と、
// hook の attemptId の対応 (sessionStorage) は自分の attemptId のまま残り、その key には記録が無い。R はその後に確定するが、
// 成功はどの画面にも出ていない。次の押下は、記録の無い自分の key で scan に戻り、R が confirmed から 90 秒を過ぎていれば
// 「正規のリピート」とみなして 2 本目を払う。
// なので、scan が R の結果を受け取りに行く **直前 (同期・await の前)** に、args.adoptAttempt で対応を R の paymentAttemptId に
// 付け替える。次の押下は R の key を resume する (下の reserveOrResume の後): confirmed → 時間の窓なしで既払いの結果・
// submitting → 同じ op の復旧・failed → 「既に終了」(hook が対応を消し、その次の押下は新しい支払い)・記録なし (confirmed・failed の記録は
// 最後の updatedAt から 24 時間で掃除される) → 新しい支払い。画面のある試みが結果を受け取れた・ふつうの error で終わったときは、hook が今までどおり対応を消す。
// 付け替えるのは次が全部そろったときだけ:
//   - hook が対応を管理している (args.adoptAttempt が渡されている。明示の paymentAttemptId の呼び出しには渡らない)
//   - 記録が paymentAttemptId を持つ
//   - (1) submitting で、最後に bundler へ渡してから STALE_SUBMITTING_WINDOW_MS (30 分) 以内、または
//     (2) confirmed で、scan が既払いの結果を返す記録 (success が false でない・90 秒以内)
// 付け替えるのは画面のある試みだけ (失効した試みが書くと、開き直した画面の対応を横から変える)。ここでは確かめない: 上の
// 「失効」のとおり、scan に着く試みは生きている (scan と付け替えの前に await を足すときは、その後に失効の確認を足す)。
// 付け替えた対応を消すのは hook で、対応がいまもその試みの知っている attemptId (付け替えた試みは R の attemptId) を指している
// ときだけ (同じタブの別の試みが、付け替えた対応を自分の古い attemptId のつもりで消さない)。
// 付け替えない記録: 30 分より後の submitting を「未使用・取り込みが 30 分以内 → 復旧」とした記録 (付け替えると、次の押下が R の
// key の resume になり、別の key の scan にだけ効く「古い submitting の記録」の照合を通らなくなる = このタブで筋 2 (止まり
// 続ける) が戻る)・「飛ばす」「確認待ち」とした記録 (受け取りに行かない)・直近の pre-submit (op を渡していない記録)。
// 代償: (1) 対応が R に付け替わったまま残る (失効・確認待ち) と、このタブで同じ内容を意図してもう一度払うとき、最初の 1 回は
// R の結果が出る (署名なし。そこで hook が対応を消すので、もう一度押せば新しい支払い)。(2) R が永久に取り込まれない op だと、
// このタブではその内容が確認待ちのまま (タブを閉じるまで。R を送った元のタブと同じ扱い)。
// 残る限界: 30 分より後の記録を復旧する押下 (付け替えない) の途中で画面を離れ、その間に op が確定した場合は、今までどおり
// (対応は自分の attemptId のまま。90 秒より後の次の押下は新しい支払い)。
//
// 対応を保存できていない押下 (第 10 回レビューの後追い r10-ss): hook が attemptId の対応 (sessionStorage) を保存できなかった
// 押下 (読めない・書けない・書いても残らない端末) は、args.mappingSaved に false を渡す。その押下の paymentAttemptId は、保存して
// いない、押すたびに変わる id。**そのまま新しい支払いを送ると**、確認待ちで終わった後の押下が別の key になり、裏で確定した
// 前の支払い (90 秒より前の confirmed) を「正規のリピート」とみなして 2 本目の署名を求める。なので、**新しい記録を予約する
// 直前 (下の scan の loop を抜けた後・reserveOrResume の前) で止める** (CircleAttemptMappingUnavailableError)。
// 止める所より前に、新しい記録の書き込み・署名・送信は無い。scan の中の動きは、対応を保存できていない押下でも変えない:
// 既にある支払いの結果を返す (直近の confirmed)・復旧する (submitting)・確認待ち (確かめられない記録・直近の pre-submit)・
// 古い pre-submit の abandon・入口の掃除。**入口では止めない**: 既にある支払いの復旧まで止めると、取り出せる結果を失う
// (対応を保存した後に sessionStorage を読めなくなった端末で、送った支払いの結果を受け取れなくなる)。
// scan の枝の付け替え (adopt) も今までどおり呼ぶ。hook は書き込みを試すが、この押下では、書けても false を返す (getItem だけが
// throw し setItem は通る端末では、書けても次の押下はその対応を読めず、resume ではなく scan から入る)。なので、その復旧の
// 確認待ちは (e) になる ((a) の「このタブでもう一度押すと、まず同じ支払いの結果を確かめ直します」は言えない)。ここ (circleSend)
// の規則は今までどおり「hook の関数が true を返したら (a)・false なら (e)」で、mappingSaved は見ない。
// 止まった押下に、hook は対応の破棄 (clearStableAttemptId) をせず、error をそのまま投げる (hooks/useBatchPayment.ts の
// runCirclePayment)。error は場面 (f) の符号 (circleCode: 'mapping_unavailable') を持ち、フォームが赤い枠に locale の文を出す。
// **送信は閉じない** (押せなくする flag を立てない): 止まった後に復旧できるようになる支払いがある。例: 最後に渡してから
// 30 分より後の submitting の記録で、nonce は使用済みだが bundler がまだ receipt を返さない間は、scan は飛ばす (上の「古い
// submitting の記録」の 2) ので、ここで止まる。その後 receipt が引けるようになれば (取り込みが 30 分以内)、次の押下の scan が
// 元の支払いの結果を返す。押せなくすると、その結果を、この画面から受け取れなくなる。
// 省略・true の呼び出し (hook は、明示の paymentAttemptId の押下に true を渡す) は今までどおり。
//
// useBatchPayment の circle 分岐がこの executeCirclePayment を呼ぶ。permitAmount の
// 算定 (gas 実費 + per-chain surcharge) は chunk 5 (useGasQuoteCircle) が担い、ここへは
// 確定値が渡る (本 module は fee ポリシーを持たない)。

import { keccak256, type Address, type Hex } from 'viem';
import {
  entryPoint08Address,
  WaitForUserOperationReceiptTimeoutError,
} from 'viem/account-abstraction';
import { getBlock } from 'viem/actions';
import { getAction } from 'viem/utils';
import {
  broadcastCircleUserOp,
  prepareAndSignCircleUserOp,
  prepareCircleBroadcast,
  readCircleUserOpStatus,
  signUsdcPermit,
  waitForCircleReceipt,
  type BatchCall,
  type CircleBroadcastError,
  type CircleSmartAccountBundle,
  type SignedCircleUserOp,
} from '@/lib/smartAccount/circleAccount';
import {
  findUserOperationReceipt,
  isUserOpNonceConsumed,
} from '@/lib/smartAccount/pimlicoSend';
import type { ConnectedWalletClient } from '@/lib/smartAccount/simpleAccount';
import {
  abandon,
  computeCallHash,
  computeIdempotencyKey,
  findLiveByCallHash,
  gcStalePreSubmit,
  loadPendingRecord,
  markAwaitingSignature,
  markConfirmed,
  markRejected,
  markResending,
  markSigned,
  markSubmitting,
  PendingStateError,
  pruneStaleSubmitting,
  pruneTerminal,
  reserveOrResume,
  type PendingRecord,
  type PendingStatus,
} from '@/lib/circlePending';
import type { CircleErrorCode } from '@/lib/circleErrorKey';
import { logger } from '@/lib/logger';
import type { PublicClient } from 'viem';

// pre-submit (reserved/awaiting_signature/signed) record をどれだけ「進行中」とみなすか。
// これを超えて更新されていない pre-submit は reload で見捨てられた orphan とみなし、
// cross-invocation ガードで block せず abandon して掃除する (恒久ブロック防止)。署名 popup を
// 2 つ跨いでも通常は数秒〜数十秒なので 3 分は十分長い安全側。
const PRE_SUBMIT_STALE_MS = 3 * 60 * 1000;

// 同一 callHash の confirmed record をどれだけ「偶発二重決済」とみなして抑止するか。
// この窓内の再決済 (reload/再クリック) は既支払い結果を返して新規 broadcast しない。窓を
// 過ぎた同額再決済は **正規のリピート購入** (例: 同じ店で同額を再度) とみなし通す
// (callHash は paymentAttemptId 非依存なので、窓が無いと正規リピートを恒久抑止してしまう)。
const CONFIRMED_DEDUP_WINDOW_MS = 90 * 1000;

// 終端 record (confirmed/failed/abandoned) を localStorage に保持する期間。これを過ぎたら
// pruneTerminal が物理削除する。CONFIRMED_DEDUP_WINDOW_MS (90s) を十分上回る必要がある
// (confirmed を消す前に偶発二重決済の dedup 窓を確実に過ぎさせる)。
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

// submitting のまま放置された孤児 record を物理削除するまでの期間。broadcast 直後に reload →
// 同一 callHash を二度と起動しないと、submitting record は gcStalePreSubmit (pre-submit のみ) にも
// pruneTerminal (terminal のみ) にも該当せず永久残留する (緩慢リーク)。基準は最後に bundler へ渡した時刻 (updatedAt)。
// 消した後の同じ内容の押下は、記録が無いので新しい支払いになる (nonce の照合もしない)。「7 日たった op はもう取り込まれない」
// という根拠は無い (op に期限は無い): 容量の回収のための線で、7 日より前に渡した op が未使用のまま残っていて、消した後に
// 取り込まれると、新しい支払いと両方成立しうる (冒頭の「古い submitting の記録」の残る限界)。
const SUBMITTING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 別の key の submitting の記録を、EntryPoint の nonce を読まずに復旧してよい、最後に bundler へ渡した時刻 (updatedAt) からの
 * 経過の上限。取り込まれた op について、取り込まれた時刻からの経過の上限にも使う (冒頭の「古い submitting の記録」)。
 * **ちょうど 30 分は窓の内** (今までどおり復旧)。
 *
 * 30 分は user の裁定 (2026-11-12)。server の受注通知が「30 分以内の tx」を今回の注文の支払いとして受ける線
 * (app/api/order/notify) とそろえた値。窓ごとに失うもの:
 *   - 窓の内: 同じ内容 (同じ店・同じ額・同じウォレット・同じ chain) の **別の購入** を別のタブから押しても、前の支払いの結果が
 *     出る (署名なし)。成功を画面に出す前にタブが閉じた支払いの記録が残っている間だけ。
 *   - 窓の外: 前の支払いが成立していたのに、その成功をどの画面でも見ていない人が、同じ内容を **押し直す** と、新しい支払いに
 *     なる (2 本目)。
 * 短くすると後者 (知らずに払う 2 本目) が増え、長くすると前者 (偽の成功) が増える。 */
export const STALE_SUBMITTING_WINDOW_MS = 30 * 60 * 1000;

// gcStalePreSubmit が pre-submit 孤児を「確実に死んでいる」とみなす閾値。
// **PRE_SUBMIT_STALE_MS (3分) より遥かに長くする**こと。理由: GC は全 callHash 横断で
// 走るため、別タブの正規だが低速な署名 (wallet popup を数分開けっ放し等) を 3分閾値で
// 巻き込むと、その attempt の markSigned CAS が失敗し決済が壊れる (二重決済ではないが UX 破壊)。
// 同一 callHash の「並行中だから新規を block するか」判断は guard が PRE_SUBMIT_STALE_MS で行い、
// GC は純粋に容量管理 (どんな低速署名も到達しない長さ = 1時間) に限定して干渉を避ける。
const PRE_SUBMIT_GC_MS = 60 * 60 * 1000;

/** 自分の最初の送信の検証拒否で記録を閉じてよい、自分の markSubmitting からの経過の上限 (冒頭の「最初の送信の検証拒否で
 * 閉じる」の (d) = 時間の柵)。
 *
 * 何の波及を断つか: 拒否の処理が遅れている間 (タブの停止・端末のスリープなど) に、ほかの試みがこの op を送り直して受理されたのに、
 * それを知らずに failed にして新しい支払いを開けること (第 10 回レビュー Codex の指摘 2・3)。記録の確認 (markRejected の updatedAt)
 * だけでは防げない: localStorage の読み → 比べる → 書くは別のタブと原子的でなく、#1079 より前のコードのタブは送り直しの **後** に
 * 時刻を書く。
 *
 * 根拠 (コードで確かめた事実): ほかの試みがこの op を bundler に渡すのは、復旧 (recoverSubmitting) の「submitting の記録を
 * 読む → receipt を待つ → **待ちが timeout** → 送り直しの前の確認 (markResending) → 送る」の順だけ (#1079 より前のコードも、
 * 待ちが timeout したときだけ送り直す。待ちが error のときは送り直さずに投げる)。待ちは viem の waitForUserOperationReceipt で、
 * timeout は circleAccount.ts の CIRCLE_RECEIPT_TIMEOUT_MS (120 秒・viem の既定と同じ値を明示して渡す)。記録が submitting に
 * なるのは自分の markSubmitting から (閉じる条件の (b) で、その直前は signed だったことを確かめる)。なので、ほかの試みの送り直しは、
 * 自分の markSubmitting から 120 秒より前には起きない。上限はその半分以下にし (テストで固定)、拒否の処理をその前に終える。
 * 「読んでから 120 秒」ではない: viem は同じ client・同じ hash の待ちを 1 つの観測にまとめるので、後から待ちに入った試みは、先に
 * 始まった待ちの残り時間で timeout する (読んでから 1 秒で送り直すこともある)。それでも、いちばん早い待ちが始まるのは記録が
 * submitting になった後なので、下限は自分の markSubmitting から 120 秒のまま。
 * 送信の HTTP の timeout は viem の http transport の既定 10 秒 (bundle の transport に timeout を渡していない) なので、タブが
 * 動いていれば拒否はふつう 30 秒より前に届く。閉じる前の status の照会 (冒頭の (f)・同じ timeout・再送なし) を足しても、
 * 最長で 20 秒。経過は status の答えを受け取った後に測るので、照会が遅れて上限を過ぎたら閉じない。
 *
 * 経過は 2 つの時計で測り、**どちらかが上限以上、または壁時計の経過が負なら閉じない**: 壁時計 (now = Date.now) は端末の時計の
 * 変更で戻る・進む。単調な時計 (performance.now) は戻らないが、実装によっては端末のスリープの間は進まない。片方だけでは、どちらかの
 * 場合に「経過が短い」と誤って閉じる。 */
export const REJECTION_CLOSE_WINDOW_MS = 30 * 1000;

// cross-invocation ガードの処理優先度。confirmed/submitting を pre-submit より先に評価し、
// stale でない pre-submit が confirmed/submitting を CirclePendingError で masked するのを防ぐ。
function statusRank(s: PendingStatus): number {
  switch (s) {
    case 'confirmed':
      return 0;
    case 'submitting':
      return 1;
    case 'signed':
      return 2;
    case 'awaiting_signature':
      return 3;
    case 'reserved':
      return 4;
    default:
      return 9; // failed/abandoned は findLiveByCallHash で除外済 (安全側)
  }
}

export type CirclePaymentResult = {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  /** UserOp が消費した native gas (wei)。Circle (erc20) では reconciliation に使わないが
   * 形を pimlico 経路と揃える。recovery (poll) 経由で不明なときは 0n。 */
  actualGasCost: bigint;
};

// 場面の符号と文 (第 10 回レビュー PR-39c)。下の 4 つの class は、どの場面の error かを own property `circleCode` に持つ。
// 3 つのフォームは class も name も見ず、この符号から locale の文 (messages の CircleErrors) を出す (lib/circleErrorKey.ts)。
// message にも日本語の文を残す: message は i18n を通らない出口にも出る (履歴に保存する error の文・payment log・Sentry)。
// 符号だけにすると、履歴の画面に符号がそのまま出る。同じ文が messages/ja.json の CircleErrors にもあるので、ずれは
// tests/lib/circleErrorKey.test.ts と tests/lib/smartAccount/circleSend.test.ts が止める。
const CIRCLE_ERROR_JA = {
  unconfirmed:
    'USDC ガスレスの支払いを送信しましたが、結果をまだ確認できていません。' +
    '24 時間以内にこのタブで同じ内容のままもう一度押すと、まず同じ支払いの結果を確かめ直します。' +
    'それより後は、新しい支払いとして署名を求める場合があります。' +
    '確かめられるまで、ほかの方法で払い直さないでください。',
  busy_elsewhere:
    '同じ内容の支払いが、別のタブまたは画面で進行中のため、ここでは始めていません。' +
    'そちらで支払いを終えた場合は、ここでは押さないでください。' +
    'そちらを閉じた場合は、数分後にここから支払えます。',
  attempt_ended:
    'この支払いの試みは既に終了しています。この試みでは送金していません。' +
    'もう一度押すと、新しい支払いとして始めます。',
  send_rejected:
    'USDC ガスレスの支払いは、送信の受付で断られました。この支払いは送金されていません。' +
    '残高が足りないなどの理由が考えられます。もう一度お試しください (署名からやり直します)。',
  unconfirmed_earlier:
    '同じ内容の支払いを以前に送信した記録があり、その結果をまだ確認できていません。' +
    'ここでは新しい支払いを始めていません。' +
    'もう一度押すと確かめ直しますが、署名を求められた場合は新しい支払いになります。' +
    '二重に払わないよう、署名の前にウォレットの履歴で以前の支払いを確かめてください。',
  // (f) の文は案 (user の承認待ち・2026-11-13)。「次に押すと◯◯します」とは書かない: 次の押下が何をするかは、その時点の
  // 記録で変わる (既にある支払いを復旧できれば結果を返し、できなければ、また新しい支払いの直前で止まる)。
  mapping_unavailable:
    'この端末では支払いの記録を保存できないため、USDC ガスレスの新しい支払いを始めていません (この押下では送金していません)。' +
    '同じ内容の支払いを以前に送っていた場合は、先にウォレットの履歴で確かめてください。' +
    '新しく支払うには、ブラウザの設定 (サイトのデータの保存) を確かめるか、別のブラウザでお試しください。',
} as const satisfies Record<CircleErrorCode, string>;

/** 確認待ち。**失敗ではない**。場面は 3 つ (reason)。(a) と (e) の違いは、**(a) の文の約束 (24 時間以内にこのタブで同じ内容の
 * ままもう一度押すと、まず同じ支払いの結果を確かめ直す) が、その出口で言えるか**:
 * - 'unconfirmed' (a・既定): op を bundler に渡した (渡したかもしれない) が、結果を確かめられなかった。op は後で included
 *   しうる。(a) を名乗ってよい出口は、次の 2 つが両方言える所だけ:
 *     1. hook の attemptId の対応が、その op の記録の key を指している (自分の key の記録、または scan が付け替えて、hook が
 *        対応を **書けた** 記録。hook は、最初の対応を保存できていない押下では、書けても「書けた」と返さない = 下の続き)。
 *        次の押下は、その記録を resume して同じ op の結果を確かめ直す。
 *        自分の key の記録について、hook の対応そのものが保存されているか: 最初の対応の保存 (lib/circlePending.ts の
 *        stableAttemptId) が sessionStorage の失敗で保存できなかった押下は、hook が mappingSaved: false を渡し、新しい記録を
 *        予約する直前で止まる (冒頭の「対応を保存できていない押下」・第 10 回レビューの後追い r10-ss)。なので、hook が対応を
 *        管理する押下が自分の key に作る記録の paymentAttemptId は、その押下の入口で対応に保存されていた値。保存できて
 *        いない押下が scan で別の key の記録を復旧して確認待ちで終わるときは、(e) になる (下の (e) の 1 つ目の枝): hook の
 *        adoptAttempt は、その押下では、付け替えを書けても false を返す。getItem だけが throw し setItem は通る端末では、
 *        付け替えは書けるが、次の押下はその対応を読めず、resume ではなく scan から入るので、(a) の約束は言えない。
 *        明示の paymentAttemptId の呼び出し (対応を使わない・本番の 3 フォームには無い) は、今までどおり確かめない。
 *     2. その記録が、**確認待ちで出る時点から** 24 時間は残る。確定した記録 (confirmed) は最後の updatedAt から 24 時間で
 *        掃除され (TERMINAL_RETENTION_MS)、submitting のままの記録は 7 日で掃除される (SUBMITTING_RETENTION_MS)。なので、
 *        submitting の記録は、最後に書いてから 6 日以内 (= 残りの寿命が 24 時間以上) であること。この押下が自分で op を渡した
 *        記録・scan が付け替える記録 (30 分以内) は、書いたばかりなので当たる。古い自分の key の記録の resume は、下の (e)。
 *   文の「24 時間」と掃除の期間のずれは tests/lib/smartAccount/circleSend.adoptAttempt.test.ts が止める。
 * - 'unconfirmed_earlier' (e): 以前に送った支払いの記録の結果を確かめられず、上の 1 か 2 が言えない出口。この押下は新しい
 *   支払いを始めていない (復旧は、保存した同じ op を待つ・送り直すだけ)。出口は executeCirclePayment の 2 つの枝:
 *     - scan の submitting の枝 (別のタブ・閉じたタブが以前に送った支払い) で、**対応をその記録に付け替えられなかった**
 *       (30 分の窓の外・確かめられない記録・記録に paymentAttemptId が無い・hook が対応を管理していない・hook が対応を
 *       書けなかった・hook が最初の対応を保存できていない押下 = 付け替えを書けても、次の押下が読めると言えない)。
 *       対応は自分の attemptId のままで (最初の対応を保存できていない押下では、対応が無い・読めない、または付け替えた値を
 *       次の押下が読めると言えない)、この押下は自分の記録を作らない (scan は予約より前) ので、次の押下は
 *       また scan から入る。その間に前の支払いが確定して 90 秒を過ぎていれば、次の押下は新しい支払いに署名を求める (冒頭の
 *       「対応の付け替え」の「残る限界」)。
 *     - 自分の key の resume の submitting の枝で、**確認待ちで出る時点で、入口で読んだ記録が、最後に書いてから 6 日より後**
 *       (残りの寿命が 24 時間より短い)。24 時間以内の次の押下でも、記録が掃除されていれば新しい支払いに署名を求める。
 *   どちらも (a) の「24 時間以内に…まず同じ支払いの結果を確かめ直します」とは言わない。
 * - 'busy_elsewhere' (b): 別の試み (別のタブ・画面) が署名の途中なので、この押下は何も始めなかった (scan の直近の
 *   pre-submit の 1 か所だけ)。
 * 文は「再読み込みしても二重決済にならない」と約束しない: 30 分より前の支払いについては成り立たない場合がある (冒頭の
 * 「古い submitting の記録」と、その「残る限界」)。 */
export class CirclePendingError extends Error {
  /** 確認待ち op の hash。pre-submit (まだ未署名/未 broadcast の別 attempt 検出) では undefined。 */
  readonly userOpHash?: Hex;
  /** 場面の符号 (上の「場面の符号と文」)。 */
  readonly circleCode: CircleErrorCode;
  constructor(
    userOpHash?: Hex,
    reason: 'unconfirmed' | 'busy_elsewhere' | 'unconfirmed_earlier' = 'unconfirmed',
  ) {
    super(CIRCLE_ERROR_JA[reason]);
    this.name = 'CirclePendingError';
    this.userOpHash = userOpHash;
    this.circleCode = reason;
  }
}

/** 自分の最初の送信を bundler が検証で拒否し、bundler がその op の hash を知らないと答えたので、記録を閉じた (冒頭の (3))。
 * **確認待ちではない**: name を 'CirclePendingError' にしない (hook は attemptId の対応を消し、次の押下は新しい支払い =
 * 署名からやり直す)。文は固定 (bundler・viem の生の文 = AA33… や request の本文を画面に出さない)。 */
export class CircleSendRejectedError extends Error {
  /** 断られた op の hash (監査用)。 */
  readonly userOpHash: Hex;
  /** 場面の符号 (上の「場面の符号と文」)。 */
  readonly circleCode: CircleErrorCode = 'send_rejected';
  constructor(userOpHash: Hex) {
    super(CIRCLE_ERROR_JA.send_rejected);
    this.name = 'CircleSendRejectedError';
    this.userOpHash = userOpHash;
  }
}

/** attemptId の対応を保存できていない押下 (args.mappingSaved が false) が、新しい記録を予約する所まで来たので止めた (冒頭の
 * 「対応を保存できていない押下」)。場面 (f)。この押下は、新しい記録の書き込み・署名・送信を何も始めていない。
 * **確認待ちではない**: name を 'CirclePendingError' にしない。hook (useBatchPayment の runCirclePayment) は、この name では
 * attemptId の対応を消さず、error をそのまま投げる。フォームは符号から locale の文を赤い枠に出し、送信は閉じない
 * (次の押下も scan から入り、既にある支払いを復旧できるようになっていれば結果を受け取る)。 */
export class CircleAttemptMappingUnavailableError extends Error {
  /** 場面の符号 (上の「場面の符号と文」)。 */
  readonly circleCode: CircleErrorCode = 'mapping_unavailable';
  constructor() {
    super(CIRCLE_ERROR_JA.mapping_unavailable);
    this.name = 'CircleAttemptMappingUnavailableError';
  }
}

type Receipt = Awaited<ReturnType<typeof waitForCircleReceipt>>;

function toResult(userOpHash: Hex, receipt: Receipt): CirclePaymentResult {
  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    blockNumber: receipt.receipt.blockNumber,
    success: receipt.success,
    actualGasCost: receipt.actualGasCost,
  };
}

// まだ bundler に op を渡していない試みが、終わった記録 (failed / abandoned / 記録なし) に当たったときの error。送った後の
// 境界 (inPostSubmit) を素通しする: hook が attemptId の対応を消し、次の押下は新しい支払い (署名から) になる。
// name は 'Error' のまま (hook から見て、今までの new Error と同じ)。class にするのは境界が見分けるためと、フォームが場面を
// 見分ける符号 (circleCode) を持たせるため。
class AttemptEndedError extends Error {
  /** 場面の符号 (上の「場面の符号と文」)。 */
  readonly circleCode: CircleErrorCode = 'attempt_ended';
}

function attemptEnded(): AttemptEndedError {
  return new AttemptEndedError(CIRCLE_ERROR_JA.attempt_ended);
}

// receipt の待ちの結果。timeout = 待ち切ったがまだ無い (op は mempool に無いかもしれない)・error = 待ちそのものの失敗
// (bundler の 429・5xx・通信断。receipt があるか無いかは分からない)。
type WaitOutcome =
  | { kind: 'receipt'; receipt: Receipt }
  | { kind: 'timeout' }
  | { kind: 'error' };

// waitForUserOperationReceipt を待ち、結果を 3 つに分ける。**投げない**: ここは必ず bundler に op を渡した (かもしれない) 後に
// 呼ばれる。待ちの失敗をそのまま投げると、ふつうの error として hook が attemptId の対応を消す (冒頭の「送った後の終わり方」)。
// 呼び出し側は、timeout のときだけ同じ op の送り直しへ進み、error では送り直さずに確認待ちで終える。
async function waitReceipt(
  bundle: CircleSmartAccountBundle,
  hash: Hex,
): Promise<WaitOutcome> {
  try {
    return { kind: 'receipt', receipt: await waitForCircleReceipt({ bundle, hash }) };
  } catch (error) {
    if (error instanceof WaitForUserOperationReceiptTimeoutError) {
      return { kind: 'timeout' };
    }
    logger.warn('circle.wait.failed', {
      userOpHash: hash,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'error' };
  }
}

// receipt を取った後の記録の更新 (submitting → confirmed)。**失敗しても結果は返す**: receipt がある = この op は取り込まれた、が
// 真実で、記録を書けない (記録が消えた・別の op の記録に替わった・storage が書けない) ことを理由に「失敗」と出すと、
// 払えているのに hook が対応を消し、次の押下が 2 本目になる。握りつぶさない: error の log を残す。記録が submitting のまま
// 残っても、次の押下が同じ op を復旧して同じ結果を返す。
function confirmAndResult(args: {
  key: string;
  sender: Address;
  userOpHash: Hex;
  receipt: Receipt;
  now: () => number;
}): CirclePaymentResult {
  const { key, sender, userOpHash, receipt, now } = args;
  try {
    markConfirmed({
      key,
      sender,
      userOpHash,
      txHash: receipt.receipt.transactionHash,
      success: receipt.success,
      now: now(),
    });
  } catch (error) {
    logger.error('circle.confirm.record-failed', {
      userOpHash,
      txHash: receipt.receipt.transactionHash,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return toResult(userOpHash, receipt);
}

// 送った後の境界 (冒頭の「送った後の終わり方」)。自分の markSubmitting が返った後の区間と、submitting の記録を扱う枝 (scan・
// resume の submitting・markSigned の CAS が外れた後の「記録に従う」) を包み、想定していない throw (storage の読み書き・記録の
// sender の不一致・RPC) を CirclePendingError に変える。confirmed の記録の枝 (scan・resume) は包まない: resultFromConfirmed が
// 照会の失敗を全部受けるので、投げる処理が無い。
// 何の波及を断つか: op を bundler に渡したかもしれない後の付帯の失敗がふつうの error になり、hook が attemptId の対応を消して、
// 後から確定した支払いの後に 2 本目が開くこと。確認待ちは「分からない」の正直な表示で、成功にはしない。握りつぶさない:
// 元の error は専用の key で error の log に残す。
// 素通しするのは、結果・CirclePendingError・AttemptEndedError (まだ渡していない試みの「既に終了」)・CircleSendRejectedError
// (最初の送信の検証拒否で記録を閉じた) だけ。
// userOpHash は確認待ちの op の hash (分からない場面では undefined)。
async function inPostSubmit<T>(
  userOpHash: Hex | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof CirclePendingError ||
      error instanceof AttemptEndedError ||
      error instanceof CircleSendRejectedError
    ) {
      throw error;
    }
    logger.error('circle.post_submit.unexpected', {
      userOpHash,
      error: error instanceof Error ? error : String(error),
    });
    throw new CirclePendingError(userOpHash);
  }
}

// 枝の出口で、確認待ち (CirclePendingError) の場面の符号を (e) 'unconfirmed_earlier' に付け直す (CirclePendingError の上の
// コメント)。promiseHolds() = その枝の記録について、(a) の文の約束 (24 時間以内の次の押下が、同じ支払いの結果を確かめ直す) が
// 言えるか。言えるなら何も変えない。言えないなら、run の中から出る確認待ち (枝の中の throw・recoverSubmitting → followRecord の
// 中の throw・inPostSubmit が想定外の throw を変えたもの) を、出口のここ 1 か所で受けて (e) にする。
// promiseHolds は **確認待ちで出る時点** (ここで確認待ちを受けた時) に 1 回だけ呼ぶ: 約束の「24 時間」は画面に文が出る時から
// 数えるので、復旧の待ち (最大 120 秒 × 2) にかかった時間を入れて判定する。結果・ほかの error で出るときは呼ばない。
// 変えるのは符号と文だけ: class・name・userOpHash は同じで、結果と、確認待ち以外の error はそのまま通す。
async function earlierUnless<T>(promiseHolds: () => boolean, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CirclePendingError && !promiseHolds()) {
      throw new CirclePendingError(error.userOpHash, 'unconfirmed_earlier');
    }
    throw error;
  }
}

// 送信の error が「検証による確定的な拒否」(冒頭の「最初の送信の検証拒否で閉じる」の (c)) なら、その error を返す。
// circleAccount が投げる CircleBroadcastError の kind を読む。それ以外 (already-known・unknown・分類の無い error) は null =
// 閉じない側。
// class の同一性 (instanceof) でなく name で見る: hook が CirclePendingError を見るのと同じ形で、circleAccount を境界として
// 差し替える test でも、本物の class の instance をそのまま通せる。
function validationRejectionOf(error: unknown): CircleBroadcastError | null {
  const candidate = error as Partial<CircleBroadcastError> | null;
  return candidate?.name === 'CircleBroadcastError' && candidate.kind === 'validation-rejected'
    ? (candidate as CircleBroadcastError)
    : null;
}

// 16 進の長い連なり (41 桁以上・0x の有無を問わない) を伏せ字にする。アドレス (40 桁) は残り、署名 (65 byte = 130 桁)・
// paymasterData・hash は伏せる。何の波及を断つか: bundler の JSON-RPC の error の message は信頼できない外の文で、送った
// 署名を写して返すことがある (例「AA33 invalid signature 0x…」)。それを記録 (localStorage) と log (warn = Sentry へ送られる) に
// そのまま入れないため。bundler の code と、AA33 などの理由の語は残る。
export function redactLongHex(text: string): string {
  return text.replace(/(?:0x)?[0-9a-f]{41,}/gi, '[redacted]');
}

// 自分の最初の送信の、閉じる資格の印 (冒頭の「最初の送信の検証拒否で閉じる」の (b) と、(d) の起点)。null = 資格が無い (自分の
// op の記録を自分で signed → submitting にしたのではない)。
type FirstSendMark = {
  /** 自分の markSubmitting が返した記録の updatedAt (壁時計)。 */
  submittedAt: number;
  /** 自分の markSubmitting を呼ぶ直前の単調な時計の値。 */
  submittedAtMono: number;
};

// 自分の最初の送信が検証で拒否されたとき、記録を failed に閉じる (冒頭の「最初の送信の検証拒否で閉じる」の (b)(f)(d)(e))。閉じられたら
// true。閉じる資格が無い (b)・bundler がその hash を「知らない」と答えなかった (f: ほかの status・読めない)・遅れて届いた (d)・
// 記録がもう「自分が submitting にしたまま」でない (e: ほかの試みが確定させた・送り直した・別の op の記録に替わった・消えた) ときは
// false = 閉じない (呼び出し側は今までどおり復旧へ進む)。storage の失敗は投げる (送った後の境界が確認待ちに変える)。
// 記録と log に残す文は bundler の code と、伏せ字にした bundler の文だけ (viem の error の message は、署名済みの op と URL を
// 含むので入れない)。
async function closeRejectedFirstSend(args: {
  bundle: CircleSmartAccountBundle;
  key: string;
  sender: Address;
  userOpHash: Hex;
  firstSend: FirstSendMark | null;
  rejection: CircleBroadcastError;
  now: () => number;
  monotonicNow: () => number;
}): Promise<boolean> {
  const { bundle, key, sender, userOpHash, firstSend, rejection, now, monotonicNow } = args;
  if (!firstSend) {
    logger.warn('circle.broadcast.rejected-not-closed', {
      userOpHash,
      code: rejection.code,
      reason: 'not-own-submit',
    });
    return false;
  }
  // (f) bundler にその op の状態を聞く。「知らない」(not_found) と答えたときだけ先へ進む。何の波及を断つか: 送信が途中で 2 回
  // 届き、1 回目は受理されたのに、重複の配送への拒否 (語に当たらないもの = preVerificationGas が足りない等) で記録を閉じて、
  // 取り込まれる op の上に新しい支払いを開けること。この await は (d) を測る前に置く。
  const status = await readCircleUserOpStatus(bundle, userOpHash);
  if (!status.unknownToBundler) {
    logger.warn('circle.broadcast.rejected-not-closed', {
      userOpHash,
      code: rejection.code,
      reason: 'status',
      status: status.status,
    });
    return false;
  }
  // (d) 時間の柵。(f) の答えを受け取った後に測り、下の markRejected まで await を挟まない (測った後に遅れる隙間を作らない)。
  const at = now();
  const wallElapsedMs = at - firstSend.submittedAt;
  const monoElapsedMs = monotonicNow() - firstSend.submittedAtMono;
  if (
    wallElapsedMs < 0 ||
    wallElapsedMs >= REJECTION_CLOSE_WINDOW_MS ||
    monoElapsedMs >= REJECTION_CLOSE_WINDOW_MS
  ) {
    logger.warn('circle.broadcast.rejected-not-closed', {
      userOpHash,
      code: rejection.code,
      reason: 'late',
      wallElapsedMs,
      monoElapsedMs,
    });
    return false;
  }
  const details = rejection.details === undefined ? undefined : redactLongHex(rejection.details);
  try {
    markRejected({
      key,
      sender,
      userOpHash,
      submittedAt: firstSend.submittedAt,
      errorMessage: `bundler rejected (code ${rejection.code}): ${details ?? ''}`,
      now: at,
    });
  } catch (error) {
    if (!(error instanceof PendingStateError)) throw error;
    logger.warn('circle.broadcast.rejected-not-closed', {
      userOpHash,
      code: rejection.code,
      reason: 'record-changed',
      detail: error.message,
    });
    return false;
  }
  // 監査用: 閉じた op の hash と、bundler の拒否の code・文 (伏せ字にしたもの)。
  logger.warn('circle.broadcast.rejected', {
    userOpHash,
    code: rejection.code,
    details,
  });
  return true;
}

// 古い submitting の記録の照合の結果 (冒頭の「古い submitting の記録」)。scan は、結果の無い記録を今までどおり復旧する。
//   spent      = nonce は使用済みで、取り込みは窓より前 (または receipt が見つからない) → 飛ばして新しい支払いへ
//   unverified = 確かめられなかった → 確認待ち
type StaleVerdict = 'spent' | 'unverified';

// 照合した記録の版。scan は照合の await の後に記録を読み直すので、その間に別のタブが進めた記録 (送り直して時刻を書いた・
// confirmed にした・別の op の記録に替わった) に、古い照合の結果を当てない。updatedAt まで含めるのは、scan のほかの枝
// (時刻で分ける) と扱いをそろえるため。
function recordVersion(rec: PendingRecord): string {
  return `${rec.key}|${rec.userOpHash ?? ''}|${rec.updatedAt}`;
}

const NONCE_HEX_RE = /^0x[0-9a-fA-F]+$/;

// 記録の署名済み op から、照合に使う nonce を読む。読めるのは、op の sender が記録の sender で、nonce が 16 進の数のときだけ。
// 何の波及を断つか: localStorage の記録は、この module が書いた形のままとは限らない (古い版・壊れた値)。別の account の nonce や
// 壊れた nonce で EntryPoint を読むと「使用済み」「未使用」を取り違え、成立しうる op の上に新しい支払いを開ける。読めなければ
// 照合の失敗 (確認待ち) にする。
function storedOpNonce(rec: PendingRecord): bigint | null {
  const op = rec.signedUserOp;
  if (!op || !rec.userOpHash) return null;
  const { sender, nonce } = op;
  if (typeof sender !== 'string' || sender.toLowerCase() !== rec.sender.toLowerCase()) return null;
  if (typeof nonce !== 'string' || !NONCE_HEX_RE.test(nonce)) return null;
  return BigInt(nonce);
}

// 最後に渡してから窓より後の、別の key の submitting の記録を 1 件照合する (冒頭の「古い submitting の記録」の 1〜3)。
// null = 今までどおり復旧する (未使用・または取り込みが窓の内)。**投げない・記録を書かない**: 結果は scan がその記録に着いた
// ときに使う (照合の失敗をここで投げると、scan が先に見る直近の confirmed の結果より前に確認待ちで終わる)。
// at は、この押下で窓を測った時刻 (log の経過用)。
async function judgeStaleSubmitting(args: {
  bundle: CircleSmartAccountBundle;
  rec: PendingRecord;
  at: number;
}): Promise<StaleVerdict | null> {
  const { bundle, rec, at } = args;
  const sinceHandoffMs = at - rec.updatedAt;
  const nonce = storedOpNonce(rec);
  if (nonce === null || !rec.userOpHash) {
    logger.warn('circle.stale_submitting.unverified', {
      userOpHash: rec.userOpHash,
      sinceHandoffMs,
      step: 'record',
    });
    return 'unverified';
  }
  const userOpHash = rec.userOpHash;
  // account を作ったときの chain の client (= bundle.chainId の publicClient)。記録の chain は scan が bundle.chainId に絞る。
  const client = bundle.account.client;
  let step: 'nonce' | 'receipt' | 'block' = 'nonce';
  try {
    const consumed = await isUserOpNonceConsumed({
      client,
      entryPoint: entryPoint08Address,
      sender: rec.sender,
      nonce,
    });
    if (!consumed) {
      logger.info('circle.stale_submitting.recover', { userOpHash, sinceHandoffMs, reason: 'nonce-unused' });
      return null;
    }
    step = 'receipt';
    const found = await findUserOperationReceipt(bundle.bundlerClient, [userOpHash]);
    if (!found) {
      logger.warn('circle.stale_submitting.proceed', { userOpHash, sinceHandoffMs, receiptFound: false });
      return 'spent';
    }
    step = 'block';
    const readBlock = getAction(client, getBlock, 'getBlock');
    const included = await readBlock({ blockNumber: found.receipt.receipt.blockNumber });
    const latest = await readBlock({ blockTag: 'latest' });
    // chain の時計どうしの差 (秒)。負 (最新の block を古い node が答えた) は窓の内 = 復旧の側。
    const sinceInclusionMs = Number(latest.timestamp - included.timestamp) * 1000;
    if (sinceInclusionMs <= STALE_SUBMITTING_WINDOW_MS) {
      logger.info('circle.stale_submitting.recover', {
        userOpHash,
        sinceHandoffMs,
        sinceInclusionMs,
        reason: 'recent-inclusion',
      });
      return null;
    }
    logger.warn('circle.stale_submitting.proceed', {
      userOpHash,
      sinceHandoffMs,
      sinceInclusionMs,
      receiptFound: true,
    });
    return 'spent';
  } catch (error) {
    logger.warn('circle.stale_submitting.unverified', {
      userOpHash,
      sinceHandoffMs,
      step,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unverified';
  }
}

type RecoveryContext = {
  bundle: CircleSmartAccountBundle;
  sender: Address;
  now: () => number;
};

// 「記録に従う」: CAS が外れた (= 待つ間・署名の間に、ほかの試みが記録を進めた) とき、記録を読み直し、今の状態から終わり方を
// 決める唯一の場所。内部の error (PendingStateError) を画面に出さない。**この押下で op を bundler に渡したか**で分ける:
//
//   渡していない (handedOff: false = markSigned の CAS が外れた・scan / resume の復旧で送り直しの前の CAS が外れた):
//     confirmed (hash を問わない) → 記録の結果 (同じ支払いを先に済ませた試みの結果を受け取る)
//     submitting                  → その op の復旧 (新しい op は作らない)
//     failed / abandoned / pre-submit / 記録なし → 「既に終了」の error (対応は消える。この試みは何も送っていない)
//
//   渡した (handedOff: true = 自分の markSubmitting の後の復旧で、送り直しの前の CAS が外れた):
//     confirmed かつ自分の userOpHash → 記録の結果
//     それ以外は **failed も含めて** 確認待ち。自分が渡した op があるのに「既に終了」と出すと、hook が対応を消して新しい
//     支払いを開けてしまう。failed は「閉じたのに、その後も送っていた」= 前提が破れた状態なので error の log を残す。
async function followRecord(
  ctx: RecoveryContext & { key: string },
  mode:
    | { handedOff: true; userOpHash: Hex }
    // fromRecovery: 復旧 (recoverSubmitting) の中から来た。下の submitting の枝を見よ。
    | { handedOff: false; fromRecovery: boolean },
): Promise<CirclePaymentResult> {
  const record = loadPendingRecord(ctx.key);

  if (mode.handedOff) {
    if (record?.status === 'confirmed' && record.userOpHash === mode.userOpHash) {
      return resultFromConfirmed(ctx.bundle, record);
    }
    if (record?.status === 'failed') {
      logger.error('circle.follow.failed-after-handoff', {
        userOpHash: mode.userOpHash,
        recordUserOpHash: record.userOpHash,
      });
    }
    throw new CirclePendingError(mode.userOpHash);
  }

  if (record?.status === 'confirmed') {
    return resultFromConfirmed(ctx.bundle, record);
  }
  if (record?.status === 'submitting') {
    // 復旧の中から来て、記録がまだ submitting = 待つ間に、同じ key の記録が別の op のものに替わっていた (同じ op のままなら
    // CAS は外れない)。この押下ではもう待たず、確認待ちで終える (次の押下がその op を復旧する)。復旧 → 記録に従う → 復旧、を
    // 繰り返さない。
    if (mode.fromRecovery) throw new CirclePendingError(record.userOpHash);
    const recovered = await recoverSubmitting({ ...ctx, record, handedOff: false });
    if (recovered) return recovered;
    throw new CirclePendingError(record.userOpHash);
  }
  throw attemptEnded();
}

// submitting で宙吊りの record を確定させる recovery 経路。
//   1) included を待つ (broadcast 済で応答だけロストしたケースを拾う)
//   2) 待ち切っても無い (timeout) ときだけ、*同一署名 op* を冪等 rebroadcast (broadcast 自体が届かず crash したケース)
//      → 再 wait。待ちそのものが失敗した (error) ときは送り直さない (受理されているかもしれない op を、押すたびに送り直さない)。
// confirmed にできたら結果を、まだ pending なら null を返す (record は submitting 維持)。
// handedOff: この押下で、この op を bundler に渡したか (自分の markSubmitting の後の復旧 = true・scan / resume / markSigned の
// CAS が外れた後の復旧 = false)。送り直しの前の CAS が外れたときの「記録に従う」の分け方に使う。
async function recoverSubmitting(
  args: RecoveryContext & { record: PendingRecord; handedOff: boolean },
): Promise<CirclePaymentResult | null> {
  const { bundle, record, sender, now, handedOff } = args;
  if (!record.userOpHash || !record.signedUserOp) {
    // submitting なのに署名済 op が無い = あり得ない (markSubmitting が防ぐ) が、
    // 万一なら確定不能なので pending 扱い (新規 op は作らない)。
    return null;
  }
  const hash = record.userOpHash;
  const key = record.key;

  const first = await waitReceipt(bundle, hash);
  if (first.kind === 'receipt') {
    return confirmAndResult({ key, sender, userOpHash: hash, receipt: first.receipt, now });
  }
  // 待ちそのものの失敗では送り直さない (記録の時刻も書かない)。
  if (first.kind === 'error') return null;

  // 送り直しの前に、記録がいまも「submitting で同じ op」であることを確かめ、送る時刻を書く (掃除対象から守る)。上の待ちは
  // 最大 120 秒で、その間にほかの試み (同じ key を resume した別の画面・自分の送信の receipt を待っている元の試み) が記録を
  // confirmed にしていることがある。record は待つ前に読んだものなので信じない。now() は待った後のここで評価する。
  try {
    markResending({ key, sender, userOpHash: hash, now: now() });
  } catch (error) {
    // storage の失敗などは CAS が外れたのではない → 送った後の境界 (inPostSubmit) が確認待ちに変える。
    if (!(error instanceof PendingStateError)) throw error;
    return followRecord(
      { bundle, sender, now, key },
      handedOff
        ? { handedOff: true, userOpHash: hash }
        : { handedOff: false, fromRecovery: true },
    );
  }

  logger.info('circle.recover.rebroadcast', { userOpHash: hash });
  try {
    await broadcastCircleUserOp({
      bundle,
      signedUserOp: record.signedUserOp,
    });
  } catch (error) {
    // "already known" / nonce 使用済 等は in-flight or 確定済の証左なので無害。
    // 送り直しの拒否では、検証による拒否 (分類が validation-rejected) でも記録を閉じない (冒頭の「最初の送信の検証拒否で
    // 閉じる」の (a)): 前の送信が受理されているかもしれず、この拒否は「mempool に無い」ことの証拠にならない。
    logger.info('circle.recover.rebroadcast-noop', {
      userOpHash: hash,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const second = await waitReceipt(bundle, hash);
  if (second.kind === 'receipt') {
    return confirmAndResult({ key, sender, userOpHash: hash, receipt: second.receipt, now });
  }
  return null;
}

export type ExecuteCirclePaymentArgs = {
  bundle: CircleSmartAccountBundle;
  publicClient: PublicClient;
  walletClient: ConnectedWalletClient;
  /** 委任済 EOA (= account owner)。permit signer かつ pending record の認可主体。 */
  owner: Address;
  /** merchant (+ split/fee) への transfer calls。 */
  calls: BatchCall[];
  /** Circle paymaster に与える permit allowance (gas 実費+surcharge を賄う上限・chunk5)。 */
  permitAmount: bigint;
  /** 1 回の「支払う」操作で固定の試行 ID (retry で不変・正規の再決済では別値)。 */
  paymentAttemptId: string;
  /** テスト用に注入可能な時刻源。 */
  now?: () => number;
  /** テスト用に注入可能な単調な時計 (ms)。省略時は performance.now。最初の送信の拒否で閉じるときの時間の柵だけに使う
   * (REJECTION_CLOSE_WINDOW_MS)。 */
  monotonicNow?: () => number;
  /** この試みを始めた画面 (hook の instance) がまだあるか (unmount の後は false のまま)。冒頭の「失効」。
   * 省略時は常に true (失効を見ない)。 */
  isAlive?: () => boolean;
  /** scan が別の key の記録の結果を受け取りに行く直前に、その記録の paymentAttemptId を渡して同期で呼ぶ (冒頭の「対応の
   * 付け替え」)。attemptId の対応 (sessionStorage) の持ち主は hook なので、書くのは hook の渡す関数。hook が対応を管理して
   * いるときだけ渡す。省略時は付け替えない。呼ぶ前に失効は確かめない (呼び出し元は、失効を確かめた同じ tick でこの関数を
   * 呼ぶこと。冒頭の「失効」)。
   * 返す値 = 対応を書けたか (書けたら true)。書けなかった (sessionStorage の失敗) なら、対応は前の値のままで、次の押下は
   * その記録を resume しない。hook は、最初の対応を保存できていない押下 (mappingSaved が false) でも false を返す
   * (書けても、次の押下がその対応を読めると言えない)。使うのは、確認待ちの場面の符号を (a) にするか (e) にするかだけ (復旧の進め方は変えない)。 */
  adoptAttempt?: (paymentAttemptId: string) => boolean;
  /** hook が、この押下の paymentAttemptId を attemptId の対応 (sessionStorage) に保存できているか (冒頭の「対応を保存できて
   * いない押下」)。false のとき、scan (既にある支払いの復旧・結果の受け取り) は今までどおり行い、新しい記録を予約する直前で
   * CircleAttemptMappingUnavailableError を投げる。省略時は true (明示の paymentAttemptId の呼び出しは今までどおり)。 */
  mappingSaved?: boolean;
};

// 失効した試みを終える error (冒頭の「失効」)。relay の hook (hooks/useJpycEip3009Payment.ts) と Pimlico の経路
// (lib/smartAccount/pimlicoIntent.ts) が unmount した試みを終えるのと同じ文字列。
function cancelled(): Error {
  return new Error('payment_cancelled');
}

/** Circle 経路の 1 決済を二重決済耐性付きで実行する。confirmed の結果を返すか、
 * 確認待ちなら CirclePendingError を投げる (失敗ではない・後で復旧可能)。 */
export async function executeCirclePayment(
  args: ExecuteCirclePaymentArgs,
): Promise<CirclePaymentResult> {
  const { bundle, publicClient, walletClient, owner, calls, permitAmount } = args;
  const now = args.now ?? (() => Date.now());
  const monotonicNow = args.monotonicNow ?? (() => performance.now());
  const isAlive = args.isAlive ?? (() => true);
  // (a)(b) 送金を止める確認ではない (保存と送信は (c) が止める)。何の波及を断つか: 署名の前の RPC (permit の domain・nonce /
  // ガス価格・prepareUserOperation) を待つ間に画面を離れた試みが、離れた後にウォレットへ署名の要求を出すこと (もう無い画面の
  // 要求がウォレットに残り、開き直した画面の要求と見分けがつかない)。
  const beforeSign = () => {
    if (!isAlive()) throw cancelled();
  };
  // 対応の付け替え (冒頭の「対応の付け替え」)。scan が rec の結果を受け取りに行く枝の、最初の await の前に呼ぶ。
  // ここに来る試みは生きている (失効を確かめない): 呼び出し元の入口の確認、または下の (e) から、ここまで await が無い。
  // 返す値 = 対応が付け替わったか。hook の関数を呼ばなかった (hook が対応を管理していない・記録に paymentAttemptId が無い)・
  // 呼んだが hook が対応を書けなかった (sessionStorage の失敗 = 関数が false を返す) なら false。確認待ちの場面の符号を (a) に
  // するか (e) にするかにだけ使う (scan の submitting の枝)。
  const adopt = (rec: PendingRecord): boolean => {
    if (!args.adoptAttempt || !rec.paymentAttemptId) return false;
    return args.adoptAttempt(rec.paymentAttemptId);
  };
  const sender = owner;
  const chainId = bundle.chainId;
  const callHash = computeCallHash(calls);
  const key = computeIdempotencyKey({
    chainId,
    sender,
    paymentAttemptId: args.paymentAttemptId,
    callHash,
  });

  // --- housekeeping (best-effort・決済本体に影響させない) ------------------
  // 放置された pre-submit 孤児 (別 attempt) を abandon し、古い終端 record を物理削除する。
  // GC は PRE_SUBMIT_GC_MS (≫ PRE_SUBMIT_STALE_MS) を使い、別タブの正規だが低速な署名を
  // 巻き込まない (容量管理に限定)。自 attempt (key) は excludeKey で守る。失敗は無視。
  try {
    gcStalePreSubmit(PRE_SUBMIT_GC_MS, now(), key);
    pruneTerminal(TERMINAL_RETENTION_MS, now());
    pruneStaleSubmitting(SUBMITTING_RETENTION_MS, now());
  } catch {
    /* housekeeping 失敗は決済に影響しない */
  }

  // --- cross-invocation 二重決済ガード ------------------------------------
  // paymentAttemptId は呼出毎に変わりうるので、冪等キー一致 (reserveOrResume) だけでは
  // 別 attempt (別タブ/別デバイス/reload/再クリック) を捕捉できない。**callHash で同一決済の
  // 生きている別 record を全状態スキャン**し、自 attempt (excludeKey) 以外が在れば新規 op を
  // 作らない:
  // 別の記録の結果を受け取りに行く枝 (直近の confirmed・最後に渡してから 30 分以内の submitting) は、その直前に attemptId の
  // 対応をその記録に付け替える (冒頭の「対応の付け替え」): この押下は自分の key の記録を作らないので、途中で画面を離れた・
  // 確認待ちで終わった後の次の押下が、その記録の key を resume できるようにする。
  //   confirmed (直近)  → 偶発二重 → 既支払い結果を返す。confirmed (古い) → 正規の再決済とみなし通す。
  //   submitting        → recover (receipt 照会 or 同一署名 op の冪等 rebroadcast)。最後に渡してから 30 分より後の記録は、
  //                        先に EntryPoint の nonce で確かめる (冒頭の「古い submitting の記録」): 未使用・取り込みが 30 分以内
  //                        → recover / 取り込みが 30 分より前・receipt なし → 飛ばす / 確かめられない → CirclePendingError。
  //   pre-submit (直近)  → 別 attempt が署名中 → 並行 broadcast を作らず CirclePendingError。
  //   pre-submit (stale) → reload 放置の orphan → abandon して block しない。
  // status 優先 (confirmed > submitting > pre-submit) で処理し、stale でない pre-submit が
  // 先に来て confirmed/submitting を CirclePendingError で masked するのを防ぐ。
  // ⚠️ scan→reserve は単一同期 tick で自タブ内は実質 atomic だが、タブ/デバイス跨ぎの真の同時
  // race は localStorage の限界で完全には塞げない。**その race を EntryPoint は止めない**: この経路の
  // UserOperation の nonce は、key が時刻由来で呼ぶたびに変わる (circleAccount.ts は account にも prepareUserOperation
  // にも nonce・nonceKey を渡さず、viem の toSmartAccount の getNonce が Date.now() 由来の key を採る)。別の試みが作る op は
  // 別の key の nonce になり、EntryPoint の nonce の一意性では互いに止まらない (両方 included されうる)。別の試みの二重払いを
  // 止めているのは、この scan・下の resume (同じ key)・記録の遷移の CAS だけ。EntryPoint が 1 回にするのは、同じ署名済み op の
  // 再送 (復旧の rebroadcast) だけ。
  // ⚠️ ただし「先行が confirmed 済 → 別デバイス (ローカル記録なし) で同じ QR を再決済」は新しい
  // nonce を取るため別決済として通る。これは server 権威の請求状態を持たない非カストディ設計の
  // 一般特性で、JPYC relay / Pimlico 7702 / standard の全ライブ経路と同じ (Circle 固有ではない)。
  // 正本は on-chain / 履歴で、店舗は着金確認で運用する (将来 server 請求 dedup を入れるなら全経路共通)。
  const scanLive = () =>
    findLiveByCallHash({ sender, chainId, callHash, excludeKey: key }).sort(
      (a, b) => statusRank(a.status) - statusRank(b.status),
    );
  let live = scanLive();

  // --- 古い submitting の記録の照合 (冒頭の「古い submitting の記録」) -------
  // 別の key の submitting が snapshot に 1 件も無ければ、ここは何もしない (時刻も読まない・await も挟まない)。
  let staleVerdicts: Map<string, StaleVerdict> | null = null;
  const otherSubmitting = live.filter((rec) => rec.status === 'submitting');
  if (otherSubmitting.length > 0) {
    const at = now();
    const stale = otherSubmitting.filter(
      (rec) => at - rec.updatedAt > STALE_SUBMITTING_WINDOW_MS,
    );
    if (stale.length > 0) {
      staleVerdicts = new Map();
      // 直近の confirmed (下の scan が既払いの結果を返す記録) が snapshot にあれば、照合の RPC を読まない。何の波及を断つか:
      // RPC を待つ間に 90 秒の窓を過ぎ、押した時点では既払いの結果を返すはずだった押下が新しい支払いへ進むこと。照合して
      // いない記録は unverified として持ち越す (下の scan の now() が 90 秒の線をまたいでその記録に着いても、照合なしでは
      // 復旧しない)。
      const dedupByConfirmed = live.some(
        (rec) =>
          rec.status === 'confirmed' &&
          rec.success !== false &&
          at - rec.updatedAt <= CONFIRMED_DEDUP_WINDOW_MS,
      );
      if (dedupByConfirmed) {
        for (const rec of stale) staleVerdicts.set(recordVersion(rec), 'unverified');
      } else {
        for (const rec of stale) {
          const verdict = await judgeStaleSubmitting({ bundle, rec, at });
          if (verdict) staleVerdicts.set(recordVersion(rec), verdict);
        }
        // (e) 何の波及を断つか: 照合の RPC を待つ間に画面を離れた試みが、離れた後に scan の abandon・記録の予約 (書き込み) を
        // 始めること。hook は、この await の前に失効を確かめている (runCirclePayment)。
        if (!isAlive()) throw cancelled();
        // 待った後は読み直す。ここから下の予約 (reserveOrResume) までは、今までどおり await の無い 1 tick。
        live = scanLive();
      }
    }
  }

  for (const rec of live) {
    if (rec.status === 'confirmed') {
      // 直近 confirmed = reload/再クリックによる偶発二重 → 既支払い結果を返す (冪等)。
      // 窓を過ぎた古い confirmed = 正規の同額リピート決済 → 抑止せず新規決済を許可。
      // ⚠️ confirmed は「included された」だけで **成功とは限らない** (success:false =
      // revert)。revert 済 record で dedup すると、支払いが起きていないのに 90 秒間
      // 再試行が全部ブロックされる。**除外するのは success:false と断定できる record だけ**:
      // success を持たない旧 record / 想定外の値で dedup を外すと、支払い済みなのに
      // 二重決済へ通してしまう (取り違えたときの被害が非対称なので dedup 側に倒す)。
      if (
        rec.success !== false &&
        now() - rec.updatedAt <= CONFIRMED_DEDUP_WINDOW_MS
      ) {
        // この記録の結果を受け取りに行く。下の照会 (await) の間に画面を離れても、次の押下がこの記録の key を resume する。
        adopt(rec);
        return await resultFromConfirmed(bundle, rec);
      }
      continue;
    }
    if (rec.status === 'submitting') {
      // 照合した版のままの記録だけに、照合の結果を当てる (版が違う = 待つ間に別のタブが進めた → 今までの扱い)。
      const verdict = staleVerdicts?.get(recordVersion(rec));
      // 取り込みが窓より前の、終わった op の記録 = 古い confirmed と同じく飛ばす (記録は書かない)。
      if (verdict === 'spent') continue;
      // 確かめられない記録は付け替えない (受け取りに行かない) → 場面 (e)。
      if (verdict === 'unverified') throw new CirclePendingError(rec.userOpHash, 'unconfirmed_earlier');
      // この記録の op を復旧する (結果を受け取りに行く)。下の待ち (最大 120 秒 × 2) の間に画面を離れても・確認待ちで
      // 終わっても、次の押下がこの記録の key を resume する。最後に渡してから 30 分以内の記録だけ: それより後の記録 (上の照合が
      // 「復旧」とした記録) は付け替えない (次の押下も、別の key の scan として照合を通す)。
      const adopted = now() - rec.updatedAt <= STALE_SUBMITTING_WINDOW_MS && adopt(rec);
      // 付け替えられなかった記録 (30 分の窓の外・記録に paymentAttemptId が無い・hook が対応を管理していない・hook が対応を
      // 書けなかった) の復旧が確認待ちで終わったら、場面は (e) (earlierUnless)。付け替えた記録は 30 分以内 = 書いたばかりなので、
      // 残りの寿命も足りる → (a)。
      return await earlierUnless(
        () => adopted,
        () =>
          inPostSubmit(rec.userOpHash, async () => {
            const recovered = await recoverSubmitting({
              bundle,
              record: rec,
              sender,
              now,
              handedOff: false,
            });
            if (recovered) return recovered;
            throw new CirclePendingError(rec.userOpHash);
          }),
      );
    }
    // reserved / awaiting_signature / signed (pre-submit・未 broadcast)。
    if (now() - rec.updatedAt > PRE_SUBMIT_STALE_MS) {
      // reload で見捨てられた orphan → abandon して掃除し、block しない。並行遷移で from
      // 不一致になっても無害 (二重決済ではなく一過性エラー) なので握り潰して continue。
      try {
        abandon({ key: rec.key, sender, now: now() });
      } catch {
        /* 並行 submitting 遷移等 → 次回スキャンで submitting として recover される */
      }
      continue;
    }
    // 直近の pre-submit = 別 attempt が署名中。並行 broadcast を作らない。
    // 場面の符号を 'busy_elsewhere' にするのはここだけ (この押下は何も始めていない。ほかの確認待ちは、既定の 'unconfirmed' か、
    // 上の submitting の枝・下の resume の submitting の枝の 'unconfirmed_earlier')。
    throw new CirclePendingError(rec.userOpHash, 'busy_elsewhere');
  }

  // --- 対応を保存できていない押下は、新しい記録を予約しない (冒頭の「対応を保存できていない押下」) ---
  // ここに来た = 上の scan に、結果を返す記録も、復旧する記録も、待つ記録も無かった (この先は新しい支払い)。何の波及を断つか:
  // 保存していない attemptId で新しい支払いを送ると、確認待ちで終わった後の押下が別の key になり、裏で確定した前の支払いの後に
  // 2 本目を開ける。ここより前に、新しい記録の書き込み・署名・送信は無い (下の reserveOrResume が最初の書き込み)。
  if (args.mappingSaved === false) throw new CircleAttemptMappingUnavailableError();

  // --- reserve (idempotency gate・自 attempt のクラッシュ resume) ----------
  const { record, resumed } = reserveOrResume({
    key,
    chainId,
    sender,
    callHash,
    paymentAttemptId: args.paymentAttemptId,
    paymaster: bundle.paymasterAddress,
    now: now(),
  });

  if (resumed) {
    if (record.status === 'confirmed') {
      return await resultFromConfirmed(bundle, record);
    }
    if (record.status === 'submitting') {
      // この記録が、確認待ちで出る時点から (a) の文の期限 (24 時間 = TERMINAL_RETENTION_MS。確定した記録を残す期間と同じ値) の
      // 間は残るか。submitting の記録は最後に書いてから SUBMITTING_RETENTION_MS (7 日) で掃除されるので、最後に書いてから
      // 6 日より後の記録は、24 時間以内の次の押下でも消えていることがある → その復旧が確認待ちで終わったら、場面は (e)
      // (earlierUnless)。
      // 記録の時刻は入口で読んだ値・今の時刻は確認待ちで出る時点 (復旧の待ちにかかった時間を入れる。now() を読むのは、
      // 確認待ちで出るときの 1 回だけで、符号にしか使わない)。復旧が同じ op を送り直すと記録の時刻は今になるが、入口の値で
      // 判定して (e) を出しても、言い足りないだけで事実に反しない。
      return await earlierUnless(
        () => now() - record.updatedAt <= SUBMITTING_RETENTION_MS - TERMINAL_RETENTION_MS,
        () =>
          inPostSubmit(record.userOpHash, async () => {
            const recovered = await recoverSubmitting({
              bundle,
              record,
              sender,
              now,
              handedOff: false,
            });
            if (recovered) return recovered;
            throw new CirclePendingError(record.userOpHash as Hex);
          }),
      );
    }
    if (record.status === 'failed' || record.status === 'abandoned') {
      throw attemptEnded();
    }
    // pre-submit (reserved/awaiting_signature/signed): まだ broadcast していないので
    // 下の通常フローで (再) 署名して送信して良い。
  }

  // --- normal flow --------------------------------------------------------
  markAwaitingSignature({ key, sender, now: now() });

  let paymasterData: Hex;
  let permitSignature: Hex;
  try {
    const signed = await signUsdcPermit({
      publicClient,
      walletClient,
      bundle,
      owner,
      permitAmount,
      beforeSign, // (a)
    }); // popup1
    paymasterData = signed.paymasterData;
    permitSignature = signed.permitSignature;
  } catch (error) {
    // (d) 失効した試みは abandon しない。何の波及を断つか: 同じタブ・同じ内容で開き直した画面は同じ key の記録を resume して
    // 使っている。画面の無い試みが、離れた後に返った拒否・失敗で abandoned にすると、開き直した画面の markSigned が CAS で
    // 落ち、送金していないのに失敗になる。記録は awaiting_signature のまま残し、元の error ではなく payment_cancelled で終える
    // ((a) の throw もここに落ちる)。
    if (!isAlive()) throw cancelled();
    // 署名前/署名拒否 = 未 broadcast の確定的失敗 → abandon (二重決済リスクなし)。
    abandon({ key, sender, now: now() });
    throw error;
  }

  let signedUserOp: SignedCircleUserOp;
  let userOpHash: Hex;
  try {
    const prepared = await prepareAndSignCircleUserOp({
      bundle,
      calls,
      paymasterData,
      beforeSign, // (b)
    }); // popup2 (signUserOperation)
    signedUserOp = prepared.signedUserOp;
    userOpHash = prepared.userOpHash;
  } catch (error) {
    // (d) 署名 1 の catch と同じ ((b) の throw もここに落ちる)。
    if (!isAlive()) throw cancelled();
    abandon({ key, sender, now: now() });
    throw error;
  }

  // (c) 失効した試みは、署名が返っても保存も送信もしない。何の波及を断つか: 画面を離れた後にウォレットの署名が返ると、
  // この op は開き直した画面の支払いとは別の nonce (key が時刻由来) で、EntryPoint では止まらない。内容が違えば key も scan も
  // 別なので両方払われ、同じ内容なら、開き直した画面の記録 (同じ key) をこの op で上書きして送る (H-V)。記録には触らない
  // (awaiting_signature のまま = 開き直した画面が resume する)。この確認から下の markSigned・markSubmitting・broadcast の開始
  // まで await を挟まない (確かめた後に失効する隙間を作らない)。
  if (!isAlive()) {
    logger.info('circle.sign_abandoned', { chainId, userOpHash });
    throw cancelled();
  }

  // 署名済 op を **broadcast 前に** 永続 (応答ロスト時に同一 op を rebroadcast するため)。
  try {
    markSigned({
      key,
      sender,
      signedUserOp,
      userOpHash,
      permitDigest: keccak256(permitSignature),
      now: now(),
    });
  } catch (error) {
    // storage の失敗 (書けない・読めない)・sender の不一致は、今までどおりふつうの error (何も送っていない)。
    if (!(error instanceof PendingStateError)) throw error;
    // CAS が外れた = 署名を待つ間に、ほかの試みがこの key の記録を進めた (同じ key を使う別の画面が先に送った・scan や GC が
    // abandoned にした)。自分の op は送らない (今までどおり)。内部の error を出さず、記録に従う: 先に送った試みがあれば、
    // その結果 (または復旧) を受け取る。この試みは何も渡していないので handedOff: false。
    return await inPostSubmit(undefined, () =>
      followRecord({ bundle, sender, now, key }, { handedOff: false, fromRecovery: false }),
    );
  }

  // 送信の用意 (bundler への 1 回用の transport を作る・同期・何も送らない) は、submitting にする **前** に済ませる。
  // 作れなければ (bundle の設定の誤り)、下の境界の外 = ふつうの error (送っていない試みを確認待ちにしない)。
  const sendFirst = prepareCircleBroadcast(bundle);

  // 閉じる資格 (冒頭の「最初の送信の検証拒否で閉じる」の (b)): markSubmitting の **直前に同期で** 記録を読み、「signed で、
  // userOpHash が自分の今署名した op のもの」のときだけ資格を持つ。この読みと markSubmitting の間に await を挟まない。
  // 何の波及を断つか: 同じ key の別の試み (複製したタブ) が、自分の markSigned の後に記録を自分の署名で上書きした・先に submitting
  // にしていたとき、こちらに返った拒否で記録を閉じ、記録に無い op が bundler に渡っているのに新しい支払いを開けること。
  // 資格が無くても、今までどおり markSubmitting → 送信へ進む (資格は閉じるかどうかだけを決める。閉じなければ今までの復旧)。
  // 記録を読めないときは markSubmitting も読めずに投げるので、ここで投げても今までと同じふつうの error (送っていない)。
  const beforeSubmitting = loadPendingRecord(key);
  const ownsSubmit =
    beforeSubmitting?.status === 'signed' && beforeSubmitting.userOpHash === userOpHash;
  // 時間の柵 (d) の起点。書く前に測る (経過を短く見積もらない側)。
  const submittingAtMono = monotonicNow();

  // broadcast_intent を永続 (fail-closed)。ここを過ぎたら fallback/新規 op 禁止 (例外は冒頭の「最初の送信の検証拒否で閉じる」)。
  // 書けなければ、下の境界の外 = ふつうの error (送っていない試みを確認待ちにしない)。
  const submitted = markSubmitting({ key, sender, now: now() });
  // submitted.updatedAt = この試みが、いま自分で signed → submitting にした時刻 (時間の柵の壁時計の起点・markRejected の (e))。
  const firstSend: FirstSendMark | null = ownsSubmit
    ? { submittedAt: submitted.updatedAt, submittedAtMono: submittingAtMono }
    : null;

  // ここから先は「op を bundler に渡したかもしれない後」。終わり方は、結果・確認待ち・最初の送信の検証拒否で閉じた error だけ
  // (inPostSubmit)。
  return await inPostSubmit(userOpHash, async () => {
    try {
      await sendFirst(signedUserOp);
    } catch (error) {
      // 最初の送信を bundler が検証で拒否した (冒頭の「最初の送信の検証拒否で閉じる」)。記録を閉じられたときだけ、確認待ちに
      // せず「送信の受付で断られた」で終える (待たない・送り直さない)。閉じられなければ、下の今までの扱い (復旧) へ進む。
      const rejection = validationRejectionOf(error);
      if (
        rejection &&
        (await closeRejectedFirstSend({
          bundle,
          key,
          sender,
          userOpHash,
          firstSend,
          rejection,
          now,
          monotonicNow,
        }))
      ) {
        throw new CircleSendRejectedError(userOpHash);
      }
      // 応答ロスト: op は受理・included しうる。auto-fallback 禁止 → recovery。
      logger.warn('circle.broadcast.response-lost', {
        userOpHash,
        error: error instanceof Error ? error.message : String(error),
      });
      const rec = loadPendingRecord(key);
      const recovered = rec
        ? await recoverSubmitting({ bundle, record: rec, sender, now, handedOff: true })
        : null;
      if (recovered) return recovered;
      throw new CirclePendingError(userOpHash);
    }

    // broadcast 受理 → included を待つ。
    const waited = await waitReceipt(bundle, userOpHash);
    if (waited.kind === 'receipt') {
      return confirmAndResult({ key, sender, userOpHash, receipt: waited.receipt, now });
    }
    // 待ちそのものの失敗 → この押下では送り直さず、確認待ちで終える (次の押下が同じ op を復旧する)。
    if (waited.kind === 'error') throw new CirclePendingError(userOpHash);
    // 受理されたが timeout 内に未 included → recovery (rebroadcast + 再 wait)。
    const rec = loadPendingRecord(key);
    const recovered = rec
      ? await recoverSubmitting({ bundle, record: rec, sender, now, handedOff: true })
      : null;
    if (recovered) return recovered;
    throw new CirclePendingError(userOpHash);
  });
}

// confirmed record から結果を復元する (scan の dedup・resume・「記録に従う」)。確定済みの op なので、receipt は **1 回だけ**
// 照会する (waitForUserOperationReceipt の最大 120 秒の待ちは使わない)。取れれば success/txHash/blockNumber/actualGasCost を
// receipt から埋め、**取れなければ、理由によらず** (まだ無い・bundler の 429・5xx・通信断) 永続済の record の値を返す。
// 照会の失敗をふつうの error にすると、払い終えた支払いなのに hook が attemptId の対応を消し、次の押下が 2 本目になる (H-Y)。
// 取れなかったときの success は永続済の record.success (success:true を捏造して revert 済 op を成功誤報告しない)。
// record.success が未確定 (旧 record) なら false 側に倒す。
async function resultFromConfirmed(
  bundle: CircleSmartAccountBundle,
  record: PendingRecord,
): Promise<CirclePaymentResult> {
  const hash = record.userOpHash as Hex;
  try {
    const receipt = await bundle.bundlerClient.getUserOperationReceipt({ hash });
    return toResult(hash, receipt);
  } catch (error) {
    logger.warn('circle.confirmed.receipt-unavailable', {
      userOpHash: hash,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    userOpHash: hash,
    txHash: (record.txHash ?? ('0x' as Hex)) as Hex,
    blockNumber: 0n,
    success: record.success ?? false,
    actualGasCost: 0n,
  };
}
