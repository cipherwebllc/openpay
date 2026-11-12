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
//     検証拒否で閉じる」)。その op は mempool に入っていない前提で、次の押下は新しい支払い (署名から) になる。
//   - cross-invocation (reload / 再クリック): 同一 sender+chain+callHash の submitting
//     宙吊りがあれば、新規送信せず先にそれを recover する。
//
// 送った後の終わり方 (第 10 回レビュー H-W・H-Y): 自分の markSubmitting が返った後と、submitting / confirmed の記録を扱う枝
// (scan・resume・markSigned の CAS が外れたとき) の終わり方は次だけにする:
//   (1) receipt が取れた・記録が confirmed → 結果
//   (2) まだ bundler に op を渡していない試みが、終わった記録 (failed / abandoned / 記録なし) に当たった → 「既に終了」の error
//   (3) **自分の最初の送信** を bundler が検証で拒否し、記録を failed に閉じられた → 「送信の受付で断られた」error
//       (CircleSendRejectedError・第 10 回レビュー H-X。下の「最初の送信の検証拒否で閉じる」)
//   (4) それ以外すべて → CirclePendingError (確認待ち)
// hook (useBatchPayment の runCirclePayment) は、CirclePendingError と storage の失敗 (PendingStoreUnavailableError・
// PendingStoreWriteError) 以外の error で attemptId の対応を消す。op を渡したかもしれない後にふつうの error で終わると、次の押下が
// 新しい key になり、後から確定した前の支払い (90 秒より前の confirmed) を「正規のリピート」とみなして 2 本目を払う。なので (4) を
// 1 か所 (inPostSubmit) で保証する。confirmed の記録の枝 (scan・resume) は包まない: resultFromConfirmed が照会の失敗を全部
// 受けて (1) を返し、投げる処理が無い。(2) と (3) は「この op は mempool に無い」と言える終わり方で、対応を消してよい
// (次の押下は新しい支払い = 署名から)。
//
// 最初の送信の検証拒否で閉じる (H-X): bundler が最初の送信を検証で拒否した op は mempool に入っていない。確認待ちに残すと、
// その内容の支払いが、押すたびに 120 秒待ち → 同じ op の送り直し → また拒否 → 120 秒、を繰り返して払えない。なので記録を
// failed に閉じ、(3) で終える。閉じるのは次が **全部** そろったときだけ (そろわなければ今までどおり復旧へ進み、(4) で終える):
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
//   (d) **時間の柵**: 自分の markSubmitting から拒否の処理までの経過が REJECTION_CLOSE_WINDOW_MS (30 秒) 未満である (壁時計と
//       単調な時計の両方で。下の REJECTION_CLOSE_WINDOW_MS のコメント)
//   (e) 記録がいまも submitting・userOpHash が同じ・updatedAt が自分の markSubmitting の返した値である (書く直前に同期で
//       確かめる = lib/circlePending.ts の markRejected)。確かめられるのは「読んだ時点の記録が、自分の書いたまま」だけで、
//       別のタブとの間で原子的ではない (localStorage に lock は無い)。その窓は (d) が、ほかの試みが送り直しに着く前に閉じる
// 残る前提: bundler が「検証で拒否」と答えた op は取り込まれない (Pimlico の経路の c2 と同じ前提)。破れたとき (閉じた op の
// receipt が取れた) は、markConfirmed が failed → confirmed に直して error の log を残す。
// 入口の scan・resume の読み取り・予約の書き込み (境界の外) が storage の失敗で投げたときは、hook の側が対応を残す (この押下は
// 記録の状態を確かめられなかった)。
//   - receipt の待ちの結果は receipt / timeout / error の 3 つ (waitReceipt)。**同じ op の送り直しへ進むのは timeout のとき
//     だけ**。error (bundler の 429・5xx・通信断) では、送り直さず・記録の時刻も書かずに確認待ちで終える。
//   - 送り直しの **前** に、記録がいまも「submitting で同じ userOpHash」であることを確かめて送る時刻を書く (markResending)。
//     確かめられなければ送り直さず、記録の今の状態に従う (followRecord)。
//   - receipt を取った後の記録の更新 (markConfirmed) が失敗しても、結果は返す (取り込まれた支払いを失敗と出さない)。
//   - confirmed の記録の結果は、receipt を 1 回だけ照会し、取れなければ理由によらず保存した値で返す (resultFromConfirmed)。
//
// 失効 (第 10 回レビュー H-V): この試みを始めた画面 (hook の instance) が外れた (unmount した) 後も、react-query の mutation は
// 走り続ける。原則は 1 つ: **失効した試みは、新しい効果を始めない** (ウォレットに署名を求めない・記録を書かない = markSigned・
// markSubmitting・abandon・bundler へ op を渡さない)。args.isAlive() を見るのは、新しい効果の直前だけ:
//   (a) 署名 1 (permit) を求める直前  (b) 署名 2 (UserOperation) を求める直前  (c) 署名 2 の後・markSigned の前
//   (d) 署名 1・署名 2 の catch (abandon の前)
// すでに bundler へ渡した op の後始末 (receipt 待ち・復旧の再送・markConfirmed) では見ない (渡した op は画面が無くても成立しうる)。
// 失効した試みは payment_cancelled で終わり、記録は awaiting_signature のまま残す (開き直した画面が同じ key を resume する)。
//
// useBatchPayment の circle 分岐がこの executeCirclePayment を呼ぶ。permitAmount の
// 算定 (gas 実費 + per-chain surcharge) は chunk 5 (useGasQuoteCircle) が担い、ここへは
// 確定値が渡る (本 module は fee ポリシーを持たない)。

