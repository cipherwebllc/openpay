// Pimlico の経路の intent (署名済みの UserOperation を保存した支払い) の関所 (第 10 回レビュー A-1)。
// hooks/useBatchPayment.ts が Pimlico の経路で使うときに dynamic import する (送信の部品 pimlicoSend.ts と同じく、
// /pay /checkout /tip /[handle] の baseline bundle から外す)。storage・memory のラッチ・error の型は hook が持ち、
// ここへは PimlicoIntentHost で渡す (lib から hooks を import しない・層の向き)。
//
// 不変条件: 署名済みの op を保存した時点から、その intent は「開いている」。開いている intent が記録の key の範囲
// (chain・customer・token) にある間は、その範囲で別の nonce の op・別の内容の支払いを作らない (画面は isUnknown で
// /pay と /checkout の通常決済も止める・lib/paymentFlowGuards)。作る op は必ず記録の nonce を使うので、送り直しても
// 作り直しても EntryPoint は同じ nonce の op を最大 1 本しか実行しない。intent を閉じるのは次だけ:
//   c1 候補の hash のどれかに receipt がある → 成功 / revert で確定
//   c2 **最初の送信** を bundler が検証で拒否した (HTTP 2xx + allowlist の code・pimlicoSend.ts) → 記録を消したと確かめてから、
//      今までどおりの error。ただし拒否の文 (bundler が返した文) が nonce・mempool・重複・置き換えに触れているときは閉じない
//      (応答不明。この op 自身がもう届いているために返った拒否かもしれない・buildAndSend の onRejected)
//   c4 最後に bundler へ渡して (渡そうとして) から 7 日を過ぎ、候補のどれにも receipt が無く、EntryPoint の nonce も未使用 →
//      記録を消したと確かめてから
//   c5 EntryPoint の nonce は進んだが、候補のどれにも receipt が無い → 期限までは開いたまま、期限で c4 と同じく閉じる
// それ以外 (応答不明・送り直しや作り直しの拒否 (c3)・照合できない・保存を確かめられない) は開いたまま。
//
// 判定はこの module の入口に集める:
//   resolveOpenIntent = 開いている intent への唯一の入口 (照合 → 閉じる / 送り直す / 作り直す / 開いたまま)
//   startIntent       = 新しい intent (nonce を決める → 準備 → 署名 → 保存 → 送信)
//   sendRecordedOp    = bundler へ op を渡す唯一の場所。送る前に、その op の記録が storage にあり読み戻せることを確かめる
// 照合 (receipt と EntryPoint の nonce を読むだけ) は、保存した記録 (sender・EntryPoint・nonce・候補の hash・chain) だけで
// 行い、今の account で送れるかどうかに依存しない。送り直し・作り直しだけが、記録と今の account の一致を要る。
//
// 失効 (第 10 回レビュー A-2): host を渡した hook の instance が画面から外れた (unmount した) 後も、react-query の mutation は
// 走り続ける。原則は 1 つ: **失効した試みは、新しい効果を始めない** (ウォレットに署名を求めない・storage を書かない・消さない・
// bundler へ op を渡さない)。host.isAlive() を見るのは、新しい効果の直前の 4 か所だけ:
//   (a) sendRecordedOp の先頭 (保存と送信の前)  (b) 準備と署名の間  (c) buildAndSend の catch (元の記録を書き戻す前)
//   (d) resolveOpenIntent が期限で閉じる discard の前
// すでに bundler へ渡した op の後始末 (receipt 待ち・settle で記録を閉じる・hash の直し・応答不明の status) では見ない
// (渡した op は画面が無くても成立しうる)。その書き込み・削除は、下の「版の一致」を通す。
//
// 版の一致 (PR-02 の Codex レビュー P1 と、その 2 回目・3 回目): 記録への後からの書き込み (応答不明の status・hash の直し・作り直しの
// 保存を確かめられないときの書き戻し) と、確定によらない削除 (c2 で閉じる・保存を確かめられない op の片付け) は、
// storage にいま入っている記録が、この試みが書いた (または読んで判断した) 版そのもの (pimlicoIntentOwner.ts の isSameVersion =
// 同じ intent・同じ userOpHash・同じ updatedAt) のときだけ行う (compare-and-set: persistIfVersion・discardIfVersion)。
// 期限 (c4・c5) で閉じる削除は、storage の記録が同じ intent で、その記録自身も期限を過ぎているときだけ行う (discardIfExpired:
// memory のラッチと storage の版がずれても、両方の版が期限を過ぎれば閉じる)。保存を確かめられずに開いたままにするとき、memory に
// 持つのは、送り直し・作り直しで書こうとした版 (書き込みが返った = storage に入ったかもしれない) か、前の版 (書き込みが投げた =
// storage は書く前のまま)。次の再確認は、送り直す前に必ず保存し直す。期限で閉じるのは、memory の版と storage の版の両方が期限を
// 過ぎたとき。だから memory の版が storage とずれていても、送り直すか期限で閉じるかへ進む (reload を待たない)。送り直すかどうかは
// memory の版の時刻で判断するので、memory が storage より新しい版を持つ間 (書き込みが黙って落ち、storage も読めなかったとき) は、
// storage の版の期限を過ぎた後でも、保存し直してから送り直すことがある (同じ nonce の同じ op なので二重にはならない)。
// 何の波及を断つか: 送った後の後始末は失効で止めないので、その間にほかの画面 (開き直した画面・別のタブ) が
//   - 記録を閉じて別の nonce の支払いを始めると、key ごとの書き込み・削除がその記録を上書きし・消す (reload の後に確かめられず、
//     別の nonce で払い直せる)。
//   - 同じ intent を送り直す (送る時刻を進める)・作り直す (hash が変わる) と、古い写しの書き込みが送った時刻を巻き戻して期限
//     (c4) で早く閉じさせ、古い写しの削除 (遅れて届いた最初の送信の拒否) が mempool にある作り直しの op の記録を消す。
// storage が空のときも書かない (閉じた記録を復活させない)。版が違う・別の intent・読めないときは、書かない・消さないまま、
// 今までの終わり方 (応答不明・開いたまま) で終える。確定 (receipt が取れた op の片付け・hook の settle) だけは同じ intent の
// どの版も消す (その nonce の op が取り込まれた以上、どの版も終わっている)。
// 対象にしないのは、新しい intent の最初の保存と、送り直し・作り直しの直前の保存 (sendRecordedOp の先頭)。どちらもこの試みが
// これから bundler へ渡す op の記録で、失効した試みは (a) が止める (両方とも画面にある別のタブとの競合は PR の「限界」)。

