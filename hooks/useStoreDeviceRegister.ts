'use client';

// 「お店の端末で送る」のレジ端末側の状態 (plans/store-gas-wallet.md §13〜14 P2b-2)。
// 店員に見せる名前は「お店がガス代を肩代わりして送る」(呼び名の対応は lib/storeDevicePayment.ts の冒頭)。
//   QR を出す → 受け渡しセッションを作る → 署名を待つ (モーダルを出している間だけ読む) → 受け取ったら
//   自分で確かめて送る (lib/storeDeviceSend) → 結果 (入金を確認 = 品物を渡す合図・確定) を出す。
//
// 決まり:
//   - 使わなくなったセッション (モーダルを閉じた・QR を出し直す・別の会計・再読み込み) は締め切る
//     (/close)。締め切る前に署名が入っていたら、それを受け取って送る。
//   - 受け渡しのトークンはタブ限定の sessionStorage (最長 10 分) に置き、再読み込み後も締め切り・送信を続ける。
//   - 送った印 (lib/storeDeviceSend) から、再読み込み後も前回の送信の結果を出す。
//   - 付帯の通信 (締め切り・tx の記録・確定の確認) の失敗は、送信と結果の表示に波及させない (no-throw)。
//   - flag OFF・切替 OFF (enabled = false) では effect も通信も起こさない。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import {
  STORE_DEVICE_QR_MIN_REMAINING_SEC,
  STORE_HANDOFF_TOKEN_HEADER,
  STORE_HANDOFF_TTL_SEC,
  isStoreDeviceChain,
  storeDeviceChainConfig,
} from '@/lib/storeDevicePayment';
import type {
  DeviceAuth,
  DeviceNotSentReason,
  DeviceReceipt,
  DeviceSentMark,
  DeviceVerifyReject,
} from '@/lib/storeDeviceSend';

export const STORE_DEVICE_SESSION_KEY = 'openpay:register-store-device-session:v1';
// 署名を待つ間の読み取り間隔 (最初の 60 秒は 3 秒・以降 6 秒)。
export const STORE_DEVICE_READ_FAST_MS = 3_000;
export const STORE_DEVICE_READ_SLOW_MS = 6_000;
const READ_FAST_FOR_SEC = 60;
// 読み取りがこれだけ続けて失敗したら「通常の QR に切り替える」を出す。
const DEGRADED_AFTER_MS = 30_000;
// お客様が署名を預けられる最後 (サーバは残り 60 秒未満の署名を受けない) を過ぎたら締め切る。
const CLOSE_WHEN_REMAINING_SEC = 55;
// 送った tx の receipt を待つ時間。
const RECEIPT_TIMEOUT_MS = 90_000;
// 確定の確認 (サーバの判定) の間隔と、確認を続ける時間。
const FINALITY_POLL_MS = 10_000;
const FINALITY_WATCH_MS = 5 * 60_000;
// 結果が分からない送信の結論を待つ時間 (署名の期限 150 秒 + 確定ブロックまで十分に)。
const UNKNOWN_WATCH_MS = 15 * 60_000;
// 再読み込み後に結果を出す送信の新しさ。
const RECENT_MARK_MS = 15 * 60_000;
// 店の tx の revert の後に 1 回だけ引くサーバの判定を待つ上限 (route の maxDuration 20 秒 + 余裕)。
const REVERT_RESOLVE_TIMEOUT_MS = 25_000;

export type DeviceSession = {
  id: string;
  token: string;
  expiresAt: number;
  merchant: Address;
  /** 請求額 (wei の 10 進文字列)。 */
  amount: string;
  chainId: number;
};

export type StoreDeviceCreateFailure = 'busy' | 'unavailable' | 'invalid';

export type StoreDeviceRegisterState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'create_failed'; reason: StoreDeviceCreateFailure }
  // 署名を待っている。stale = QR の受付時間が残り少ない (薄くして出し直しを促す)・degraded = 読み取りが続けて失敗
  | { phase: 'waiting'; session: DeviceSession; stale: boolean; degraded: boolean }
  | { phase: 'expired' }
  | { phase: 'processing' }
  // 受け取った署名がこの会計と一致しない (送らない)
  | { phase: 'rejected'; reason: DeviceVerifyReject }
  | { phase: 'not_sent'; reason: DeviceNotSentReason; canRetry: boolean }
  | { phase: 'sent'; mark: DeviceSentMark; previous: boolean }
  // 入金を確認 (この支払いの Settled が receipt にある = 品物を渡す合図)。finalized = サーバの判定で確定。
  // txHash = サーバの判定が見つけた、実際に成立した tx (第三者が同じ署名を先に送ったときは mark.hash と違う・
  // 第 7 回レビュー A11)。無ければ mark.hash (端末が送った tx) が成立した tx。
  | { phase: 'received'; mark: DeviceSentMark; finalized: boolean; previous: boolean; txHash?: Hex }
  | { phase: 'reverted'; mark: DeviceSentMark; previous: boolean }
  // 送った tx が期限までに成立しなかったとサーバの判定で確かめた (お支払いは行われていない)
  | { phase: 'failed'; mark: DeviceSentMark; previous: boolean }
  // まだ結果が分からない (receipt 待ちの時間切れ・通信断)。「いま確認する」で続ける。
  | { phase: 'unknown'; mark: DeviceSentMark; previous: boolean };