import { keccak256, type Address, type Hex } from 'viem';
import { WaitForUserOperationReceiptTimeoutError } from 'viem/account-abstraction';
import {
  broadcastCircleUserOp,
  prepareAndSignCircleUserOp,
  prepareCircleBroadcast,
  signUsdcPermit,
  waitForCircleReceipt,
  type BatchCall,
  type CircleBroadcastError,
  type CircleSmartAccountBundle,
  type SignedCircleUserOp,
} from '@/lib/smartAccount/circleAccount';
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
// pruneTerminal (terminal のみ) にも該当せず永久残留する (緩慢リーク)。7 日後の同一 callHash
// 再決済は CONFIRMED_DEDUP_WINDOW_MS (90s) を遥かに超え正規リピート扱いなので回収して安全。
const SUBMITTING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
 * 送信の HTTP の timeout は viem の http transport の既定 10 秒 (bundle の transport に timeout を渡していない) なので、タブが
 * 動いていれば拒否はふつう 30 秒より前に届く。
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

/** broadcast 済 (or 済かもしれない) だが timeout 内に included を確認できなかった状態。
 * **失敗ではない** — op は後で included しうるし、findRecoverable で復旧できる。UI は
 * 「送信済・確認待ち。再読み込みしても二重決済にならない」と案内する。 */
export class CirclePendingError extends Error {
  /** 確認待ち op の hash。pre-submit (まだ未署名/未 broadcast の別 attempt 検出) では undefined。 */
  readonly userOpHash?: Hex;
  constructor(userOpHash?: Hex) {
    super(
      'USDC ガスレス決済を処理中です (確認待ち、または別タブで進行中)。' +
        'ページを再読み込みしても二重決済にはなりません (自動で復旧を試みます)。',
    );
    this.name = 'CirclePendingError';
    this.userOpHash = userOpHash;
  }
}