import { isAddress, isAddressEqual, isHex, type Address, type Client, type Hex } from 'viem';
import { logger } from '@/lib/logger';
import { createPimlico } from '@/lib/pimlico';
import { isSameIntent, isSameVersion } from './pimlicoIntentOwner';
import {
  broadcastPimlicoUserOp,
  bundlerErrorText,
  findRpcRequestError,
  findUserOperationReceipt,
  isUserOpNonceConsumed,
  joinUserOpNonce,
  mentionsNonceOrMempool,
  prepareAndSignPimlicoUserOp,
  reserveUserOpNonce,
  splitUserOpNonce,
  toUserOperationRejection,
  type PimlicoCall,
  type PimlicoSignedUserOp,
  type SignedSendClient,
} from './pimlicoSend';

export { asSignedSendClient } from './pimlicoSend';

// 送信の前に保存する「送信の控え」。任意の欄で、これが無い記録 (この欄を足す前に書かれた記録・MAv2 の facade で
// 送った記録) は hook が今までどおり hash の receipt の照会だけで扱う。
export type PimlicoSendLedger = {
  entryPoint: Address;
  sender: Address;
  // この支払いの UserOperation の nonce (10 進)。EntryPoint は同じ (sender, key, seq) の op を最大 1 本しか
  // 実行しないので、作り直しの op を必ずこの nonce で作るかぎり、二重には実行されない (安全の根拠)。
  // key だけ固定して seq を読み直すのは不可 (元の op が取り込まれた後の seq+1 で通ってしまう)。
  nonceKey: string;
  nonceSeq: string;
  // 署名済みの op (RPC の形)。応答を失ったときに 1 字も変えずに送り直す。この op で動くのは同じ送金 1 回だけ。
  signedUserOp: PimlicoSignedUserOp;
  // 同じ支払いを同じ nonce で作り直す前の op の hash。作り直した後に元の op が取り込まれたとき、
  // その receipt を引くために残す (取り込まれるのはどれか 1 本だけ)。
  priorUserOpHashes?: Hex[];
};

// localStorage に保存する記録 (hook の PimlicoPendingRecord)。params の中はこの module では見ない (引き継ぐだけ)。
export type PimlicoIntentRecord<Params> = {
  schemaVersion: 1;
  provider: 'pimlico';
  // pending / unknown = 結果が分からない op がある (reload の後はどちらも「応答不明」として復元する)。
  status: 'pending' | 'unknown';
  chainId: number;
  customer: string;
  tokenAddress: Address;
  callFingerprint: Hex;
  userOpHash: Hex;
  params: Params;
  createdAt: number;
  // 期限 (7 日) の基準。送信の控えのある記録では「最後に op を bundler へ渡した (渡そうとした) 時刻」(sendRecordedOp が
  // 送る直前に書く)。控えの無い記録 (この欄を足す前・MAv2) は今までどおり最後に書いた時刻。
  updatedAt: number;
  send?: PimlicoSendLedger;
};

export type LedgerIntentRecord<Params> = PimlicoIntentRecord<Params> & {
  send: PimlicoSendLedger;
};

// 新しい記録の、送信の控え以外の欄 (作り直しは元の記録のものを引き継ぐ)。
type IntentBase<Params> = Pick<
  PimlicoIntentRecord<Params>,
  'schemaVersion' | 'provider' | 'chainId' | 'customer' | 'tokenAddress' | 'params'
>;

// 保存の結果:
//   stored     = 書けて、読み戻しても同じだった。
//   not-stored = 書き込み (setItem) が投げた。storage は書く前のまま (Web Storage の setItem は、書けないときは
//                何も変えずに投げる)。
//   uncertain  = 書き込みは返ったが、読み戻しが投げた・違った。書いた記録が storage に残っているかもしれない。
export type PimlicoPersistResult = 'stored' | 'not-stored' | 'uncertain';

// storage にいま入っている記録 (版の一致に使う)。none = 記録が無い (壊れていて記録とみなせないものを含む)・
// unavailable = storage が読めない。
export type PimlicoStoredRead<Params> =
  | { kind: 'record'; record: PimlicoIntentRecord<Params> }
  | { kind: 'none' }
  | { kind: 'unavailable' };

// 確定に使う receipt の欄 (bundler の UserOperation の receipt のうち hook が読むもの)。
export type PimlicoReceipt = {
  success: boolean;
  actualGasCost: bigint;
  receipt: { transactionHash: Hex; blockNumber: bigint };
};

type ReceiptSource = {
  getUserOperationReceipt: (args: { hash: Hex }) => Promise<PimlicoReceipt>;
  waitForUserOperationReceipt: (args: { hash: Hex }) => Promise<PimlicoReceipt>;
};

// 送れる手段: 今の account が送信を分けられる client と、同じ Pimlico の bundle の client (送った後に receipt を待つ)。
export type PimlicoIntentSender = {
  client: SignedSendClient;
  bundler: ReceiptSource;
};

