'use client';

// 「お店の端末で送る」のレジ端末側の状態 (plans/store-gas-wallet.md §13〜14 P2b-2)。
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
} from '@/lib/storeDevicePayment';
import type {
  DeviceAuth,
  DeviceNotSentReason,
  DeviceReceipt,
  DeviceSentMark,
  DeviceVerifyReject,
} from '@/lib/storeDeviceSend';

export const STORE_DEVICE_SESSION_KEY = 'openpay:register-store-device-session:v1';
export const STORE_DEVICE_TOGGLE_KEY = 'openpay:register-store-device:v1';
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
// 再読み込み後に結果を出す送信の新しさ。
const RECENT_MARK_MS = 15 * 60_000;

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
  | { phase: 'received'; mark: DeviceSentMark; finalized: boolean; previous: boolean }
  | { phase: 'reverted'; mark: DeviceSentMark; previous: boolean }
  // まだ結果が分からない (receipt 待ちの時間切れ・通信断)。「いま確認する」で続ける。
  | { phase: 'unknown'; mark: DeviceSentMark; previous: boolean };

export type StoreDeviceRegisterInput = {
  enabled: boolean;
  chainId: number;
  token: Address;
  forwarder: Address | null;
  feeReceiver: Address | null;
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
  const { enabled, chainId, token, forwarder, feeReceiver, gasAddress } = input;
  const [state, setState] = useState<StoreDeviceRegisterState>({ phase: 'idle' });
  const sessionRef = useRef<DeviceSession | null>(null);
  // 同じ署名を二度処理しない (読み取りの次の回・締め切りの応答が重なっても)。
  const processingRef = useRef<string | null>(null);
  // 「もう一度送る」に使う、確かめ済みの署名 (送らなかったときだけ)。
  const retryRef = useRef<{ view: DeviceView & { auth: DeviceAuth }; session: DeviceSession } | null>(null);
  const finalityStopRef = useRef<(() => void) | null>(null);
  // 新しい QR を出すたびに進める。前回の送信の確認が遅れて返っても、新しい会計の表示を上書きしない。
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      finalityStopRef.current?.();
    };
  }, []);
  const set = useCallback((s: StoreDeviceRegisterState) => {
    if (mountedRef.current) setState(s);
  }, []);

  const loadIo = useCallback(async () => {
    if (!forwarder || !gasAddress) return null;
    const mod = await import('@/lib/storeDeviceSend');
    return { mod, io: mod.createDeviceIo({ token, forwarder, gasAddress }) };
  }, [token, forwarder, gasAddress]);

  // 確定の確認 (サーバの判定・10 秒おき・最長 5 分)。失敗しても「入金を確認」の表示は変えない。
  const watchFinality = useCallback(
    (mark: DeviceSentMark, previous: boolean) => {
      finalityStopRef.current?.();
      if (!forwarder || !feeReceiver) return;
      let stopped = false;
      const started = Date.now();
      const tick = async () => {
        if (stopped) return;
        try {
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
              forwarder,
              feeReceiver,
              txHash: mark.hash,
            }),
          });
          const body = (await res.json().catch(() => null)) as { ok?: boolean; state?: string } | null;
          if (!stopped && body?.ok && body.state === 'settled') {
            set({ phase: 'received', mark, finalized: true, previous });
            return;
          }
        } catch {
          // 確定の確認は付帯 (次の回へ)
        }
        if (!stopped && Date.now() - started < FINALITY_WATCH_MS) setTimeout(tick, FINALITY_POLL_MS);
      };
      setTimeout(tick, FINALITY_POLL_MS);
      finalityStopRef.current = () => {
        stopped = true;
      };
    },
    [forwarder, feeReceiver, set],
  );

  // receipt で結果を出す (成功 + この支払いの Settled = 入金を確認)。
  const showReceipt = useCallback(
    (
      mod: typeof import('@/lib/storeDeviceSend'),
      mark: DeviceSentMark,
      receipt: DeviceReceipt,
      previous: boolean,
    ) => {
      if (!receipt || !forwarder || !feeReceiver) {
        set({ phase: 'unknown', mark, previous });
        return;
      }
      if (receipt.status === 'reverted') {
        set({ phase: 'reverted', mark, previous });
        return;
      }
      if (mod.receiptHasSettlement(receipt.logs, forwarder, mark, feeReceiver)) {
        set({ phase: 'received', mark, finalized: false, previous });
        watchFinality(mark, previous);
        return;
      }
      set({ phase: 'unknown', mark, previous });
    },
    [forwarder, feeReceiver, set, watchFinality],
  );

  const watch = useCallback(
    async (mark: DeviceSentMark, previous: boolean) => {
      const gen = genRef.current;
      const loaded = await loadIo();
      if (!loaded || gen !== genRef.current) return;
      set({ phase: 'sent', mark, previous });
      const receipt = await loaded.io.waitReceipt(mark.hash, RECEIPT_TIMEOUT_MS);
      if (gen !== genRef.current) return;
      showReceipt(loaded.mod, mark, receipt, previous);
    },
    [loadIo, set, showReceipt],
  );

  // 受け取った署名を確かめて送る。
  const process = useCallback(
    async (view: DeviceView & { auth: DeviceAuth }, session: DeviceSession) => {
      if (processingRef.current === view.auth.nonce) return;
      processingRef.current = view.auth.nonce;
      set({ phase: 'processing' });
      const loaded = await loadIo();
      if (!loaded || !forwarder || !feeReceiver) {
        set({ phase: 'not_sent', reason: 'rpc', canRetry: false });
        return;
      }
      const { mod, io } = loaded;
      const verified = await mod.verifyDeviceAuth(
        { merchant: view.merchant, amount: view.amount, auth: view.auth },
        {
          chainId: session.chainId,
          token,
          forwarder,
          feeReceiver,
          merchant: session.merchant,
          amount: BigInt(session.amount),
        },
      );
      if (!verified.ok) {
        set({ phase: 'rejected', reason: verified.reason });
        return;
      }
      const r = await mod.sendStoreDeviceSettle(
        verified.value,
        { handoffId: session.id, chainId: session.chainId, forwarder },
        io,
      );
      if (r.kind === 'not_sent') {
        const canRetry = RETRYABLE.includes(r.reason);
        retryRef.current = canRetry ? { view, session } : null;
        // 再送できるように同じ署名をもう一度処理できる状態に戻す (印は残っていない)。
        processingRef.current = null;
        set({ phase: 'not_sent', reason: r.reason, canRetry });
        return;
      }
      retryRef.current = null;
      storeSession(null);
      const marks = mod.readSentMarks();
      const mark = marks.ok ? marks.marks.find((m) => m.hash.toLowerCase() === r.hash.toLowerCase()) : undefined;
      if (!mark) {
        set({ phase: 'not_sent', reason: 'storage', canRetry: false });
        return;
      }
      // 送った tx をお客様の画面に知らせる (付帯・失敗しても送信は成立している)。
      void fetch(`/api/register/handoff/${encodeURIComponent(session.id)}/tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [STORE_HANDOFF_TOKEN_HEADER]: session.token },
        body: JSON.stringify({ txHash: r.hash }),
      }).catch(() => undefined);
      set({ phase: 'sent', mark, previous: false });
      const receipt = await io.waitReceipt(r.hash, RECEIPT_TIMEOUT_MS);
      showReceipt(mod, mark, receipt, false);
    },
    [loadIo, forwarder, feeReceiver, token, set, showReceipt],
  );

  // セッションを締め切る (署名が入っていれば送る)。
  const finalize = useCallback(
    async (s: DeviceSession): Promise<'closed' | 'processing' | 'unknown'> => {
      const r = await closeSession(s);
      if (r === null) return 'unknown';
      if (r.closed) {
        if (sessionRef.current?.id === s.id) sessionRef.current = null;
        storeSession(null);
        return 'closed';
      }
      void process({ merchant: s.merchant, amount: s.amount, auth: r.auth }, s);
      return 'processing';
    },
    [process],
  );

  // 起動時: 前のタブで使っていたセッションを締め切り (署名があれば送る)、最近の送信の結果を出す。
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const stored = readStoredSession();
      if (stored && stored.expiresAt > nowSec()) {
        const r = await finalize(stored);
        if (r !== 'closed' || cancelled) return;
      } else if (stored) {
        storeSession(null);
      }
      const { readSentMarks } = await import('@/lib/storeDeviceSend');
      const marks = readSentMarks();
      if (cancelled || !marks.ok) return;
      const recent = marks.marks
        .filter((m) => Date.now() - m.at < RECENT_MARK_MS && m.chainId === chainId)
        .sort((a, b) => b.at - a.at)[0];
      if (recent) void watch(recent, true);
    })();
    return () => {
      cancelled = true;
    };
    // 起動時に 1 回だけ (enabled が ON になったときも)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // 署名を待つ間の読み取り (waiting のときだけ)。
  const waitingSession = state.phase === 'waiting' ? state.session : null;
  useEffect(() => {
    if (!enabled || !waitingSession) return;
    const s = waitingSession;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failingSince: number | null = null;
    const createdAt = s.expiresAt - STORE_HANDOFF_TTL_SEC;
    const tick = async () => {
      if (stopped) return;
      const remaining = s.expiresAt - nowSec();
      if (remaining < CLOSE_WHEN_REMAINING_SEC) {
        const r = await finalize(s);
        if (!stopped && r !== 'processing') set({ phase: 'expired' });
        return;
      }
      try {
        const { status, body } = await readDeviceView(s);
        if (stopped) return;
        if (status === 404) {
          storeSession(null);
          set({ phase: 'expired' });
          return;
        }
        if (status === 200 && body) {
          failingSince = null;
          if (body.auth) {
            void process({ ...body, auth: body.auth }, s);
            return;
          }
          if (body.state === 'closed') {
            set({ phase: 'expired' });
            return;
          }
        } else {
          failingSince ??= Date.now();
        }
      } catch {
        failingSince ??= Date.now();
      }
      if (stopped) return;
      set({
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

  /** QR を出す: 前のセッションを締め切ってから、新しいセッションを作る。作れなければ null。 */
  const start = useCallback(
    async (merchant: Address, amount: bigint): Promise<DeviceSession | null> => {
      if (!enabled) return null;
      genRef.current += 1;
      finalityStopRef.current?.();
      // 前の会計の「もう一度送る」は、新しい QR を出したら使わせない (別の支払いと重ねない)。
      retryRef.current = null;
      const prev = sessionRef.current ?? readStoredSession();
      if (prev) {
        const r = await finalize(prev);
        // 前の会計に署名が入っていた → その送信を優先する (新しい QR は出さない)。
        if (r === 'processing') return null;
      }
      set({ phase: 'creating' });
      let res: Response;
      try {
        res = await fetch('/api/register/handoff', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chainId, merchant, amount: amount.toString() }),
        });
      } catch {
        set({ phase: 'create_failed', reason: 'unavailable' });
        return null;
      }
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; id?: string; token?: string; expiresAt?: number }
        | null;
      if (!res.ok || !body?.ok || !body.id || !body.token || typeof body.expiresAt !== 'number') {
        set({
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
      sessionRef.current = session;
      processingRef.current = null;
      storeSession(session);
      set({ phase: 'waiting', session, stale: false, degraded: false });
      return session;
    },
    [enabled, chainId, finalize, set],
  );

  /** QR を閉じる: 署名を待っていたセッションは締め切る (署名が入っていれば送る)。 */
  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (!s || state.phase !== 'waiting') return;
    set({ phase: 'idle' });
    void finalize(s);
  }, [state.phase, finalize, set]);

  /** 「いま確認する」(結果が分からないとき)。 */
  const checkNow = useCallback(async () => {
    if (state.phase !== 'unknown') return;
    const loaded = await loadIo();
    if (!loaded) return;
    const receipt = await loaded.io.getReceipt(state.mark.hash);
    showReceipt(loaded.mod, state.mark, receipt, state.previous);
  }, [state, loadIo, showReceipt]);

  /** 「もう一度送る」(一時的な理由で送らなかったとき・お客様の署名が有効な間)。 */
  const retry = useCallback(() => {
    const r = retryRef.current;
    if (state.phase !== 'not_sent' || !r) return;
    void process(r.view, r.session);
  }, [state.phase, process]);

  /** 結果の表示を閉じる (「もう一度送る」も使わせない)。署名を待っている・送っている間は何もしない。 */
  const dismiss = useCallback(() => {
    if (state.phase === 'waiting' || state.phase === 'processing' || state.phase === 'creating') return;
    finalityStopRef.current?.();
    retryRef.current = null;
    set({ phase: 'idle' });
  }, [state.phase, set]);

  return { state, start, stop, checkNow, retry, dismiss };
}

/** 端末ごとの切替 (localStorage・既定 OFF)。描画後に読む (server と初回 client の描画を揃える)。 */
export function useStoreDeviceToggle(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(STORE_DEVICE_TOGGLE_KEY) === '1');
    } catch {
      // 読めなければ OFF のまま (今のレジのまま)。
    }
  }, []);
  const update = useCallback((value: boolean) => {
    setOn(value);
    try {
      if (value) window.localStorage.setItem(STORE_DEVICE_TOGGLE_KEY, '1');
      else window.localStorage.removeItem(STORE_DEVICE_TOGGLE_KEY);
    } catch {
      // 保存できなくてもこの表示の間は切り替わる (次に開いたときは OFF)。
    }
  }, []);
  return [on, update];
}