/** 自分の最初の送信を bundler が検証で拒否し、記録を閉じた (冒頭の (3))。この op は mempool に入っていない = 送金されて
 * いない。**確認待ちではない**: name を 'CirclePendingError' にしない (hook は attemptId の対応を消し、次の押下は新しい支払い =
 * 署名からやり直す)。文は固定 (bundler・viem の生の文 = AA33… や request の本文を画面に出さない)。
 * 文は第 10 回レビュー PR-39c で i18n に載せる前提の仮の文 (3 フォームは error の message をそのまま赤い枠に出す)。 */
export class CircleSendRejectedError extends Error {
  /** 断られた op の hash (監査用)。 */
  readonly userOpHash: Hex;
  constructor(userOpHash: Hex) {
    super(
      'USDC ガスレスの支払いは、送信の受付で断られました。この支払いは送金されていません。' +
        '残高が足りないなどの理由が考えられます。もう一度お試しください (署名からやり直します)。',
    );
    this.name = 'CircleSendRejectedError';
    this.userOpHash = userOpHash;
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
// name は 'Error' のまま (hook・フォームから見て、今までの new Error と同じ)。class にするのは境界が見分けるためだけ。
class AttemptEndedError extends Error {}

function attemptEnded(): AttemptEndedError {
  return new AttemptEndedError(
    'この決済試行は既に終了しています。新しい決済として実行し直してください。',
  );
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

// 自分の最初の送信が検証で拒否されたとき、記録を failed に閉じる (冒頭の「最初の送信の検証拒否で閉じる」の (b)(d)(e))。閉じられたら
// true。閉じる資格が無い (b)・遅れて届いた (d)・記録がもう「自分が submitting にしたまま」でない (e: ほかの試みが確定させた・
// 送り直した・別の op の記録に替わった・消えた) ときは false = 閉じない (呼び出し側は今までどおり復旧へ進む)。storage の失敗は
// 投げる (送った後の境界が確認待ちに変える)。
// 記録と log に残す文は bundler の code と、伏せ字にした bundler の文だけ (viem の error の message は、署名済みの op と URL を
// 含むので入れない)。
function closeRejectedFirstSend(args: {
  key: string;
  sender: Address;
  userOpHash: Hex;
  firstSend: FirstSendMark | null;
  rejection: CircleBroadcastError;
  now: () => number;
  monotonicNow: () => number;
}): boolean {
  const { key, sender, userOpHash, firstSend, rejection, now, monotonicNow } = args;
  if (!firstSend) {
    logger.warn('circle.broadcast.rejected-not-closed', {
      userOpHash,
      code: rejection.code,
      reason: 'not-own-submit',
    });
    return false;
  }
  // (d) 時間の柵。下の markRejected まで await を挟まない (測った後に遅れる隙間を作らない)。
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
  //   confirmed (直近)  → 偶発二重 → 既支払い結果を返す。confirmed (古い) → 正規の再決済とみなし通す。
  //   submitting        → recover (receipt 照会 or 同一署名 op の冪等 rebroadcast)。
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
  const live = findLiveByCallHash({ sender, chainId, callHash, excludeKey: key }).sort(
    (a, b) => statusRank(a.status) - statusRank(b.status),
  );
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
        return await resultFromConfirmed(bundle, rec);
      }
      continue;
    }
    if (rec.status === 'submitting') {
      return await inPostSubmit(rec.userOpHash, async () => {
        const recovered = await recoverSubmitting({
          bundle,
          record: rec,
          sender,
          now,
          handedOff: false,
        });
        if (recovered) return recovered;
        throw new CirclePendingError(rec.userOpHash);
      });
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
    throw new CirclePendingError(rec.userOpHash);
  }

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
      return await inPostSubmit(record.userOpHash, async () => {
        const recovered = await recoverSubmitting({
          bundle,
          record,
          sender,
          now,
          handedOff: false,
        });
        if (recovered) return recovered;
        throw new CirclePendingError(record.userOpHash as Hex);
      });
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
        closeRejectedFirstSend({
          key,
          sender,
          userOpHash,
          firstSend,
          rejection,
          now,
          monotonicNow,
        })
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