export type PimlicoIntentHost<Params, Result> = {
  storageKey: string;
  // 照合: receipt の照会・待ちの先 = 今の Pimlico の bundle の client。無い (今の account が Pimlico の bundle でない) ときは
  // null で、照会だけを記録の chain の bundler へ行う (待たない)。
  bundler: ReceiptSource | null;
  // 照合: EntryPoint の nonce を読む chain の client (wagmi の public client)。送れる client があるときはその account の client。
  publicClient: Client | undefined;
  // 送信: 無ければ送らない (照合だけ)。
  sender: PimlicoIntentSender | null;
  // この host を渡した hook の instance がまだ画面にあるか (unmount の後は false のまま)。冒頭の「失効」。
  isAlive: () => boolean;
  isExpired: (record: PimlicoIntentRecord<Params>) => boolean;
  // storage の今の記録を読む (版の一致・冒頭)。
  read: () => PimlicoStoredRead<Params>;
  persist: (record: PimlicoIntentRecord<Params>) => PimlicoPersistResult;
  // 記録を消し、消えたことを確かめる (true = この key の記録はもう storage に無い)。呼ぶのは discardIfVersion だけ。
  discard: () => boolean;
  // memory の記録を差し替える (showUnknown = 応答不明として画面に出す)。
  hold: (record: PimlicoIntentRecord<Params>, showUnknown: boolean) => void;
  // memory と画面のラッチがこの記録なら外す。
  release: (record: PimlicoIntentRecord<Params>) => void;
  setStoreUnavailable: (unavailable: boolean) => void;
  // receipt が取れた op で記録を閉じる (storage・memory を片付けて、成功の経路の結果を返す)。
  settle: (record: PimlicoIntentRecord<Params>, userOpHash: Hex, receipt: PimlicoReceipt) => Result;
  unknownError: (record: PimlicoIntentRecord<Params>, reason: string) => Error;
  storeUnavailableError: () => Error;
  closedError: () => Error;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 失効した試みを終える error (冒頭の「失効」)。relay の hook (hooks/useJpycEip3009Payment.ts) が unmount した試みを
// 終えるのと同じ文字列。記録・memory のラッチには触らない (instance はもう無く、storage は新しい画面のもの)。
function cancelled(): Error {
  return new Error('payment_cancelled');
}

// storage にいま入っている記録と、この試みが知っている版 (known = この試みが書いた・書こうとした・読んで判断した記録) の関係
// (冒頭の「版の一致」)。match = known のどれかと同じ版・none = 記録が無い・other = 別の版 (ほかの試みが送り直した・作り直した・
// hash を直した同じ intent の記録)・別の intent・storage が読めない (どれも「この試みが知っている記録だ」と言えない)。
type StoredVersion = 'match' | 'none' | 'other';

function storedVersion<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  known: readonly PimlicoIntentRecord<Params>[],
): StoredVersion {
  const stored = host.read();
  if (stored.kind === 'none') return 'none';
  return stored.kind === 'record' && known.some((version) => isSameVersion(stored.record, version))
    ? 'match'
    : 'other';
}

// 後からの書き込み (compare-and-set): storage の記録が known の版のときだけ next を書く (空のときも書かない = 閉じた記録を復活
// させない)。読んでから書くまで await を挟まない (同じタブの中では、ほかの試みが間に入らない)。
function persistIfVersion<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  known: readonly PimlicoIntentRecord<Params>[],
  next: PimlicoIntentRecord<Params>,
): PimlicoPersistResult | 'not-owner' {
  const stored = storedVersion(host, known);
  if (stored === 'match') return host.persist(next);
  logger.warn('pimlico.pending.not-owner', { userOpHash: next.userOpHash, stored, action: 'persist' });
  return 'not-owner';
}

// 確定によらない削除 (compare-and-set): true = この key に記録が無い (known の版を消して確かめた・ほかの試みが先に閉じていた)。
// false = 別の版・別の intent の記録がある・storage が読めない・消したと確かめられない。false のとき何も消さず、呼び出し側は
// 今までの「消せなかった」の枝 (開いたまま・応答不明) で終える: ほかの試みの記録があるのに「閉じたので新しい支払いを開けてよい」と
// 画面に伝えない。読んでから消すまで await を挟まない。
function discardIfVersion<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  known: readonly PimlicoIntentRecord<Params>[],
): boolean {
  const stored = storedVersion(host, known);
  if (stored === 'match') return host.discard();
  if (stored === 'none') return true;
  logger.warn('pimlico.pending.not-owner', { userOpHash: known[0]?.userOpHash, stored, action: 'discard' });
  return false;
}

// 期限 (c4・c5) で閉じる削除: true = この key に記録が無い (消して確かめた・ほかの試みが先に閉じていた)。消すのは、storage の記録が
// 期限を判断した記録と同じ intent で、**storage の記録自身も期限を過ぎている** (その版でも、最後に bundler へ渡して (渡そうとして)
// から 7 日たっている) ときだけ。何の波及を断つか (版の一致と同じ): 照合を待つ間に、ほかの試みが同じ intent を送り直して期限を
// 延ばした記録 (storage の版はまだ期限の前で、op はまだ実行されうる) を、古い記録で判断した期限で消すこと。
// 版の一致で比べない理由: memory のラッチと storage の版は、書き込みが返ったのに storage が黙って落とした・画面の無い試みが hash を
// 直した等で、同じ intent のままずれることがあり、版の一致だと両方の版が期限を過ぎても閉じられず reload まで止まる。照合 (候補の
// receipt・EntryPoint の nonce) は同じ nonce について行っているので、storage の版の op も同じ nonce で、取り込まれていれば nonce は
// 使われている (c5)。読んでから消すまで await を挟まない。
function discardIfExpired<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  record: PimlicoIntentRecord<Params>,
): boolean {
  const stored = host.read();
  if (stored.kind === 'none') return true;
  if (stored.kind === 'record' && isSameIntent(stored.record, record) && host.isExpired(stored.record)) {
    return host.discard();
  }
  logger.warn('pimlico.pending.not-owner', { userOpHash: record.userOpHash, stored: 'other', action: 'discard' });
  return false;
}

