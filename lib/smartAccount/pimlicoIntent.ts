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
//      今までどおりの error
//   c4 保存から 7 日を過ぎ、候補のどれにも receipt が無く、EntryPoint の nonce も未使用 → 記録を消したと確かめてから
//   c5 EntryPoint の nonce は進んだが、候補のどれにも receipt が無い → 期限までは開いたまま、期限で c4 と同じく閉じる
// それ以外 (応答不明・送り直しや作り直しの拒否 (c3)・照合できない・保存を確かめられない) は開いたまま。
//
// 判定はこの module の入口に集める:
//   resolveOpenIntent = 開いている intent への唯一の入口 (照合 → 閉じる / 送り直す / 作り直す / 開いたまま)
//   startIntent       = 新しい intent (nonce を決める → 準備 → 署名 → 保存 → 送信)
//   sendRecordedOp    = bundler へ op を渡す唯一の場所。送る前に、その op の記録が storage にあり読み戻せることを確かめる
// 照合 (receipt と EntryPoint の nonce を読むだけ) は、保存した記録 (sender・EntryPoint・nonce・候補の hash・chain) だけで
// 行い、今の account で送れるかどうかに依存しない。送り直し・作り直しだけが、記録と今の account の一致を要る。

import { isAddress, isAddressEqual, isHex, type Address, type Client, type Hex } from 'viem';
import { logger } from '@/lib/logger';
import { createPimlico } from '@/lib/pimlico';
import {
  broadcastPimlicoUserOp,
  findUserOperationReceipt,
  isUserOpNonceConsumed,
  joinUserOpNonce,
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
  isExpired: (record: PimlicoIntentRecord<Params>) => boolean;
  persist: (record: PimlicoIntentRecord<Params>) => PimlicoPersistResult;
  // 記録を消し、消えたことを確かめる (true = この key の記録はもう storage に無い)。
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
// 書いたまま・動かさない)。
function holdAsUnknown<Params, Result>(
  host: PimlicoIntentHost<Params, Result>,
  record: PimlicoIntentRecord<Params>,
  logKey: string,
  error: unknown,
): never {
  const unknownRecord: PimlicoIntentRecord<Params> = { ...record, status: 'unknown' };
  // 書けなくても memory のラッチは残す (同じタブで別の支払い・通常決済を開けない)。保存できたことにはしない: memory に
  // しか無い op は、次に送る前に sendRecordedOp が保存を確かめ直し、確かめられなければ送らない (送った op の記録と送った
  // 時刻は、送る前に保存を確かめてある)。
  const stored = host.persist(unknownRecord);
  if (stored !== 'stored') {
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
    onNotStored: (stored: Exclude<PimlicoPersistResult, 'stored'>) => never;
    // bundler が検証で拒否した (HTTP 2xx + allowlist の code)。sent = 送った記録 (送った時刻入り)。
    onRejected: (error: unknown, sent: LedgerIntentRecord<Params>) => Promise<Result>;
  },
): Promise<Result> {
  let record: LedgerIntentRecord<Params> = { ...args.record, updatedAt: Date.now() };
  const stored = host.persist(record);
  if (stored !== 'stored') return args.onNotStored(stored);
  host.setStoreUnavailable(false);
  host.hold(record, args.latched);
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
    return holdAsUnknown(host, record, 'pimlico.send.response-unknown', outcome.error);
  }
  // already-known: bundler がこの op を持っている。受理と同じく receipt を待つ。
  if (outcome.kind === 'accepted' && outcome.userOpHash !== record.userOpHash) {
    // 計算した hash は receipt を引く手がかりで、安全の根拠ではない (根拠は nonce)。
    // bundler の返した hash を正として記録を直す (送った後の更新は今までどおり保存の成否を見ない・時刻は動かさない)。
    logger.warn('pimlico.send.hash-mismatch', {
      computed: record.userOpHash,
      returned: outcome.userOpHash,
    });
    record = { ...record, userOpHash: outcome.userOpHash };
    host.hold(record, args.latched);
    host.persist(record);
  }
  // 送った後の receipt 待ち。引けなければ応答不明のまま (status を unknown にする・時刻は送った時のまま)。
  let receipt: PimlicoReceipt;
  try {
    receipt = await sender.bundler.waitForUserOperationReceipt({ hash: record.userOpHash });
  } catch (error) {
    return holdAsUnknown(host, record, 'pimlico.receipt.response-unknown', error);
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
    built = await prepareAndSignPimlicoUserOp({ client: sender.client, calls, nonce });
  } catch (error) {
    // 応答不明の記録の作り直しで準備・署名が失敗した (ウォレットで断った等)。作り直しの op は送っていないので
    // 元の記録のまま応答不明を保つ (通常の error にすると画面が新しい支払いを開ける)。
    if (previous) return holdAsUnknown(host, previous, 'pimlico.rebuild.prepare-failed', error);
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
    // 保存を確かめられない: 署名済みの op はここで捨てる (どこにも送っていない)。保存なしで送ると、応答を失ったときに
    // 「同じ nonce」を失い、再試行が別の nonce の op になる (二重払い)。止めるのは gasless だけ (通常決済は、開いている
    // intent が無ければ開けたまま)。書けたかどうか分からない ('uncertain') ときは、送っていない op の記録を storage に
    // 残したまま「保存できません」(= 通常決済は開く) にしない: 新しい支払いは書いたかもしれない記録を消し、作り直しは
    // 元の記録 (開いている intent) に書き戻して、そうなったと確かめる。
    onNotStored: (stored) => {
      const restored =
        stored === 'not-stored' ||
        (previous ? host.persist(previous) === 'stored' : host.discard());
      if (!restored) {
        // 署名済みの op が storage に残っているかもしれない (reload の後に「同じ送信内容を再確認」で送られうる)。
        // 送っていなくても intent を開いたまま (応答不明) にして、通常決済・別の支払いを開けない。
        return stayOpen(host, record, 'pimlico.pending.persist-unverified', new Error(`persist-${stored}`));
      }
      host.setStoreUnavailable(true);
      throw host.storeUnavailableError();
    },
    onRejected: async (error, sent) => {
      if (previous) {
        // c3: 作り直しの op を bundler が断った。前の候補が mempool に残っていることがある (Replacement
        // underpriced 等) ので、この拒否は前の候補が無いことの証拠にならない。code が allowlist のものでも開いたまま。
        // 次に確かめるとき、前の op の receipt も引く。
        return holdAsUnknown(host, sent, 'pimlico.rebuild.rejected', error);
      }
      // c2: 最初の送信を bundler が検証で拒否した = この intent の op は mempool に無い (前の候補も無い)。
      // 記録を消したと確かめられたときだけ閉じ、今までどおりの error にする (nonce の予約は残さない・金額を変えた
      // 再試行も通常決済もできる)。確かめられなければ、残った op が後で送られうるので開いたまま。
      if (!host.discard()) {
        return holdAsUnknown(host, sent, 'pimlico.send.rejected-unverified', error);
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
    // 保存から 7 日を過ぎ、候補のどれにも receipt が無い。記録を消したと確かめてから閉じる (今の account で送れるかに
    // 依存しない: 委任を外した・変えた後も、ここで閉じられる)。
    //   c4 (open): EntryPoint の nonce も未使用。7 日前の署名済みの op を今送ると、その時点で支払いが成立しうるので
    //     送り直さない。保存の期限は署名を取り消さない (残った op を誰かが送れば後から成立しうる・PR の「限界」)。
    //   c5 (consumed): nonce はもう使われたので、候補の op はどれももう実行されない (同じ nonce は 1 本だけ)。開いたまま
    //     にする目的は「払い済みかもしれない支払いを、もう一度払わせない」ことだけで、将来の二重の実行を防ぐ意味は無い。
    //     期限まで待ったので閉じる (端末に永久に残る止めを作らない。実は払い済みだった可能性は残る・PR の「限界」)。
    if (!host.discard()) {
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
    // 送り直しの前に保存を確かめられない (memory にしか無い op): 送らず開いたまま。
    onNotStored: (stored) => {
      host.setStoreUnavailable(true);
      return stayOpen(host, record, 'pimlico.send.not-stored', new Error(`persist-${stored}`));
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