type FinalizeResult = 'closed' | 'processing' | 'unknown';

/** 新しい QR (通常の QR を含む) を出せない状態か。 */
function isBusy(s: StoreDeviceRegisterState): boolean {
  return (
    s.phase === 'creating' ||
    s.phase === 'processing' ||
    // 送った tx の結果がまだ分からない間も次の QR を出さない (成立していれば二重払いになる)。再読み込みの後の
    // 「前回の送信」も同じ (送っている途中で再読み込みした会計は、まだお客様の前にあるかもしれない)。
    // 出口は結論 (入金の確認・成立しなかった) か、店員が取引を確かめて閉じること。
    s.phase === 'sent' ||
    s.phase === 'unknown'
  );
}

export type StoreDeviceRegisterInput = {
  enabled: boolean;
  /**
   * 送った支払いの結果を確かめる (再読み込みの後の「前回の送信」)。送る設定 (enabled) と別: 切替を OFF にした・
   * ガス用ウォレットを消した後も、送った支払いの行方は隠さない。省略時は enabled と同じ。
   */
  monitor?: boolean;
  gasAddress: Address | null;
};

// 再送してよい「送らなかった」理由 (一時的なもの・お客様の署名がまだ有効なら)。
const RETRYABLE: readonly DeviceNotSentReason[] = [
  'rpc',
  'gas_too_high',
  'native_insufficient',
  'send_rejected',
  'storage',
];