function ledgerNonce(send: PimlicoSendLedger): bigint {
  return joinUserOpNonce(BigInt(send.nonceKey), BigInt(send.nonceSeq));
}

// この支払い (同じ nonce) で bundler に渡したことのある op の hash。新しいものから。
function ledgerUserOpHashes<Params>(record: LedgerIntentRecord<Params>): Hex[] {
  return [record.userOpHash, ...[...(record.send.priorUserOpHashes ?? [])].reverse()];
}

// 記録の中の関係: 署名済みの op の sender と nonce が記録の値と同じ。合わない (記録の中が食い違う) ときは、記録の nonce を
// 読んでも署名済みの op の実行を確かめたことにならないので、照合 (期限で閉じる)・送り直し・作り直しをしない。
// 今の account には依存しない。これは復元の正しさのための確認で、同じ origin の任意の script (storage を書き換えられる)
// への防御ではない。
function ledgerIsConsistent(send: PimlicoSendLedger): boolean {
  const { sender, nonce } = send.signedUserOp;
  return (
    typeof sender === 'string' &&
    isAddress(sender, { strict: false }) &&
    isAddressEqual(sender, send.sender) &&
    typeof nonce === 'string' &&
    isHex(nonce, { strict: true }) &&
    BigInt(nonce) === ledgerNonce(send)
  );
}

// 送れるか: 記録の EntryPoint と sender が今の account のもの。「同じ nonce の op は最大 1 本」が効くのは同じ EntryPoint・
// 同じ sender の上だけなので、合わない (account の種類・委任先・接続先が変わった) ときは送り直し・作り直しをしない。
function ledgerMatchesAccount(send: PimlicoSendLedger, client: SignedSendClient): boolean {
  return (
    isAddressEqual(client.account.entryPoint.address, send.entryPoint) &&
    isAddressEqual(client.account.address, send.sender)
  );
}

// EntryPoint の nonce を読む chain の client。送れる client があればその account の client (今の Pimlico の bundle の chain =
// 記録の key の chain)。無ければ wagmi の public client を、記録の chain と同じときだけ使う (違えば読めない = 開いたまま)。
function chainReader<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  record: PimlicoIntentRecord<Params>,
): Client {
  if (host.sender) return host.sender.client.account.client;
  if (!host.publicClient || host.publicClient.chain?.id !== record.chainId) {
    throw new Error('chain-client-unavailable');
  }
  return host.publicClient;
}

// 期限 (c4・c5) の基準は記録の updatedAt = 「最後に op を bundler へ渡した (渡そうとした) 時刻」1 つ。進めるのは
// sendRecordedOp が送る直前に書くときだけで、照合 (送らない)・送った後の更新では動かさない (照合のたびに延ばすと、c4・c5 で
// 閉じる時が来ない)。

// 送っていない (照合だけ・送る前に止めた) まま、開いたまま終える。記録は書き換えない。
function stayOpen<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  record: PimlicoIntentRecord<Params>,
  logKey: string,
  error: unknown,
): never {
  host.hold(record, true);
  const reason = errorMessage(error);
  logger.warn(logKey, {
    userOpHash: record.userOpHash,
    callFingerprint: record.callFingerprint,
    error: reason,
  });
  throw host.unknownError(record, reason);
}

// op を bundler へ渡した後、結果が分からないまま記録を保持し、応答不明で終える (status を unknown にする。時刻は送る直前に
// 書いたまま・動かさない)。known = この試みが書いた (書こうとした) 版 (冒頭の「版の一致」)。
function holdAsUnknown<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  record: PimlicoIntentRecord<Params>,
  known: readonly PimlicoIntentRecord<Params>[],
  logKey: string,
  error: unknown,
): never {
  const unknownRecord: PimlicoIntentRecord<Params> = { ...record, status: 'unknown' };
  // 書けなくても memory のラッチは残す (同じタブで別の支払い・通常決済を開けない)。保存できたことにはしない: memory に
  // しか無い op は、次に送る前に sendRecordedOp が保存を確かめ直し、確かめられなければ送らない (送った op の記録と送った
  // 時刻は、送る前に保存を確かめてある)。
  // storage の記録が known の版でない (ほかの画面が閉じて空・送り直した・作り直した・別の intent の記録・読めない) ときは
  // 書かない (persistIfVersion)。書くと、送り直した時刻を古い写しで巻き戻す (期限で早く閉じる)。終わり方 (memory のラッチ・
  // 応答不明の error) は同じ。
  const stored = persistIfVersion(host, known, unknownRecord);
  if (stored !== 'stored' && stored !== 'not-owner') {
    logger.warn('pimlico.pending.hold-not-stored', {
      userOpHash: record.userOpHash,
      stored,
    });
  }
  return stayOpen(host, unknownRecord, logKey, error);
}

// bundler へ op を渡す唯一の場所 (初回・送り直し・作り直しのどれも)。送る直前に、送る時刻 (updatedAt) を入れた記録を
// 必ず書いて読み戻し、読み戻せたときだけ送る。何の波及を断つか:
//   - storage に無い (memory にしか無い) op を送ると、応答を失った後の reload で記録が無く、別の nonce の支払いが通って
//     二重払いになる (第 10 回レビュー A-1 の Codex 第 2 回 MUST 1)。
//   - 送った時刻を送る前に保存しないと、送り直しの後の更新が書けない・reload で失われたとき、storage の時刻は前に送った
//     時のままで、送り直して受理された op を期限 (c4) で閉じ、別の支払いを許してしまう (第 3 回 MUST)。送った後の更新には
//     頼らない。
// 時刻を書いた後、送る前に落ちた (タブを閉じた等) ときは、期限が先へ延びるだけ (閉じるのが遅れる側・fail-closed)。
// 保存を確かめられなければ送らず、onNotStored (場面ごとに違う) で終える。
async function sendRecordedOp<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  sender: PimlicoIntentSender,
  args: {
    record: LedgerIntentRecord<Params>;
    // 応答不明として画面に出ている intent の op か (送り直し・作り直し)。新しい支払いでは false。
    latched: boolean;
    // いま署名したばかりの op か (新しい支払い・作り直し)。保存してあった op の送り直しでは false。失効で捨てた署名を
    // 数える log にだけ使う。
    signedNow: boolean;
    // attempted = 書こうとした記録 (送る時刻入り = 書けていれば storage にある版)。
    onNotStored: (
      stored: Exclude<PimlicoPersistResult, 'stored'>,
      attempted: LedgerIntentRecord<Params>,
    ) => never;
    // bundler が検証で拒否した (HTTP 2xx + allowlist の code)。sent = 送った記録 (送った時刻入り)。
    onRejected: (error: unknown, sent: LedgerIntentRecord<Params>) => Promise<Result>;
  },
): Promise<Result> {
  // (a) 失効した試みは、保存も送信もしない。何の波及を断つか: ウォレットの署名 (または照合の RPC・送り直しへの答え) を待つ間に
  // 画面を離れ、開き直した画面 (新しい hook) で払い終えた後で、古い署名の要求を承認すると、古い試みが別の nonce の op を保存して
  // 送り、二重払いになる (A-2)。新しい画面の intent が開いている間なら、同じ key の記録を上書きして消す。作り直しの op も同じ:
  // 新しい画面が同じ nonce で確定して消した記録を、古い試みが書き戻して復活させない。
  // この確認から下の persist まで await を挟まない (確かめた後に失効する隙間を作らない)。
  if (!host.isAlive()) {
    if (args.signedNow) {
      logger.info('pimlico.sign_abandoned', {
        chainId: args.record.chainId,
        userOpHash: args.record.userOpHash,
      });
    }
    throw cancelled();
  }
  let record: LedgerIntentRecord<Params> = { ...args.record, updatedAt: Date.now() };
  const stored = host.persist(record);
  if (stored !== 'stored') return args.onNotStored(stored, record);
  host.setStoreUnavailable(false);
  host.hold(record, args.latched);
  // この試みが書いた (書こうとした) 版。送った後の書き込みは、storage がこのどれかのときだけ (冒頭の「版の一致」)。
  let known: LedgerIntentRecord<Params>[] = [record];
  // raw の eth_sendUserOperation (再送なし・HTTP の status を見る)。
  const outcome = await broadcastPimlicoUserOp({
    client: sender.client,
    signedUserOp: record.send.signedUserOp,
    entryPoint: record.send.entryPoint,
  });
  if (outcome.kind === 'validation-rejected') return args.onRejected(outcome.error, record);
  if (outcome.kind === 'unknown') {
    // bundler が受理した後に応答だけ失われた可能性がある。通常の error にすると、成立した op の上に
    // 再試行・通常決済が開いて二重払いになる (A-1)。保存済みの記録を応答不明としてラッチする。
    return holdAsUnknown(host, record, known, 'pimlico.send.response-unknown', outcome.error);
  }
  // already-known: bundler がこの op を持っている。受理と同じく receipt を待つ。
  if (outcome.kind === 'accepted' && outcome.userOpHash !== record.userOpHash) {
    // 計算した hash は receipt を引く手がかりで、安全の根拠ではない (根拠は nonce)。
    // bundler の返した hash を正として記録を直す (送った後の更新は今までどおり保存の成否を見ない・時刻は動かさない)。
    // 直すのは storage の記録が直す前の版 (この試みが送る直前に書いた版) のときだけ (答えを待つ間にほかの画面が閉じた記録を
    // 復活させない・送り直した記録の時刻を巻き戻さない・別の intent の記録を上書きしない)。memory のラッチは直す。直した版も
    // この試みの版に加える (直しの書き込みが届かなかったときは、後の応答不明の書き込みが直した版を書く)。
    logger.warn('pimlico.send.hash-mismatch', {
      computed: record.userOpHash,
      returned: outcome.userOpHash,
    });
    const fixed: LedgerIntentRecord<Params> = { ...record, userOpHash: outcome.userOpHash };
    host.hold(fixed, args.latched);
    persistIfVersion(host, known, fixed);
    known = [record, fixed];
    record = fixed;
  }
  // 送った後の receipt 待ち。引けなければ応答不明のまま (status を unknown にする・時刻は送った時のまま)。
  let receipt: PimlicoReceipt;
  try {
    receipt = await sender.bundler.waitForUserOperationReceipt({ hash: record.userOpHash });
  } catch (error) {
    return holdAsUnknown(host, record, known, 'pimlico.receipt.response-unknown', error);
  }
  return host.settle(record, record.userOpHash, receipt);
}