function readStoredSession(): DeviceSession | null {
  try {
    const raw = window.sessionStorage.getItem(STORE_DEVICE_SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<DeviceSession>;
    return typeof v.id === 'string' &&
      typeof v.token === 'string' &&
      typeof v.expiresAt === 'number' &&
      typeof v.merchant === 'string' &&
      typeof v.amount === 'string' &&
      typeof v.chainId === 'number'
      ? (v as DeviceSession)
      : null;
  } catch {
    return null;
  }
}

function storeSession(s: DeviceSession | null): void {
  try {
    if (s) window.sessionStorage.setItem(STORE_DEVICE_SESSION_KEY, JSON.stringify(s));
    else window.sessionStorage.removeItem(STORE_DEVICE_SESSION_KEY);
  } catch {
    // 保存できなくても今のタブでは続けられる (再読み込み後の再開ができないだけ)。
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

type DeviceView = {
  state?: string;
  merchant?: unknown;
  amount?: unknown;
  auth?: DeviceAuth | null;
};

async function readDeviceView(s: DeviceSession): Promise<{ status: number; body: DeviceView | null }> {
  const res = await fetch(`/api/register/handoff/${encodeURIComponent(s.id)}`, {
    headers: { [STORE_HANDOFF_TOKEN_HEADER]: s.token },
    cache: 'no-store',
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as DeviceView | null };
}

type ResolveBody = { ok?: boolean; state?: string; txHash?: unknown } | null;

const isTxHash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/** この送信 (mark) の支払いの結論をサーバの判定に問う (/api/register/handoff/resolve)。通信の失敗は throw。 */
async function postResolve(
  mark: DeviceSentMark,
  config: { forwarder: Address; feeReceiver: Address },
  signal?: AbortSignal,
): Promise<ResolveBody> {
  const res = await fetch('/api/register/handoff/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: mark.chainId,
      from: mark.from,
      merchant: mark.merchant,
      merchantValue: mark.amount,
      validBefore: mark.validBefore,
      intentSalt: mark.intentSalt,
      nonce: mark.nonce,
      forwarder: config.forwarder,
      feeReceiver: config.feeReceiver,
      txHash: mark.hash,
    }),
    ...(signal ? { signal } : {}),
  });
  return (await res.json().catch(() => null)) as ResolveBody;
}

/**
 * 店の tx が revert した支払いを、サーバの判定で 1 回だけ確かめる (第 7 回レビュー A3)。forwarder の settle は誰でも
 * 送れるので、お客様の端末などが同じ署名を先に成立させると店の tx だけが revert する (revert は「お支払いは行われて
 * いない」の証明ではない)。成立 (確定済みの Settled) ならその tx の hash、それ以外 (確認中・未使用・読めない) は null。
 */
async function settledTxAfterRevert(
  mark: DeviceSentMark,
  config: { forwarder: Address; feeReceiver: Address },
): Promise<Hex | null> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 応答が返らなくても「送信しました」(次の QR を出せない) のまま止めない (上限で従来の reverted へ進む)。
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve(null);
    }, REVERT_RESOLVE_TIMEOUT_MS);
  });
  try {
    const body = await Promise.race([postResolve(mark, config, abort.signal), timedOut]);
    return body?.ok && body.state === 'settled' && isTxHash(body.txHash) ? body.txHash : null;
  } catch {
    // 判定の照会は付帯: 通信の失敗は「成立を確かめられない」= 従来どおり reverted (結果の表示に波及させない)。
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 送った印の一覧から、この署名 (nonce) の印を探す。送信 (sendStoreDeviceSettle) は印を残して読み戻してから送るので、
 * 印が無い = 送っていない。一覧を読めないときも null (印を書けない・読めない端末では送信が not_sent で止まる)。
 */
function findSentMark(
  read: { ok: true; marks: DeviceSentMark[] } | { ok: false },
  nonce: string,
): DeviceSentMark | null {
  if (!read.ok) return null;
  return read.marks.find((m) => m.nonce.toLowerCase() === nonce.toLowerCase()) ?? null;
}

/** 締め切る。署名が先に入っていればそれを返す。通信の失敗は null (締め切れたか分からない)。 */
async function closeSession(s: DeviceSession): Promise<{ closed: true } | { closed: false; auth: DeviceAuth } | null> {
  try {
    const res = await fetch(`/api/register/handoff/${encodeURIComponent(s.id)}/close`, {
      method: 'POST',
      headers: { [STORE_HANDOFF_TOKEN_HEADER]: s.token },
    });
    if (res.status === 404) return { closed: true }; // もう無い (期限切れ) = 締め切ったのと同じ
    const body = (await res.json().catch(() => null)) as { ok?: boolean; closed?: boolean; auth?: DeviceAuth } | null;
    if (!res.ok || !body?.ok) return null;
    return body.closed === false && body.auth ? { closed: false, auth: body.auth } : { closed: true };
  } catch {
    return null;
  }
}

export function useStoreDeviceRegister(input: StoreDeviceRegisterInput) {
  const { enabled, gasAddress } = input;
  const monitor = input.monitor ?? enabled;
  const [state, setState] = useState<StoreDeviceRegisterState>({ phase: 'idle' });
  // いまの状態の写し (描画を待たずに読む)。「通常の QR を出してよいか」などの判定は描画前の古い state で
  // しない (署名を受け取って送り始めた直後に、古い「署名待ち」を見て通常の QR を出す = 二重払いの種)。
  const stateRef = useRef<StoreDeviceRegisterState>({ phase: 'idle' });
  const sessionRef = useRef<DeviceSession | null>(null);
  // 同じ署名を二度処理しない (読み取りの次の回・締め切りの応答が重なっても)。
  const processingRef = useRef<string | null>(null);
  // いま確かめて送っている署名 (送信の結果が出るまで)。
  const activeRef = useRef<string | null>(null);
  // 次の QR を作る・通常の QR に切り替える処理の最中 (どちらも前の受け渡しの締め切りを待つので、重ねると
  // 同じ会計で二つの QR を出しうる)。一つずつ通し、その間は次の QR も切替も操作させない。
  const transitionRef = useRef(false);
  const [transitioning, setTransitioning] = useState(false);
  // 起動時に最近の送信の結果を確かめている間 (読み込みが遅いと「何もしていない」に見える)。その間は次の QR も
  // 通常の QR も出させない (送っている途中で再読み込みした会計を、もう一度払わせない)。
  const recoveringRef = useRef(false);
  const recoveryRunRef = useRef(0);
  const [recovering, setRecovering] = useState(false);
  // 「もう一度送る」に使う、確かめ済みの署名 (送らなかったときだけ・このタブのメモリだけ)。
  const retryRef = useRef<{ view: DeviceView & { auth: DeviceAuth }; session: DeviceSession } | null>(null);
  const finalityStopRef = useRef<(() => void) | null>(null);
  // QR を閉じたときの締め切り (応答待ち)。次の QR・通常の QR はこれを待ってから出す
  // (遅れて返った署名を送ったのに、通常の QR でも払わせる、を起こさない)。
  const pendingCloseRef = useRef<Promise<FinalizeResult> | null>(null);
  // セッションごとの締め切り (同じセッションの締め切りは一つの応答を共有する = 遅れて返った応答で別の判断をしない)。
  const closesRef = useRef(new Map<string, Promise<FinalizeResult>>());
  // 店員が通常の QR を選んで手放したセッション (後から署名が見つかっても送らない = 二重払いにしない)。
  const abandonedRef = useRef(new Set<string>());
  // 新しい QR を出す・切替を OFF にするたびに進める。遅れて返った結果で今の表示を上書きしない。
  const genRef = useRef(0);
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      finalityStopRef.current?.();
    };
  }, []);
  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      // 切替 OFF: 確定の確認を止め、進行中の結果で表示を変えない (以後の署名は送らない = process で止める)。
      genRef.current += 1;
      finalityStopRef.current?.();
      retryRef.current = null;
      // 送っている・結果を待っている支払いがあれば、その表示 (と次の QR を出さない状態) は残す
      // (取り消せない送信の結果を隠して、通常の QR で二重に払わせない)。
      // QR を作っている途中なら作るのをやめる (遅れて返ったセッションは start が手放す)。
      if (
        stateRef.current.phase !== 'idle' &&
        !activeRef.current &&
        (!isBusy(stateRef.current) || stateRef.current.phase === 'creating')
      ) {
        stateRef.current = { phase: 'idle' };
        if (mountedRef.current) setState({ phase: 'idle' });
      }
    }
  }, [enabled]);
  const set = useCallback((s: StoreDeviceRegisterState) => {
    stateRef.current = s;
    if (mountedRef.current) setState(s);
  }, []);
  const withTransition = useCallback(async <T,>(busyResult: T, fn: () => Promise<T>): Promise<T> => {
    if (transitionRef.current) return busyResult;
    transitionRef.current = true;
    if (mountedRef.current) setTransitioning(true);
    try {
      return await fn();
    } finally {
      transitionRef.current = false;
      if (mountedRef.current) setTransitioning(false);
    }
  }, []);
  /** いまこの送信 (mark) の結果を表示しているか (別の会計の表示を、前の送信の確認の結果で上書きしない)。 */
  const showsMark = useCallback((mark: DeviceSentMark) => {
    const cur = stateRef.current;
    return 'mark' in cur && cur.mark.hash === mark.hash;
  }, []);
  /** gen の時点からの結果だけを表示する (新しい QR・切替 OFF の後は捨てる)。 */
  const setIf = useCallback(
    (gen: number, s: StoreDeviceRegisterState) => {
      if (gen === genRef.current) set(s);
    },
    [set],
  );

  // チェーン由来の値 (JPYC・forwarder・手数料受取口・RPC) は、いつもセッション/印の chainId から引く (Fable 必須 1:
  // 設定のチェーンを切り替えた直後に、前の会計の署名を別チェーンの値で確かめたり送ったりしない)。
  const loadIo = useCallback(
    async (chainId: number) => {
      const config = storeDeviceChainConfig(chainId);
      if (!config || !gasAddress) return null;
      const mod = await import('@/lib/storeDeviceSend');
      return { mod, config, io: mod.createDeviceIo({ ...config, gasAddress }) };
    },
    [gasAddress],
  );
  // 結果を読むだけ (ガス用ウォレットが無くても読める)。
  const loadWatch = useCallback(async (chainId: number) => {
    const config = storeDeviceChainConfig(chainId);
    if (!config) return null;
    const mod = await import('@/lib/storeDeviceSend');
    return { mod, config, io: mod.createDeviceWatchIo(chainId) };
  }, []);

  // サーバの判定で結論を待つ (10 秒おき)。「入金を確認」の後は確定 (最長 5 分)、結果が分からないときは
  // 成立 (= 入金の確認・確定) か、期限までに成立しなかった (= お支払いは行われていない) まで (最長 15 分)。
  // 確認の失敗は表示を変えない。
  const watchFinality = useCallback(
    (mark: DeviceSentMark, previous: boolean, gen: number, fromUnknown = false) => {
      finalityStopRef.current?.();
      const config = storeDeviceChainConfig(mark.chainId);
      if (!config) return;
      let stopped = false;
      const started = Date.now();
      const tick = async () => {
        if (stopped || gen !== genRef.current) return;
        try {
          const body = await postResolve(mark, config);
          if (!stopped && body?.ok && body.state === 'settled') {
            if (showsMark(mark)) {
              // 判定が見つけた tx (実際に成立した tx) も持つ (端末が送った tx と違うことがある・第 7 回レビュー A11)。
              setIf(gen, {
                phase: 'received',
                mark,
                finalized: true,
                previous,
                ...(isTxHash(body.txHash) ? { txHash: body.txHash } : {}),
              });
            }
            return;
          }
          if (!stopped && fromUnknown && body?.ok && body.state === 'expired_unused') {
            if (showsMark(mark)) setIf(gen, { phase: 'failed', mark, previous });
            return;
          }
        } catch {
          // 確定の確認は付帯 (次の回へ)
        }
        const limit = fromUnknown ? UNKNOWN_WATCH_MS : FINALITY_WATCH_MS;
        if (!stopped && Date.now() - started < limit) setTimeout(tick, FINALITY_POLL_MS);
      };
      setTimeout(tick, FINALITY_POLL_MS);
      finalityStopRef.current = () => {
        stopped = true;
      };
    },
    [setIf, showsMark],
  );

  // receipt で結果を出す (成功 + この支払いの Settled = 入金を確認)。
  const showReceipt = useCallback(
    async (
      mod: typeof import('@/lib/storeDeviceSend'),
      mark: DeviceSentMark,
      receipt: DeviceReceipt,
      previous: boolean,
      gen: number,
    ): Promise<void> => {
      if (gen !== genRef.current) return;
      const config = storeDeviceChainConfig(mark.chainId);
      if (!receipt || !config) {
        set({ phase: 'unknown', mark, previous });
        watchFinality(mark, previous, gen, true);
        return;
      }
      if (receipt.status === 'reverted') {
        // 第 7 回レビュー A3: 店の tx の revert だけで「お支払いは行われていません」と言わない。サーバの判定を 1 回引き、
        // 別の tx (同じ署名) で成立していれば入金の確認 (確定済み・実際に成立した tx) にする。それ以外は従来どおり reverted。
        // 判定を待つ間は今の表示 (送信しました・結果が分からない = 次の QR を出せない) のまま。
        const shown = stateRef.current;
        const settledTx = await settledTxAfterRevert(mark, config);
        // 待つ間に表示が変わった (閉じた・次の会計・別の確認が結論を出した) なら、遅れた判定で上書きしない。
        if (stateRef.current !== shown) return;
        if (settledTx) set({ phase: 'received', mark, finalized: true, previous, txHash: settledTx });
        else set({ phase: 'reverted', mark, previous });
        return;
      }
      if (mod.receiptHasSettlement(receipt.logs, config.forwarder, mark, config.feeReceiver)) {
        set({ phase: 'received', mark, finalized: false, previous });
        watchFinality(mark, previous, gen);
        return;
      }
      set({ phase: 'unknown', mark, previous });
      watchFinality(mark, previous, gen, true);
    },
    [set, watchFinality],
  );

  /** 送った tx の結果を確かめる。「送信しました」を出したところで返り、結果は続けて確かめる。 */
  const watch = useCallback(
    async (mark: DeviceSentMark, previous: boolean): Promise<void> => {
      const loaded = await loadWatch(mark.chainId);
      // 読み込みの間に別の会計の表示 (送っている・署名を待っている) に変わっていたら上書きしない。
      if (!loaded || activeRef.current || stateRef.current.phase !== 'idle') return;
      set({ phase: 'sent', mark, previous });
      void (async () => {
        const receipt = await loaded.io.waitReceipt(mark.hash, RECEIPT_TIMEOUT_MS);
        // 切替 OFF・ガス用ウォレットの削除で世代が進んでも、この送信の「送信しました」を出したままなら結果を出す
        // (出さないと次の QR を出せないまま残る)。別の表示に変わっていたら上書きしない。
        const cur = stateRef.current;
        if (cur.phase !== 'sent' || cur.mark.hash !== mark.hash) return;
        await showReceipt(loaded.mod, mark, receipt, previous, genRef.current);
      })();
    },
    [loadWatch, set, showReceipt],
  );

  /** このセッションを今後の自動処理から外す (メモリとタブの保存の両方)。 */
  const retire = useCallback((s: DeviceSession) => {
    if (sessionRef.current?.id === s.id) sessionRef.current = null;
    if (readStoredSession()?.id === s.id) storeSession(null);
  }, []);

  // 受け取った署名を確かめて送る。送り始めたら、その結果 (送った・送らなかった・入金の確認) は必ず表示する
  // (実際の支払いの行方なので、次の会計の表示より優先する・送っている間は次の QR を出させない)。
  const process = useCallback(
    async (view: DeviceView & { auth: DeviceAuth }, session: DeviceSession) => {
      // 切替 OFF の後に届いた署名は送らない (送らなければお客様は期限後に「行われていない」で結論が出る)。
      if (!enabledRef.current) return;
      // 手放したセッション (通常の QR・別のタブへ移った) の署名は、遅れて返った読み取りでも送らない (二重払いにしない)。
      if (abandonedRef.current.has(session.id)) return;
      if (processingRef.current === view.auth.nonce) return;
      processingRef.current = view.auth.nonce;
      activeRef.current = view.auth.nonce;
      // 処理に入った受け渡しは、再読み込み・次の会計で自動で処理し直さない (送らなかった署名を後から送らない)。
      retire(session);
      // 前の送信 (再読み込みの後の「前回の送信」など) の確認の結果で、この会計の表示を上書きしない。
      genRef.current += 1;
      finalityStopRef.current?.();
      set({ phase: 'processing' });
      // 例外の行き先を分ける境界 (下の catch・第 7 回レビュー A12): 送信を呼んだか・送った印を受け取ったか。
      let sendMod: typeof import('@/lib/storeDeviceSend') | null = null;
      let sendCalled = false;
      let sentMark: DeviceSentMark | null = null;
      try {
        const loaded = await loadIo(session.chainId);
        if (!loaded) {
          set({ phase: 'not_sent', reason: 'rpc', canRetry: false });
          return;
        }
        const { mod, io, config } = loaded;
        sendMod = mod;
        const verified = await mod.verifyDeviceAuth(
          { merchant: view.merchant, amount: view.amount, auth: view.auth },
          {
            chainId: session.chainId,
            token: config.token,
            forwarder: config.forwarder,
            feeReceiver: config.feeReceiver,
            merchant: session.merchant,
            amount: BigInt(session.amount),
          },
        );
        if (!verified.ok) {
          set({ phase: 'rejected', reason: verified.reason });
          return;
        }
        // 確かめている間に切替を OFF にした → 送らない (送らなければお支払いは行われない・表示を戻す)。
        if (!enabledRef.current) {
          set({ phase: 'idle' });
          return;
        }
        sendCalled = true;
        const r = await mod.sendStoreDeviceSettle(
          verified.value,
          { handoffId: session.id, chainId: session.chainId, forwarder: config.forwarder },
          io,
        );
        if (r.kind === 'not_sent') {
          const canRetry = RETRYABLE.includes(r.reason);
          retryRef.current = canRetry ? { view, session } : null;
          // 「もう一度送る」で同じ署名を処理できるように戻す (印は残っていない)。
          processingRef.current = null;
          set({ phase: 'not_sent', reason: r.reason, canRetry });
          return;
        }
        sentMark = r.mark;
        retryRef.current = null;
        // 送った tx をお客様の画面に知らせる (付帯・失敗しても送信は成立している)。
        void fetch(`/api/register/handoff/${encodeURIComponent(session.id)}/tx`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [STORE_HANDOFF_TOKEN_HEADER]: session.token },
          body: JSON.stringify({ txHash: r.hash }),
        }).catch(() => undefined);
        set({ phase: 'sent', mark: r.mark, previous: false });
        const receipt = await io.waitReceipt(r.hash, RECEIPT_TIMEOUT_MS);
        await showReceipt(mod, r.mark, receipt, false, genRef.current);
      } catch {
        // 第 7 回レビュー A12: 店側の処理の例外 (送信の部品 = 動的 import の chunk の読み込み失敗など) で「確かめて
        // 送っています」のまま止めない (次の QR・通常の QR・閉じる操作を止め続けない・受け渡しは retire 済み)。
        // 送った可能性がある支払いを「送っていない」とは言わない: 送信は印を残してから送る (lib/storeDeviceSend) ので、
        // この署名の印があれば結果が分からない (unknown) としてサーバの判定を待ち、印の前 (印が無い) なら送っていない。
        const mark =
          sentMark ??
          (sendCalled && sendMod ? findSentMark(sendMod.readSentMarks(), view.auth.nonce) : null);
        if (mark) {
          const cur = stateRef.current;
          // 結果 (入金の確認など) を出した後の例外なら、その表示のまま。
          if (cur.phase === 'processing' || (cur.phase === 'sent' && cur.mark.hash === mark.hash)) {
            set({ phase: 'unknown', mark, previous: false });
            watchFinality(mark, false, genRef.current, true);
          }
        } else {
          // 送っていない (印の前)。同じ署名は印で二度送られないので「もう一度送る」を出せる。
          retryRef.current = { view, session };
          processingRef.current = null;
          set({ phase: 'not_sent', reason: 'rpc', canRetry: true });
        }
      } finally {
        if (activeRef.current === view.auth.nonce) activeRef.current = null;
      }
    },
    [loadIo, retire, set, showReceipt, watchFinality],
  );

  // セッションを締め切る (署名が入っていれば送る)。同じセッションの締め切りは一つの応答を共有する。
  const finalize = useCallback(
    (s: DeviceSession): Promise<FinalizeResult> => {
      const running = closesRef.current.get(s.id);
      if (running) return running;
      const p = (async (): Promise<FinalizeResult> => {
        const r = await closeSession(s);
        if (r === null) return 'unknown';
        if (r.closed) {
          retire(s);
          return 'closed';
        }
        // いま送っている署名 → 二度処理しない・通常の QR も出させない。
        if (activeRef.current === r.auth.nonce) return 'processing';
        // 手放したセッション・処理を終えた署名・切替 OFF → 送らない。
        if (abandonedRef.current.has(s.id) || processingRef.current === r.auth.nonce || !enabledRef.current) {
          retire(s);
          return 'closed';
        }
        void process({ merchant: s.merchant, amount: s.amount, auth: r.auth }, s);
        return 'processing';
      })();
      closesRef.current.set(s.id, p);
      // 応答が分からなかったときは、次に締め切るときに問い合わせ直せるようにする。
      void p.then((r) => {
        if (r === 'unknown' && closesRef.current.get(s.id) === p) closesRef.current.delete(s.id);
      });
      return p;
    },
    [process, retire],
  );

  // 起動時 (1): 前のタブで使っていたセッションを締め切る (署名があれば送る = 送る設定が ON のときだけ)。
  useEffect(() => {
    if (!enabled) return;
    const stored = readStoredSession();
    if (stored && stored.expiresAt > nowSec()) void finalize(stored);
    else if (stored) storeSession(null);
    // 起動時に 1 回だけ (enabled が ON になったときも)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // 起動時 (2): 最近の送信の結果を「前回の送信」として確かめる (送る設定の ON/OFF・ウォレットの有無と関係なく)。
  // 確かめ始めるまでの間も次の QR を出させない (recovering)。
  useEffect(() => {
    if (!monitor) return;
    let cancelled = false;
    // この回の確認だけが「確かめている間」を下ろす (開発時の StrictMode で effect が 2 回走っても、
    // 1 回目の終わりで 2 回目の確認中を「終わった」にしない)。
    const run = (recoveryRunRef.current += 1);
    recoveringRef.current = true;
    setRecovering(true);
    void (async () => {
      try {
        const { readSentMarks } = await import('@/lib/storeDeviceSend');
        const marks = readSentMarks();
        // 前のタブのセッションの署名を送っている (この会計) なら、前回の結果で上書きしない。
        if (cancelled || !marks.ok || activeRef.current || stateRef.current.phase !== 'idle') return;
        const recent = marks.marks
          // 送った印はどのチェーンでも (開示から外したチェーンでも、設定が残っていれば結果を確かめる)。
          .filter((m) => Date.now() - m.at < RECENT_MARK_MS && storeDeviceChainConfig(m.chainId) !== null)
          .sort((a, b) => b.at - a.at)[0];
        // 「送信しました」を出すまでを待つ (その後は sent / unknown が次の QR を止める)。
        if (recent) await watch(recent, true);
      } finally {
        if (recoveryRunRef.current === run) {
          recoveringRef.current = false;
          if (mountedRef.current) setRecovering(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 起動時に 1 回だけ (確かめられるようになったときも)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitor]);

  // 署名を待つ間の読み取り (waiting のときだけ)。
  const waitingSession = state.phase === 'waiting' ? state.session : null;
  useEffect(() => {
    if (!enabled || !waitingSession) return;
    const s = waitingSession;
    const gen = genRef.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failingSince: number | null = null;
    const createdAt = s.expiresAt - STORE_HANDOFF_TTL_SEC;
    const tick = async () => {
      if (stopped) return;
      const remaining = s.expiresAt - nowSec();
      if (remaining < CLOSE_WHEN_REMAINING_SEC) {
        const r = await finalize(s);
        if (!stopped && r !== 'processing') setIf(gen, { phase: 'expired' });
        return;
      }
      try {
        const { status, body } = await readDeviceView(s);
        if (stopped) return;
        if (status === 404) {
          retire(s);
          setIf(gen, { phase: 'expired' });
          return;
        }
        if (status === 200 && body) {
          failingSince = null;
          if (body.auth) {
            void process({ ...body, auth: body.auth }, s);
            return;
          }
          if (body.state === 'closed') {
            setIf(gen, { phase: 'expired' });
            return;
          }
        } else {
          failingSince ??= Date.now();
        }
      } catch {
        failingSince ??= Date.now();
      }
      if (stopped) return;
      setIf(gen, {
        phase: 'waiting',
        session: s,
        stale: s.expiresAt - nowSec() < STORE_DEVICE_QR_MIN_REMAINING_SEC,
        degraded: failingSince !== null && Date.now() - failingSince >= DEGRADED_AFTER_MS,
      });
      const fast = nowSec() - createdAt < READ_FAST_FOR_SEC;
      timer = setTimeout(tick, fast ? STORE_DEVICE_READ_FAST_MS : STORE_DEVICE_READ_SLOW_MS);
    };
    timer = setTimeout(tick, STORE_DEVICE_READ_FAST_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // waiting の表示の更新 (stale・degraded) では読み直さない (同じセッションの間は 1 本のループ)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, waitingSession?.id]);

  /** 前のセッション (閉じた QR の締め切り待ち・残っているもの) を片付ける。署名が入っていたら 'processing'。 */
  const settlePrevious = useCallback(async (): Promise<FinalizeResult> => {
    const pending = pendingCloseRef.current;
    if (pending) {
      const r = await pending;
      if (pendingCloseRef.current === pending) pendingCloseRef.current = null;
      // 閉じた QR の署名を送っている (送り終えて結果が出ていれば、もう待つものは無い = 次へ進めてよい)。
      if (r === 'processing' && (activeRef.current || isBusy(stateRef.current))) return r;
    }
    const prev = sessionRef.current ?? readStoredSession();
    return prev ? finalize(prev) : 'closed';
  }, [finalize]);

  /** QR を出す: 前のセッションを締め切ってから、新しいセッションを作る。作れなければ null。 */
  const start = useCallback(
    async (merchant: Address, amount: bigint, chainId: number): Promise<DeviceSession | null> => {
      // 二度押しで二つのセッションを作らない。送っている・送った結果を待っている間は次の QR を作らない
      // (どちらも描画を待たずに判定)。チェーンは QR の写しと同じもの (呼び出し側が渡す)・新しい会計に使えないチェーン
      // (開示していない・設定が無い) では作らない。
      if (!enabled || activeRef.current || recoveringRef.current || isBusy(stateRef.current)) return null;
      if (!isStoreDeviceChain(chainId)) return null;
      return withTransition<DeviceSession | null>(null, () => createNext(merchant, amount));

      async function createNext(merchant: Address, amount: bigint): Promise<DeviceSession | null> {
        genRef.current += 1;
        const gen = genRef.current;
        finalityStopRef.current?.();
        // 前の会計の「もう一度送る」は、新しい QR を出したら使わせない (別の支払いと重ねない)。
        retryRef.current = null;
        // 前の会計に署名が入っていた → その送信を優先する (新しい QR は出さない)。
        if ((await settlePrevious()) === 'processing') return null;
        // 締め切りを待つ間に切替を OFF にした・別の操作で世代が進んだ → 作らずに終える。
        if (gen !== genRef.current || !enabledRef.current) return null;
        setIf(gen, { phase: 'creating' });
        let res: Response;
        try {
          res = await fetch('/api/register/handoff', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chainId, merchant, amount: amount.toString() }),
          });
        } catch {
          setIf(gen, { phase: 'create_failed', reason: 'unavailable' });
          return null;
        }
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; id?: string; token?: string; expiresAt?: number }
          | null;
        if (!res.ok || !body?.ok || !body.id || !body.token || typeof body.expiresAt !== 'number') {
          setIf(gen, {
            phase: 'create_failed',
            reason: res.status === 429 ? 'busy' : res.status === 400 ? 'invalid' : 'unavailable',
          });
          return null;
        }
        const session: DeviceSession = {
          id: body.id,
          token: body.token,
          expiresAt: body.expiresAt,
          merchant,
          amount: amount.toString(),
          chainId,
        };
        // 作っている間に切替を OFF にした・通常の QR に切り替えた → この QR は出さず、手放して締め切る。
        if (gen !== genRef.current || !enabledRef.current) {
          abandonedRef.current.add(session.id);
          void finalize(session);
          return null;
        }
        sessionRef.current = session;
        processingRef.current = null;
        storeSession(session);
        setIf(gen, { phase: 'waiting', session, stale: false, degraded: false });
        return session;
      }
    },
    [enabled, settlePrevious, setIf, finalize, withTransition],
  );

  /** QR を閉じる: 署名を待っていたセッションは締め切る (署名が入っていれば送る)。 */
  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (!s || stateRef.current.phase !== 'waiting') return;
    set({ phase: 'idle' });
    const p = finalize(s);
    pendingCloseRef.current = p;
    // 締め切れた (署名は無かった) → 待つものは無い (タブの移動などで締め切りを待ち直さない)。
    void p.then((r) => {
      if (r === 'closed' && pendingCloseRef.current === p) pendingCloseRef.current = null;
    });
  }, [finalize, set]);

  /**
   * 別のタブへ移る前に leave を通す必要があるか: 締め切っていない受け渡し (署名を待っている・閉じた QR の締め切りの
   * 応答待ち・応答が分からなかったもの・前のタブのもの) か、「もう一度送る」で送れる署名がある。描画を待たずに読む。
   */
  const hasPendingSale = useCallback(
    () =>
      stateRef.current.phase === 'waiting' ||
      pendingCloseRef.current !== null ||
      retryRef.current !== null ||
      (sessionRef.current ?? readStoredSession()) !== null,
    [],
  );

  /**
   * 作成ページで別のタブへ移ってよいか (移った先では通常の QR を出せる): 受け渡しを締め切り、署名が入っていたら
   * 端末が送るので移らせない (false)。締め切りの応答が分からないときは、そのセッションを自動で処理しない (送らない)
   * ことにして true (releaseForNormal と同じ)。前の会計の「もう一度送る」も使わせない (移った先で通常の QR で
   * 払った後に、同じ会計の署名を送らない)。送った支払いの結果の表示 (入金の確認・確定) はそのまま続ける。
   */
  const leave = useCallback(
    (): Promise<boolean> =>
      withTransition(false, async () => {
        if (activeRef.current || recoveringRef.current || isBusy(stateRef.current)) return false;
        stop();
        retryRef.current = null;
        const cur = stateRef.current;
        if (cur.phase === 'not_sent' && cur.canRetry) set({ ...cur, canRetry: false });
        const r = await settlePrevious();
        // 締め切りの応答を待つ間に送り始めた (読み取りが署名を受け取った) ときも移らせない。
        if (r === 'processing' || activeRef.current || isBusy(stateRef.current)) return false;
        if (r === 'unknown') {
          const prev = sessionRef.current ?? readStoredSession();
          if (prev) {
            abandonedRef.current.add(prev.id);
            retire(prev);
          }
        }
        return true;
      }),
    [withTransition, stop, set, settlePrevious, retire],
  );

  /**
   * 通常の QR に切り替えてよいか: 署名を待っていたセッションを締め切り、署名が入っていなかったときだけ true
   * (署名が入っていたら端末が送るので、通常の QR は出さない = 二重払いにしない)。締め切りの応答が分からない
   * ときは、そのセッションを自動で処理しない (送らない) ことにして true。
   */
  const releaseForNormal = useCallback(
    (): Promise<boolean> =>
      withTransition(false, async () => {
        // 描画前の古い state ではなく、いまの状態で判定する (送り始めた直後に通常の QR を出さない)。
        if (activeRef.current || recoveringRef.current || isBusy(stateRef.current)) return false;
        genRef.current += 1;
        finalityStopRef.current?.();
        retryRef.current = null;
        if (sessionRef.current && stateRef.current.phase === 'waiting') set({ phase: 'idle' });
        const r = await settlePrevious();
        // 締め切りの応答を待つ間に送り始めた (読み取りが署名を受け取った) ときも出さない。
        if (r === 'processing' || activeRef.current || isBusy(stateRef.current)) return false;
        if (r === 'unknown') {
          // 締め切れたか分からないセッションは手放す (後から応答・署名が届いても送らない)。
          const prev = sessionRef.current ?? readStoredSession();
          if (prev) {
            abandonedRef.current.add(prev.id);
            retire(prev);
          }
        }
        set({ phase: 'idle' });
        return true;
      }),
    [withTransition, set, settlePrevious, retire],
  );

  /** 「いま確認する」(結果が分からないとき)。 */
  const checkNow = useCallback(async () => {
    const cur = stateRef.current;
    if (cur.phase !== 'unknown') return;
    const loaded = await loadWatch(cur.mark.chainId);
    if (!loaded) return;
    const receipt = await loaded.io.getReceipt(cur.mark.hash);
    // 待つ間に閉じた (取引を確かめた)・次の会計に進んだ → 遅れた結果で「次の QR を出せない」に戻さない。
    const now = stateRef.current;
    if (now.phase !== 'unknown' || now.mark.hash !== cur.mark.hash) return;
    await showReceipt(loaded.mod, cur.mark, receipt, cur.previous, genRef.current);
  }, [loadWatch, showReceipt]);

  /** 「もう一度送る」(一時的な理由で送らなかったとき・お客様の署名が有効な間)。 */
  const retry = useCallback(() => {
    const r = retryRef.current;
    if (state.phase !== 'not_sent' || !r) return;
    void process(r.view, r.session);
  }, [state.phase, process]);

  /** 結果の表示を閉じる (「もう一度送る」も使わせない)。署名を待っている・送っている間は何もしない。 */
  const dismiss = useCallback(() => {
    const phase = stateRef.current.phase;
    if (activeRef.current || phase === 'waiting' || phase === 'processing' || phase === 'creating') return;
    finalityStopRef.current?.();
    retryRef.current = null;
    set({ phase: 'idle' });
  }, [set]);

  // 新しい QR を出せない間 (受け取った署名を確かめて送っている・送った tx の結果を待っている・起動時に最近の送信を
  // 確かめ始めるまで・次の QR / 通常の QR / タブの移動の判断の最中)。
  const busy = isBusy(state) || transitioning || recovering;

  return { state, busy, start, stop, releaseForNormal, hasPendingSale, leave, checkNow, retry, dismiss };
}