// 準備 → 署名 → (sendRecordedOp で) 保存 → 送信。nonce は呼び出し側が決めた値をそのまま使う。
async function buildAndSend<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  sender: PimlicoIntentSender,
  args: {
    calls: readonly PimlicoCall[];
    callFingerprint: Hex;
    nonce: bigint;
    base: IntentBase<Params>;
    // 開いている intent を同じ nonce で作り直すときの元の記録 (応答不明として画面に出ている)。新しい支払いでは無し。
    previous?: LedgerIntentRecord<Params>;
  },
): Promise<Result> {
  const { calls, callFingerprint, nonce, base, previous } = args;
  let built: Awaited<ReturnType<typeof prepareAndSignPimlicoUserOp>>;
  try {
    built = await prepareAndSignPimlicoUserOp({
      client: sender.client,
      calls,
      nonce,
      // (b) 送金を止める確認ではない (保存と送信は (a) が止める)。何の波及を断つか: 準備 (nonce・paymaster・fee の RPC) を
      // 待つ間に画面を離れた試みが、離れた後にウォレットへ署名の要求を出すこと (もう無い画面の要求がウォレットに残る)。
      beforeSign: () => {
        if (!host.isAlive()) throw cancelled();
      },
    });
  } catch (error) {
    // (c) 失効した試みは、作り直しの途中でも元の記録を書き戻さない (下の holdAsUnknown は、storage の記録が元の版なら
    // persist する)。何の波及を断つか: 画面の無い試みが、開き直した画面が新しくした同じ intent の状態 (確定して消した・送り直した・
    // 作り直した記録) の上に、古い判断で書き込むこと。元の記録は誰も触っていなければ storage に既にあり、書き戻す意味が無い。
    // 新しくした記録には holdAsUnknown の版の一致も書かないが、失効した試みは判断そのものを進めず、応答不明のラッチと log も
    // 残さずに payment_cancelled で終える。(b) の throw もここに落ちる。
    if (!host.isAlive()) throw cancelled();
    // 応答不明の記録の作り直しで準備・署名が失敗した (ウォレットで断った等)。作り直しの op は送っていないので
    // 元の記録のまま応答不明を保つ (通常の error にすると画面が新しい支払いを開ける)。previous は、この試みが送り直しの直前に
    // 書いた版 (resolveOpenIntent の送り直しの sent)。
    if (previous) {
      return holdAsUnknown(host, previous, [previous], 'pimlico.rebuild.prepare-failed', error);
    }
    throw error;
  }
  const now = Date.now();
  const { key, seq } = splitUserOpNonce(nonce);
  // 候補の hash は intent に結び付けたまま残す (同じ nonce の候補のうち、取り込まれるのはどれか 1 本)。
  const priorUserOpHashes = previous
    ? [...(previous.send.priorUserOpHashes ?? []), previous.userOpHash]
    : [];
  const record: LedgerIntentRecord<Params> = {
    schemaVersion: base.schemaVersion,
    provider: base.provider,
    status: 'pending',
    chainId: base.chainId,
    customer: base.customer,
    // 作り直しは intent の内容 (保存した params) のまま。
    tokenAddress: base.tokenAddress,
    callFingerprint,
    userOpHash: built.userOpHash,
    params: base.params,
    createdAt: previous?.createdAt ?? now,
    // 送る直前に sendRecordedOp が送る時刻で書き直す。
    updatedAt: now,
    send: {
      entryPoint: built.entryPoint,
      sender: built.sender,
      nonceKey: key.toString(),
      nonceSeq: seq.toString(),
      signedUserOp: built.signedUserOp,
      ...(priorUserOpHashes.length > 0 ? { priorUserOpHashes } : {}),
    },
  };
  return sendRecordedOp(host, sender, {
    record,
    latched: previous !== undefined,
    signedNow: true,
    // 保存を確かめられない: 署名済みの op はここで捨てる (どこにも送っていない)。保存なしで送ると、応答を失ったときに
    // 「同じ nonce」を失い、再試行が別の nonce の op になる (二重払い)。止めるのは gasless だけ (通常決済は、開いている
    // intent が無ければ開けたまま)。書けたかどうか分からない ('uncertain') ときは、送っていない op の記録を storage に
    // 残したまま「保存できません」(= 通常決済は開く) にしない: 新しい支払いは書いたかもしれない記録を消し、作り直しは
    // 元の記録 (開いている intent) に書き戻して、そうなったと確かめる。どちらも storage の記録が、いま書こうとした版か
    // (作り直しでは) 元の版のときだけ (ほかの試みの版・別の intent の記録・読めないときは触らず、作り直しでは空のときも
    // 書き戻さない) で、そうでなければ下の開いたままの枝。
    onNotStored: (stored, attempted) => {
      const restored =
        stored === 'not-stored' ||
        (previous
          ? persistIfVersion(host, [attempted, previous], previous) === 'stored'
          : discardIfVersion(host, [attempted]));
      if (!restored) {
        // 署名済みの op が storage に残っているかもしれない (reload の後に「同じ送信内容を再確認」で送られうる)。
        // 送っていなくても intent を開いたまま (応答不明) にして、通常決済・別の支払いを開けない。memory には書こうとした版を
        // 持つ。作り直しの書き戻しが「書けたかどうか分からない」で終わったときは storage が元の版のこともあるが、作り直しの版の
        // まま持つ (時刻は元の版と数 ms しか違わず、期限は storage の版で判断する・次の再確認は送り直す前に保存し直すので、署名
        // 済みの作り直しの op をウォレットの署名なしで送れる)。
        return stayOpen(host, attempted, 'pimlico.pending.persist-unverified', new Error(`persist-${stored}`));
      }
      host.setStoreUnavailable(true);
      throw host.storeUnavailableError();
    },
    onRejected: async (error, sent) => {
      if (previous) {
        // c3: 作り直しの op を bundler が断った。前の候補が mempool に残っていることがある (Replacement
        // underpriced 等) ので、この拒否は前の候補が無いことの証拠にならない。code が allowlist のものでも開いたまま。
        // 次に確かめるとき、前の op の receipt も引く。
        return holdAsUnknown(host, sent, [sent], 'pimlico.rebuild.rejected', error);
      }
      // c2: 最初の送信を bundler が検証で拒否した。閉じてよいのは、その拒否が「この op は mempool に入っておらず、取り込まれても
      // いない」と読めるときだけ。
      // 拒否の文が nonce・mempool・重複・置き換えに触れているとき (HTTP 200 + -32500「AA25 invalid account nonce」・
      // 「replacement underpriced」等) は、そう読めないので閉じない (応答不明)。何の波及を断つか: **この op 自身がもう届いている**
      // (送信が途中で 2 回届いた・先に取り込まれた) ために返った拒否で記録を消して閉じると、次の試みは新しい nonce の op になり
      // (本番で動く simple 7702 は nonce の key が時刻由来で、試みごとに新しい)、取り込まれる支払いの上にもう 1 本払う。
      // 閉じなければ、次の再確認 (resolveOpenIntent) が候補の receipt と EntryPoint の nonce を読んで決める (receipt があれば確定)。
      // 見るのは bundler が返した文だけ (viem の error の message は、送った request の本文 = "nonce" の欄を載せるので見ない・
      // 語の定義は Circle の経路と同じ 1 つ = pimlicoSend.ts)。共有の分類 (classifyBroadcastError) には入れない: 送り直しの拒否
      // (同じ nonce で作り直す) の動きを変えない。
      // 害: nonce の key が固定 (0) の account (MetaMask のスマートアカウント。ガスレスは flag つきで、hooks/useSmartAccount.ts の
      // コメントでは無効の扱い) では、別のタブ・別の dapp が先に nonce を使った正当な AA25 でも応答不明になり、同じ chain・
      // customer・token の支払いが、期限 (最後に bundler へ渡してから 7 日・c5) まで止まる。利用者が自分で閉じる手段は無い。
      // simple 7702 (key が時刻由来) では、最初の送信に nonce の拒否が返るのは、この op 自身が届いている場合に偏る (推測)。
      if (mentionsNonceOrMempool(bundlerErrorText(findRpcRequestError(error)))) {
        return holdAsUnknown(host, sent, [sent], 'pimlico.send.rejected-nonce-or-mempool', error);
      }
      // それ以外の検証の拒否 (残高・署名・paymaster・op の形) = この送信の op は mempool に入っていない。
      // 記録を消したと確かめられたとき (ほかの画面が先に閉じていたときを含む) だけ閉じ、今までどおりの error にする (nonce の
      // 予約は残さない・金額を変えた再試行も通常決済もできる)。確かめられなければ、残った op が後で送られうるので開いたまま。
      // 消すのは storage の記録が、この試みが送る直前に書いた版 (sent) のときだけ。拒否が示すのは「この送信が断られた」ことだけで、
      // その後の送信や候補が無いことではない: 拒否の答えが遅れる間に、ほかの画面が同じ nonce で送り直した・作り直した (mempool に
      // ある) 記録や、この intent を閉じて始めた別の支払いの記録は、消さずに開いたまま (応答不明。holdAsUnknown もそれには書かない)。
      if (!discardIfVersion(host, [sent])) {
        return holdAsUnknown(host, sent, [sent], 'pimlico.send.rejected-unverified', error);
      }
      host.release(sent);
      throw toUserOperationRejection(error, { signed: built.signed, calls });
    },
  });
}

/** 新しい支払い: nonce (key と seq) を署名の前に決め、署名済みの op と一緒に送信の前に保存してから送る。 */
export async function startIntent<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  sender: PimlicoIntentSender,
  args: { base: IntentBase<Params>; calls: readonly PimlicoCall[]; callFingerprint: Hex },
): Promise<Result> {
  return buildAndSend(host, sender, {
    ...args,
    nonce: await reserveUserOpNonce(sender.client),
  });
}

type LedgerProbe =
  // この intent の op (今の op か、作り直す前の op) が取り込まれていた。
  | { kind: 'included'; userOpHash: Hex; receipt: PimlicoReceipt }
  // 候補の hash のどれにも receipt が無いが、記録の nonce はもう使われた (同じ nonce の op はもう実行されない)。
  // 自分の op が実行されたとも、されなかったとも言い切れない (c5): 計算した hash と bundler の hash が違って応答を
  // 失った・MetaMask の key 0 を別の op が使った。
  | { kind: 'consumed' }
  // 取り込まれておらず、nonce も使われていない。
  | { kind: 'open' }
  // 記録の中が食い違う (ledgerIsConsistent): nonce を読んでも照合にならない。
  | { kind: 'unreadable' };

// 読むだけ: 候補の hash で receipt → 無ければ EntryPoint の getNonce(sender, key)。今の account に依存しない。
async function probeLedger<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  record: LedgerIntentRecord<Params>,
): Promise<LedgerProbe> {
  // 今の Pimlico の bundle の client が無いとき (委任を外した・account の種類が変わった・Circle の経路) は、記録の chain の
  // bundler へ照会する (receipt の照会は hash だけで引くので、client の EntryPoint の版は使わない)。
  const bundler: Pick<ReceiptSource, 'getUserOperationReceipt'> =
    host.bundler ?? createPimlico(record.chainId);
  const found = await findUserOperationReceipt<PimlicoReceipt>(
    bundler,
    ledgerUserOpHashes(record),
  );
  if (found) return { kind: 'included', ...found };
  if (!ledgerIsConsistent(record.send)) return { kind: 'unreadable' };
  const consumed = await isUserOpNonceConsumed({
    client: chainReader(host, record),
    entryPoint: record.send.entryPoint,
    sender: record.send.sender,
    nonce: ledgerNonce(record.send),
  });
  return consumed ? { kind: 'consumed' } : { kind: 'open' };
}

// 送らずに receipt を待つ (c5 の期限の前・今の account では送れない・記録の中が食い違う)。記録は書き換えない (stayOpen)。
// 今の Pimlico の bundle の client が無いときは待たない (照会は probeLedger で済んでいる)。
async function awaitReceipt<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  record: PimlicoIntentRecord<Params>,
): Promise<Result> {
  if (!host.bundler) {
    return stayOpen(host, record, 'pimlico.verify.send-unavailable', new Error('no-pimlico-client'));
  }
  let receipt: PimlicoReceipt;
  try {
    receipt = await host.bundler.waitForUserOperationReceipt({ hash: record.userOpHash });
  } catch (error) {
    return stayOpen(host, record, 'pimlico.receipt.response-unknown', error);
  }
  return host.settle(record, record.userOpHash, receipt);
}

/**
 * 開いている intent への唯一の入口 (送信の控えのある記録・内容 (calls) は呼び出し側が記録と同じと確かめた後)。
 * 照合 (読むだけ) → c1 で確定 / 期限 (c4・c5) で閉じる / 送れるときだけ保存した op を送り直す (検証で拒否されたら同じ nonce で
 * 作り直す) / それ以外は開いたまま。
 */
export async function resolveOpenIntent<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  record: LedgerIntentRecord<Params>,
  calls: readonly PimlicoCall[],
): Promise<Result> {
  let state: LedgerProbe;
  try {
    state = await probeLedger(host, record);
  } catch (error) {
    // 照合に要る RPC が読めない: 開いたまま (fail-closed)。記録は書き換えないので、読めるようになった時に期限で閉じられる。
    return stayOpen(host, record, 'pimlico.verify.probe-failed', error);
  }
  if (state.kind === 'included') {
    return host.settle(record, state.userOpHash, state.receipt);
  }
  if (state.kind !== 'unreadable' && host.isExpired(record)) {
    // 最後に bundler へ渡して (渡そうとして) から 7 日を過ぎ、候補のどれにも receipt が無い。記録を消したと確かめてから閉じる (今の account で送れるかに
    // 依存しない: 委任を外した・変えた後も、ここで閉じられる)。
    //   c4 (open): EntryPoint の nonce も未使用。7 日前の署名済みの op を今送ると、その時点で支払いが成立しうるので
    //     送り直さない。保存の期限は署名を取り消さない (残った op を誰かが送れば後から成立しうる・PR の「限界」)。
    //   c5 (consumed): nonce はもう使われたので、候補の op はどれももう実行されない (同じ nonce は 1 本だけ)。開いたまま
    //     にする目的は「払い済みかもしれない支払いを、もう一度払わせない」ことだけで、将来の二重の実行を防ぐ意味は無い。
    //     期限まで待ったので閉じる (端末に永久に残る止めを作らない。実は払い済みだった可能性は残る・PR の「限界」)。
    // (d) 失効した試みは閉じない (記録を消さない)。何の波及を断つか: 上の照合の RPC を待つ間に画面を離れた古い試みが、開き直した
    // 画面が新しくした状態 (同じ intent を送り直して期限を延ばした記録・この記録を閉じて始めた新しい支払いの記録) を、古い記録で
    // 判断した期限で消すこと (消えた後は、まだ実行されうる op・応答を失った新しい支払いを確かめられず、別の nonce で払い直せる)。
    // 閉じるのは次に確かめる画面に任せる。下の版の一致もそれらを消さないが、失効した試みは判断そのものを進めず、閉じた error でなく
    // payment_cancelled で終える。
    if (!host.isAlive()) throw cancelled();
    // 消すのは storage の記録が同じ intent で、その記録自身も期限を過ぎているときだけ (discardIfExpired)。照合を待つ間に別のタブが
    // 同じ intent を送り直した (storage の版の期限が延びた)・この記録を閉じて新しい支払いを始めたときは、消さずに開いたまま。
    // 閉じたと伝えると、この画面が新しい支払い・通常決済を開ける。
    if (!discardIfExpired(host, record)) {
      // 消したと確かめないまま閉じると、残った署名済みの op が reload の後に送られ、その間に開けた通常決済と二重になる。
      return stayOpen(host, record, 'pimlico.pending.expired-close-failed', new Error('discard-failed'));
    }
    host.release(record);
    logger.warn('pimlico.pending.expired-closed', {
      userOpHash: record.userOpHash,
      updatedAt: record.updatedAt,
      state: state.kind,
    });
    throw host.closedError();
  }
  const sender =
    state.kind === 'open' && host.sender && ledgerMatchesAccount(record.send, host.sender.client)
      ? host.sender
      : null;
  if (!sender) {
    // c5 (期限の前): 成功にも不成立にもせず receipt を待つ。今の account では送れない・記録の中が食い違う: 同じ。
    return awaitReceipt(host, record);
  }
  // まだ取り込まれておらず nonce も使われていない → 保存した署名済みの op を 1 字も変えずに送り直す。
  return sendRecordedOp(host, sender, {
    record,
    latched: true,
    signedNow: false,
    // 送り直しの前に保存を確かめられない (memory にしか無い op): 送らず開いたまま。memory に持つのは、storage に入ったかもしれない
    // 一番新しい版 (Codex の 3 回目のレビュー): 書き込みが投げた ('not-stored' = storage は書く前のまま) なら前の記録。書き込みは
    // 返った ('uncertain') なら送ろうとした版 (送る時刻入り) だが、storage を読んで前の記録の版がそのまま残っていれば (書き込みが
    // 黙って落ちた) 前の記録。何の波及を断つか: memory の版の時刻が storage の版とずれると、次の再確認が storage とは違う時刻で
    // 期限を判断する。前の版のままだと、storage ではまだ送り直せる時に送らない。送ろうとした版を持つのに storage が前の版だと、
    // storage (reload の後) では 7 日を過ぎて送らずに閉じる op を、この画面だけが送り直す (c4)。
    onNotStored: (stored, attempted) => {
      host.setStoreUnavailable(true);
      const latest =
        stored === 'uncertain' && storedVersion(host, [record]) !== 'match' ? attempted : record;
      return stayOpen(host, latest, 'pimlico.send.not-stored', new Error(`persist-${stored}`));
    },
    // bundler がその op を検証で拒否した (paymaster の期限切れ等) → 同じ nonce で作り直す (ウォレットの署名が
    // 1 回要る)。intent は開いたまま (c3)。元の op が先に取り込まれていれば、作り直しは AA25 で落ちる。作り直しの元は
    // 送った記録 (送った時刻入り・作り直しの保存に失敗したときは、これに書き戻す)。
    onRejected: (_error, sent) =>
      buildAndSend(host, sender, {
        calls,
        callFingerprint: record.callFingerprint,
        nonce: ledgerNonce(record.send),
        base: sent,
        previous: sent,
      }),
  });
}
