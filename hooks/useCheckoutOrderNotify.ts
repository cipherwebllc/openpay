'use client';

// /checkout の受注通知の状態と effect (第 10 回レビュー PR-13)。components/CheckoutForm.tsx から、本体を変えずに移した。
// 通知は 4 つの effect で送る (この file の中の並びのまま):
//   A 完了            … この画面で払い終えた支払いを、OpenPay 自身の notify (`/api/order/notify?h=`) へ知らせる。
//                        待てば通る失敗は自動で送り直し (最大 2 回・lib/order/notifyRetry.ts)、届かなければ案内と再試行を出す。
//   B 前の会計        … 前の会計で確定済みのまま届いていない、束縛した注文を裏で届ける。
//   C 束縛した注文    … relay の束縛した注文 (保存した署名と注文の組) を届ける。「もう一度知らせる」もここ。
//   D 通常決済の部分  … お店への送金が確定した時点で、利用料の送金を待たずに届ける。
// effect は component の中で hook を呼んだ位置に並ぶ。CheckoutForm は completion の直後 (移す前に A〜D があった位置) で
// 1 回だけ呼ぶので、ほかの effect との前後は移す前と同じ。引数は component の中と同じ名前で受け、effect の中の式を
// 書き換えていない。引数の setter と ref は render をまたいで同じ identity (useState の setter・useRef の object)。
// セキュリティの前提 (payload は顧客側で改ざんできる・notify が tx_hash を on-chain で確かめる) は CheckoutForm.tsx の冒頭。

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { formatUnits, type Address, type Hex } from 'viem';
import type { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import type { useStandardPayment } from '@/hooks/useStandardPayment';
import type { ChainSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  orderNotifyAutoRetryBaseDelayMs,
  orderNotifyRetryWaitMs,
  orderNotifyServerErrorForLog,
} from '@/lib/order/notifyRetry';
import { parseOwnOrderNotifyUrl } from '@/lib/order/ownNotifyUrl';
import type { CanonicalOrder } from '@/lib/orderBind';
import type { OrderDelivery } from '@/lib/orderDelivery';
import { generateStatusToken } from '@/lib/orderStatusToken';
import { isOrderTokenLike } from '@/lib/orderToken';
import { redactUrlForTelemetry } from '@/lib/telemetryRedaction';
import type { TokenDeployment } from '@/lib/tokens';
import type { CheckoutParams } from '@/lib/url';

// 送金した瞬間の額 (CheckoutForm の submitSnapshotRef の中身)。
type CheckoutSubmitSnapshot = {
  totalWei: bigint;
  merchantReceives: bigint;
  feeAmount: bigint;
  customerPays: bigint;
};

// CheckoutForm の completion (useMemo) の値の形。経路ごとに hash の欄が違う。
type CheckoutOrderNotifyCompletion =
  | {
      key: Hex;
      mode: 'standard';
      blockNumber: bigint;
      hashFields: { merchantTxHash: Hex; feeTxHash: Hex | undefined };
      redirectQuery: { tx_hash: Hex; fee_tx_hash?: Hex };
    }
  | {
      key: Hex;
      mode: 'gasless';
      blockNumber: bigint | null;
      hashFields: { txHash: Hex; userOpHash: Hex };
      redirectQuery: { tx_hash: Hex; user_op_hash: Hex };
    }
  | {
      key: Hex;
      mode: 'gasless';
      blockNumber: bigint | null;
      hashFields: { txHash: Hex };
      redirectQuery: { tx_hash: Hex };
    }
  | null;

// 型は component の値の形をそのまま書く。代入できるかは CheckoutForm の呼び出しの所で TS が確かめる
// (component から型を import しない = 循環させない)。
type UseCheckoutOrderNotifyArgs = {
  params: CheckoutParams;
  completion: CheckoutOrderNotifyCompletion;
  relay: Pick<
    ReturnType<typeof useJpycEip3009Payment>,
    'orderDelivery' | 'backgroundOrderDeliveries' | 'restoredIntent' | 'data'
  >;
  standard: Pick<
    ReturnType<typeof useStandardPayment>,
    | 'lastSubmittedParams'
    | 'data'
    | 'restoredFromStorage'
    | 'merchantTxHash'
    | 'merchantBlockNumber'
    | 'feeTxHash'
  >;
  address: Address | undefined;
  chainSlug: ChainSlug;
  deployment: TokenDeployment;
  isStandard: boolean;
  useRelay: boolean;
  matchingDelivery: OrderDelivery | null;
  restoredCheckoutCompletion: boolean;
  restoredStandardOrderAttempt: { snapshot: CheckoutSubmitSnapshot; from: Address | undefined } | null;
  submitSnapshotRef: RefObject<CheckoutSubmitSnapshot | null>;
  boundOrderRef: RefObject<CanonicalOrder | null>;
  setRedirectIn: Dispatch<SetStateAction<number | null>>;
  setBindingStorageError: Dispatch<SetStateAction<boolean>>;
};

const SUCCESS_REDIRECT_DELAY_MS = 3000;
export const ORDER_MEMO_STORAGE_PREFIX = 'openpay:order-memo:';
const ORDER_STATUS_TOKEN_STORAGE_PREFIX = 'openpay:order-status-token:';
const ORDER_NOTIFY_PROCESSING_RETRY_MS = [
  250, 1_000, 4_000, 15_000, 60_000, 60_000,
] as const;

function orderStatusTokenForMerchantTx(merchantTxHash: string): string {
  const key = `${ORDER_STATUS_TOKEN_STORAGE_PREFIX}${merchantTxHash.toLowerCase()}`;
  try {
    const stored = window.sessionStorage.getItem(key);
    if (isOrderTokenLike(stored)) return stored;
    const generated = generateStatusToken();
    window.sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    // status token の sessionStorage 障害を受注通知へ波及させない。同一 mount は呼出側の ref で固定する。
    return generateStatusToken();
  }
}

// onSend = fetch を呼ぶたび (最初の 1 回と 409 の送り直しの毎回) に、呼ぶ直前に知らせる。完了の通知 (effect A) の自動の
// 送り直しが server の枠 (60 秒に 5 回) を数えるために使う。渡さなければ (経路 B・C) 何も変わらない。
async function postOrderNotify(
  url: string,
  init: RequestInit,
  retryOrderProcessing: boolean,
  onSend?: () => void,
): Promise<Response> {
  onSend?.();
  let response = await fetch(url, init);
  if (!retryOrderProcessing) return response;
  for (const delayMs of ORDER_NOTIFY_PROCESSING_RETRY_MS) {
    if (response.status !== 409) return response;
    // A non-JSON 409 must not trigger blind retries of reserved/rejected orders.
    const error = (await response.clone().json().catch(() => null))?.error;
    if (error !== 'processing') return response;
    // 直前 mount の order claim が処理中でも、fee 成功通知まで 409 で失われ受注/未収状態が
    // 固着する波及を断つ。既存 route の 409 契約は変えず、同じ byte の notify だけを再試行する。
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    onSend?.();
    response = await fetch(url, init);
  }
  return response;
}

// 応答の本文 (1 回しか読めない) を JSON として読む。JSON でない本文 (中継の HTML・空) は null = 届いた形でない応答。
async function readOrderNotifyBody(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// 支払い (key) ごとに、この画面が /api/order/notify へ送った時刻の列 (無ければ作る)。
function orderNotifySendTimes(log: Map<string, number[]>, key: string): number[] {
  let times = log.get(key);
  if (!times) {
    times = [];
    log.set(key, times);
  }
  return times;
}

// 完了の通知 (effect A) の 1 回の送信が届かなかったときの中身。
type DirectNotifyFailure = {
  // fetch が投げたときは null (error に投げられた値)。
  status: number | null;
  statusText?: string;
  error?: unknown;
  serverError?: string;
  // 422 tx_too_old (支払いが受付の期限より前)。何度送っても通らない。
  tooOld: boolean;
  // 待てば通る種類 (5xx・429・409 processing・422 tx_not_found・通信の失敗・2xx で届いた形でない応答)。
  waitable: boolean;
};

// origin と pathname だけを見る (`h` は見ない)。使う所ごとの方針の差は lib/order/ownNotifyUrl.ts の冒頭の表。
export function isOwnOrderNotifyUrl(webhook: string, origin: string): boolean {
  // An invalid callback must not make unrelated checkout pages display order-recovery warnings
  // (読めない URL は 'unreadable' = 自社でない)。
  return parseOwnOrderNotifyUrl(webhook, origin).kind === 'own';
}

function isRetryableOrderNotify(status: number, body: { error?: string; bindingConflict?: boolean } | null): boolean {
  if (body?.bindingConflict === true) return false;
  return status >= 500 || status === 429 ||
    (status === 409 && body?.error === 'processing') || (status === 422 && body?.error === 'tx_not_found');
}

export function useCheckoutOrderNotify(args: UseCheckoutOrderNotifyArgs) {
  const {
    params,
    completion,
    relay,
    standard,
    address,
    chainSlug,
    deployment,
    isStandard,
    useRelay,
    matchingDelivery,
    restoredCheckoutCompletion,
    restoredStandardOrderAttempt,
    submitSnapshotRef,
    boundOrderRef,
    setRedirectIn,
    setBindingStorageError,
  } = args;
  // 顧客向け「注文状況」トークン (お渡し準備完了通知・flag ENABLE_ORDER_PICKUP)。決済成功時に
  // 1 度だけ生成し、webhook payload (notify がポインタ保存) と完了画面の「注文状況を見る」リンクで
  // 使う。flag OFF では生成せず null = payload 無変化・リンク非表示 (byte-identical)。
  const [statusToken, setStatusToken] = useState<string | null>(null);
  const [orderNotifyFailed, setOrderNotifyFailed] = useState(false);
  // 完了の通知 (effect A) が届かずに止まったときの案内と、「注文登録を再試行」を出すか。ほかの経路 (C・D の tx_too_old) が
  // 立てる orderNotifyFailed とは別に持つ: A の再試行が届いたときに、A が立てた案内だけを消す (ほかが立てた案内を消さない)。
  const [directNotifyFailed, setDirectNotifyFailed] = useState(false);
  const [directNotifyRetryable, setDirectNotifyRetryable] = useState(false);
  // 「注文登録を再試行」が押されたときに 1 回だけ送る処理 (effect A が、送った本文をそのまま持つ closure を置く)。
  const directNotifyRetryRef = useRef<(() => void) | null>(null);
  // この画面が、支払い (key) ごとに /api/order/notify へ送った時刻 (部分・完了・409 の送り直し・自動の送り直し・ボタン)。
  const orderNotifySentAtRef = useRef(new Map<string, number[]>());
  // 部分の通知 (effect D) が届いた支払い (key = merchantTxHash)。届いていれば、完了の通知が届かなくても注文はお店にある。
  const partialDeliveredKeyRef = useRef<string | null>(null);
  const [boundNotifyRetry, setBoundNotifyRetry] = useState(0);
  const [boundNotifyRetryable, setBoundNotifyRetryable] = useState(false);
  const [boundNotifyAcknowledged, setBoundNotifyAcknowledged] = useState(false);
  const boundNotifiedRef = useRef<string | null>(null);
  const previousNotificationsRef = useRef(new Map<string, 'pending' | 'staff' | 'done'>());
  // 画面がある間だけ true。前の会計の通知 (effect B) と、完了の通知 (effect A) の結果の反映が見る
  // (effect の cleanup の flag ではなく ref: StrictMode の mount → unmount → mount の後も true に戻る)。
  const previousNotificationMountedRef = useRef(true);
  useEffect(() => {
    previousNotificationMountedRef.current = true;
    return () => { previousNotificationMountedRef.current = false; };
  }, []);
  const [previousOrderNotice, setPreviousOrderNotice] = useState<'pending' | 'staff' | null>(null);
  const statusTokenRef = useRef<string | null>(null);
  // R: gasQuote refetch (30s) で breakdown が再計算 → notification effect が再実行
  //    される。同一 tx hash の重複 webhook を防ぐため key 単位の dedup gate を使う。
  const notifiedKeyRef = useRef<string | null>(null);
  const partialOrderNotifiedKeyRef = useRef<string | null>(null);
  // customerMemo = 部分の通知が sessionStorage から読んだお客様のメモ。部分の通知は読んだ直後に sessionStorage から
  // 消すので、同じ支払い (key = merchantTxHash) の後の通知 (2 回目の部分の通知・完了の通知) はここから載せる。
  const partialOrderNotifyPromiseRef = useRef<{
    key: string;
    promise: Promise<void>;
    customerMemo: string | undefined;
  } | null>(null);

  useEffect(() => {
    if (!completion) return;
    const snapshot = submitSnapshotRef.current;
    // 許可済みの on-chain intent metadata だけでは元の items/order/callback を再構成できない。
    // reload 復元を現在 URL の受注通知・redirect へ誤帰属させる波及を断ち、same-mount だけを通知する。
    if (!snapshot || restoredCheckoutCompletion) return;
    if (notifiedKeyRef.current === completion.key) return;
    notifiedKeyRef.current = completion.key;

    logger.info('checkout.success', {
      mode: completion.mode,
      ...completion.hashFields,
      merchant: params.to,
      orderId: boundOrderRef.current?.orderId ?? params.orderId,
      token: params.token,
      chain: chainSlug,
    });

    if (useRelay && boundOrderRef.current) return;

    // 受注 notify を送るのは OpenPay 自身の notify (= モバイル注文・MobileOrderView が同一 origin の
    // `/api/order/notify?h=` を指す) のときだけ。第三者 webhook は退役 (R1): 外部 URL は送らず、
    // URL に残っていても黙って無視する (支払いは成立済み・旧リンクを壊さない)。URL を parse し
    // **same-origin かつ pathname 完全一致**で判定する: substring 一致だと第三者 URL
    // (`https://shop/hook?next=/api/order/notify` 等) へ payload / statusToken を送りうる (Codex)。
    // 不正 URL は送らない。待てば通る失敗は自動で送り直し、届かずに止まったら (部分の通知も届いていなければ)
    // スタッフへの確認を案内する。
    if (params.webhook && isOwnOrderNotifyUrl(params.webhook, window.location.origin)) {
      const orderNotifyUrl = params.webhook;
      // hash は fetch と並行に開始し、失敗 telemetry が必要な場合だけ await する。
      const webhookTelemetry = redactUrlForTelemetry(orderNotifyUrl);
      // お渡し準備完了通知 (flag ENABLE_ORDER_PICKUP): status トークンを 1 度だけ生成し payload に同梱。
      // notify が order:sv:<token> ポインタを保存し、顧客の /order/status?t= がそれを逆引きする。
      const statusTokenForOrder =
        env.enableOrderPickup
          ? (statusTokenRef.current ??
            (completion.mode === 'standard'
              ? orderStatusTokenForMerchantTx(completion.key)
              : generateStatusToken()))
          : null;
      if (statusTokenForOrder) {
        statusTokenRef.current = statusTokenForOrder;
        setStatusToken(statusTokenForOrder);
      }
      let customerMemo: string | undefined;
      if (params.orderId) {
        try {
          customerMemo =
            window.sessionStorage.getItem(
              `${ORDER_MEMO_STORAGE_PREFIX}${params.orderId}`,
            ) || undefined;
        } catch {
          // sessionStorage 障害を受注通知/決済完了処理へ波及させない (メモは advisory)。
        }
      }
      // 同じ支払い (key = merchantTxHash) の部分の通知。通常決済では、部分の通知が先にメモを読んで sessionStorage から
      // 消している。その通知がサーバーに保存されず (通信の失敗・503・422)、この完了の通知が最初の保存になったときに
      // メモだけ欠ける波及を断つため、部分の通知が読んだメモを載せる。sessionStorage に値があれば今までどおりそれを使う。
      const partialNotify =
        completion.mode === 'standard' &&
        partialOrderNotifyPromiseRef.current?.key === completion.key
          ? partialOrderNotifyPromiseRef.current
          : null;
      const notifyMemo = customerMemo ?? partialNotify?.customerMemo;
      const payload = {
        type: 'openpay.checkout.success',
        mode: completion.mode,
        merchant: params.to,
        from: address,
        token: params.token,
        chain: chainSlug,
        chainId: deployment.chainId,
        // amount = 税込注文小計 (totalWei・gas を含まない)。顧客の総支払いは customerPays、
        // 店主着金は merchantAmount。金額はすべて submit 時点の snapshot で固定する
        // (成功描画時の live 値ではない)。
        amount: formatUnits(snapshot.totalWei, deployment.decimals),
        items: params.items,
        // レジの値引き (在るときだけ・追加のみ)。items の合計 − discount = amount で突き合わせられるように。
        ...(params.discount ? { discount: params.discount } : {}),
        merchantAmount: snapshot.merchantReceives.toString(),
        feeAmount: snapshot.feeAmount.toString(),
        customerPays: snapshot.customerPays.toString(),
        orderId: params.orderId,
        description: params.description,
        // status トークン (flag ON 時のみ)。notify がポインタ保存に使う。flag OFF では key ごと不在。
        ...(statusTokenForOrder ? { statusToken: statusTokenForOrder } : {}),
        // 受取予定時刻 (任意・Phase 4・preorder)。受注に素通し保存され厨房/ホールが表示 (advisory)。
        ...(params.pickupAt !== undefined ? { pickupAt: params.pickupAt } : {}),
        // 同一 origin の受注 notify に限り、URL に載せず sessionStorage から任意メモを渡す。
        ...(notifyMemo ? { customerMemo: notifyMemo } : {}),
        // URL 仕様 (lib/url.ts) で customerEmail は prefill 専用・クライアントから送信しない、
        // と明記しているため payload に含めない (orderId で突合可能)。
        ...completion.hashFields,
        // relay は block 不明 (txHash のみ)。null のときは payload から省略する
        // (下流 consumer が missing と null を区別するため・"null" 文字列にしない)。
        ...(completion.blockNumber !== null
          ? { blockNumber: completion.blockNumber.toString() }
          : {}),
        ts: Date.now(),
      };
      const paymentKey = completion.key;
      // 送り直し (409 の表・自動・ボタン) は、1 字も変えない同じ本文を送る (server は支払いごとに最初の 1 回だけ保存する)。
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        mode: 'cors',
        keepalive: true,
      };
      const sentAt = orderNotifySendTimes(orderNotifySentAtRef.current, paymentKey);
      // 完了の通知が送った回数 (409 の送り直しも数える)。記録 (warn) の attempts。
      let attempts = 0;
      // 1 回送り (409 processing の表は今までどおり postOrderNotify の中)、届いたら null・届かなければ中身を返す。
      const sendOnce = async (): Promise<DirectNotifyFailure | null> => {
        let res: Response;
        try {
          res = await postOrderNotify(orderNotifyUrl, init, true, () => {
            attempts += 1;
            sentAt.push(Date.now());
          });
        } catch (error) {
          return { status: null, error, tooOld: false, waitable: true };
        }
        // 本文は 1 回しか読めないので、ここで 1 度だけ読み、届いたか・期限切れか・待てば通るか・error の語を全部ここから取る。
        const body = await readOrderNotifyBody(res);
        // 届いた = 2xx かつ本文が { ok: true } (経路 C と同じ見方)。server は 200 のとき必ず { ok: true, … } を返す。
        if (res.ok && body?.ok === true) return null;
        return {
          status: res.status,
          statusText: res.statusText,
          serverError: orderNotifyServerErrorForLog(body?.error),
          tooOld: res.status === 422 && body?.error === 'tx_too_old',
          // 2xx なのに { ok: true } でない応答 (中継や captive portal の HTML) は、通信の失敗と同じく待てば通る扱い。
          waitable: res.ok || isRetryableOrderNotify(res.status, body),
        };
      };
      // 届くか、送り直しを使い切るか、何度送っても通らない失敗が返るまで送る。届いたら null・届かなければ最後の失敗。
      // autoRetry = false (ボタン) は 1 回だけ。timer と fetch は、409 の送り直しと同じく画面を離れても止めない。
      const deliver = async (autoRetry: boolean): Promise<DirectNotifyFailure | null> => {
        for (let retry = 0; ; retry += 1) {
          const failure = await sendOnce();
          if (!failure) {
            if (retry > 0) logger.info('checkout.webhook.retry_delivered', { attempts });
            return null;
          }
          // 409 processing は postOrderNotify の表が送り直した後なので、ここでは重ねて送り直さない。
          const baseDelayMs =
            autoRetry && failure.waitable && failure.status !== 409
              ? orderNotifyAutoRetryBaseDelayMs(retry, failure.status)
              : null;
          if (baseDelayMs === null) return failure;
          // server の枠 (同じ支払いと IP で 60 秒に 5 回・断った要求も数える) を自動の送り直しで使い切り、
          // 通るはずの送信まで 429 にする波及を断つ: この支払いで送った時刻を見て、枠が空くまで待つ。
          const waitMs = orderNotifyRetryWaitMs(sentAt, Date.now(), baseDelayMs);
          logger.info('checkout.webhook.retry_scheduled', { status: failure.status, attempts, waitMs });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      };
      // 送り終えた後の、画面と記録。manual = 「注文登録を再試行」で送った 1 回。
      const finish = async (failure: DirectNotifyFailure | null, manual: boolean) => {
        // 画面を離れた (unmount) 後に出た結果で、もう無い画面の状態を書き換えない。記録 (warn) は出す。
        const mounted = previousNotificationMountedRef.current;
        if (!failure) {
          // 自動の送り直しで届いたときは、案内をまだ出していないので何も変えない。ボタンで届いたときは、完了の通知が
          // 立てた案内だけを消し、案内が止めていた success_url への移動を始め直す (経路 C が登録できたときと同じ)。
          if (manual && mounted) {
            setDirectNotifyFailed(false);
            if (params.successUrl) setRedirectIn(SUCCESS_REDIRECT_DELAY_MS / 1000);
          }
          return;
        }
        if (mounted) {
          if (failure.tooOld) {
            // 受注拒否を決済失敗や再支払いへ波及させず、支払い済みのまま手動確認へ案内する。
            setOrderNotifyFailed(true);
            setRedirectIn(null);
          } else if (partialDeliveredKeyRef.current !== paymentKey) {
            // 注文がお店に届いていないのに、完了の画面と「注文状況を見る」だけが出て、お客様が届いたと思い込む波及を断つ。
            // 部分の通知が届いた支払いでは出さない (注文はお店にある。遅れるのは利用料の清算だけ)。
            setDirectNotifyFailed(true);
            setRedirectIn(null);
            setDirectNotifyRetryable(failure.waitable);
          }
        }
        // 記録は、止まったとき (自動の送り直しを終えた後・ボタンの 1 回ごと) に 1 件。部分の通知が届いていても出す。
        const redacted = await webhookTelemetry;
        if (failure.status === null) {
          logger.warn('checkout.webhook.failed', {
            error: failure.error,
            webhookOrigin: redacted.origin,
            webhookHash: redacted.hash,
            attempts,
          });
        } else {
          logger.warn('checkout.webhook.non_ok', {
            status: failure.status,
            statusText: failure.statusText,
            webhookOrigin: redacted.origin,
            webhookHash: redacted.hash,
            attempts,
            ...(failure.serverError ? { serverError: failure.serverError } : {}),
          });
        }
      };
      const sendOrderNotify = () => deliver(true).then((failure) => finish(failure, false));
      directNotifyRetryRef.current = () => {
        // 押した時点でボタンを消す (click の中の更新は、次の click が届く前に描き直される = 送っている間は押せない)。
        // 結果が出たら、待てば通る失敗のときだけ出し直す。
        setDirectNotifyRetryable(false);
        void deliver(false).then((failure) => finish(failure, true));
      };
      const partial = partialNotify?.promise;
      // merchant 確定通知の KV claim が処理中のまま通常成功通知と競合し、後者が 409 で失われる
      // 波及を断つ。部分通知の成否にかかわらず完了後に従来 payload を同じ byte で送る。
      if (partial) {
        void partial.then(sendOrderNotify, sendOrderNotify);
      } else {
        void sendOrderNotify();
      }
      if (customerMemo && params.orderId) {
        try {
          window.sessionStorage.removeItem(
            `${ORDER_MEMO_STORAGE_PREFIX}${params.orderId}`,
          );
        } catch {
          // 送信済みメモの後片付け失敗を決済完了処理へ波及させない。
        }
      }
    }

    if (params.successUrl) {
      setRedirectIn(SUCCESS_REDIRECT_DELAY_MS / 1000);
    }
    // 金額は submitSnapshotRef (ref・非 reactive) から読む。snapshot は submit と同期で固定され、
    // completion (mutation 解決) が変わるのはその後なので、ref で十分かつ live 値の混入を防げる。
  }, [
    completion,
    params.to,
    params.token,
    chainSlug,
    params.items,
    params.discount,
    params.orderId,
    params.description,
    params.pickupAt,
    params.webhook,
    params.successUrl,
    address,
    deployment.chainId,
    deployment.decimals,
    restoredCheckoutCompletion,
    useRelay,
    relay.orderDelivery,
    boundOrderRef,
    setRedirectIn,
    submitSnapshotRef,
  ]);

  // Bare public relay metadata cannot establish an order context. Only a matching delivery
  // below may show order-registration assistance; an ordinary /pay recovery is not an order.
  useEffect(() => {
    const notices = previousNotificationsRef.current;
    const updateNotice = () => {
      // A second recovered order may change the list while the first POST is outstanding.
      // Keep its notice current for this mount without updating an unmounted checkout.
      if (!previousNotificationMountedRef.current) return;
      const values = [...notices.values()];
      setPreviousOrderNotice(values.includes('staff') ? 'staff' : values.includes('pending') ? 'pending' : null);
    };
    for (const record of relay.backgroundOrderDeliveries ?? []) {
      // Only validated, already confirmed records may notify in the background. Signed/unknown
      // records are resolved read-only by the hook; none of these records becomes page completion.
      if (record.state !== 'notify-pending' || !record.notifyBody) continue;
      const key = `${record.intent.nonce}:${record.txHash}`;
      if (notices.has(key)) continue;
      notices.set(key, 'pending');
      const url = new URL('/api/order/notify', window.location.origin);
      url.searchParams.set('h', record.order.handle);
      void postOrderNotify(url.toString(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: record.notifyBody, keepalive: true,
      }, true).then(async (res) => {
        // Missing acknowledgement cannot be treated as registration of a previous order.
        const body = await res.json().catch(() => null);
        const storage = await import('@/lib/orderDelivery');
        if (res.ok && body?.ok === true && body?.bindingConflict !== true) {
          notices.set(key, storage.acknowledgeOrderDelivery(record) ? 'done' : 'pending');
        } else if (!isRetryableOrderNotify(res.status, body)) {
          storage.terminateOrderDelivery(record);
          notices.set(key, 'staff');
        }
        updateNotice();
      }).catch(() => {
        // Background network/storage chunk failures retain the opening without blocking this payment.
        updateNotice();
      });
    }
    updateNotice();
  }, [relay.backgroundOrderDeliveries]);

  // Restored notification is allowed only for the validated saved authorization/order pair.
  // The current URL contributes neither order fields nor destination; secrets stay on our origin.
  useEffect(() => {
    const record = relay.restoredIntent ? matchingDelivery : relay.orderDelivery;
    if (!record || record.state !== 'notify-pending' || !record.notifyBody ||
      !relay.data?.success || relay.data.txHash !== record.txHash) return;
    const key = `${record.intent.nonce}:${record.txHash}:${boundNotifyRetry}`;
    if (boundNotifiedRef.current === key) return;
    boundNotifiedRef.current = key;
    setBoundNotifyRetryable(false);
    const url = new URL('/api/order/notify', window.location.origin);
    url.searchParams.set('h', record.order.handle);
    void postOrderNotify(url.toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: record.notifyBody, keepalive: true,
    }, true).then(async (res) => {
      // A non-JSON response is not an acknowledgement; its HTTP status still determines retryability.
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok === true && body?.bindingConflict !== true) {
        const { acknowledgeOrderDelivery } = await import('@/lib/orderDelivery');
        if (!acknowledgeOrderDelivery(record)) setBindingStorageError(true);
        setBoundNotifyAcknowledged(true);
        setOrderNotifyFailed(false);
        statusTokenRef.current = record.order.statusToken || null;
        setStatusToken(record.order.statusToken || null);
        try {
          window.sessionStorage.removeItem(`${ORDER_MEMO_STORAGE_PREFIX}${record.order.orderId}`);
        } catch {
          // Memo cleanup failure must not roll back an acknowledged order/payment.
        }
        if (!relay.restoredIntent && params.successUrl) setRedirectIn(SUCCESS_REDIRECT_DELAY_MS / 1000);
        return;
      }
      const terminal = !isRetryableOrderNotify(res.status, body);
      if (terminal) {
        const { terminateOrderDelivery } = await import('@/lib/orderDelivery');
        if (!terminateOrderDelivery(record)) setBindingStorageError(true);
      }
      // A terminal delivery shows assistance on this mount only; it must not hijack later payments.
      // A notification rejection is never a failed payment or permission to sign again.
      setOrderNotifyFailed(true);
      setRedirectIn(null);
      setBoundNotifyRetryable(!terminal);
      logger.warn('checkout.webhook.non_ok', { status: res.status, statusText: res.statusText });
    }).catch(() => {
      // Lost notification response retains the same opening for safe replay, independently of payment.
      setOrderNotifyFailed(true);
      setRedirectIn(null);
      setBoundNotifyRetryable(true);
      logger.warn('checkout.webhook.failed', { reason: 'order_notify_network' });
    });
  }, [relay.orderDelivery, relay.data, relay.restoredIntent, matchingDelivery, boundNotifyRetry, params.successUrl,
    setBindingStorageError, setRedirectIn]);

  // standard の merchant leg が確定した時点で、独立 fee leg の wallet 操作を待たず受注を届ける。
  // OpenPay 自身の same-origin `/api/order/notify` だけを additive に発火し (第三者 webhook は退役)、
  // 後続 fee 成功は従来の通常成功 payload で未収状態を解消する。
  useEffect(() => {
    const submitted = standard.lastSubmittedParams;
    const submittedFeeAmount =
      submitted?.feeAmount ?? submitSnapshotRef.current?.feeAmount;
    if (
      !isStandard ||
      submittedFeeAmount === undefined ||
      submittedFeeAmount <= 0n ||
      (!!standard.data && !standard.restoredFromStorage) ||
      !standard.merchantTxHash ||
      standard.merchantBlockNumber === undefined ||
      !params.webhook
    ) {
      return;
    }
    const mountedSnapshot = submitSnapshotRef.current;
    const attempt = mountedSnapshot
      ? { snapshot: mountedSnapshot, from: address }
      : restoredStandardOrderAttempt;
    // fingerprint が一致しない復元 hash を現在 URL の items/orderId へ通知する波及を断つ。
    if (!attempt) return;
    const { snapshot } = attempt;

    // この画面で払ったとき (mountedSnapshot あり) は自社の URL であることだけ。読み直した画面では、加えて `h` がちょうど 1 つで、
    // お店の @handle (store_handle) と大文字小文字を除いて同じこと (`@` は外さない)。読めない URL は自社でない = 送らない。
    // ほかの所との方針の差は lib/order/ownNotifyUrl.ts の冒頭の表。
    const webhook = parseOwnOrderNotifyUrl(params.webhook, window.location.origin);
    const isOrderNotifyWebhook =
      webhook.kind === 'own' &&
      (mountedSnapshot !== null ||
        (!!params.storeHandle &&
          webhook.handles.length === 1 &&
          webhook.handles[0].toLowerCase() ===
            params.storeHandle.toLowerCase()));
    if (!isOrderNotifyWebhook) return;
    const partialNotifyKey =
      `${standard.merchantTxHash}:${standard.feeTxHash ?? 'awaiting'}`;
    if (partialOrderNotifiedKeyRef.current === partialNotifyKey) return;
    // fee hash の broadcast 後にも同じ受注を additive に通知し、直後の close/reload で
    // server reconciliation が hash を知らないまま未収へ固着する波及を断つ。
    partialOrderNotifiedKeyRef.current = partialNotifyKey;

    const statusTokenForOrder = env.enableOrderPickup
      ? (statusTokenRef.current ??
        orderStatusTokenForMerchantTx(standard.merchantTxHash))
      : null;
    if (statusTokenForOrder) {
      statusTokenRef.current = statusTokenForOrder;
      setStatusToken(statusTokenForOrder);
    }

    let customerMemo: string | undefined;
    if (params.orderId) {
      try {
        customerMemo =
          window.sessionStorage.getItem(
            `${ORDER_MEMO_STORAGE_PREFIX}${params.orderId}`,
          ) || undefined;
      } catch {
        // sessionStorage 障害を受注通知へ波及させない (メモは advisory)。
      }
    }
    // 1 回目の部分の通知はメモを読んだ直後に sessionStorage から消す。1 回目がサーバーに保存されず、2 回目
    // (feeTxHash つき) が最初の保存になったときにメモだけ欠ける波及を断つため、同じ支払い (merchantTxHash) の
    // 1 回目が読んだメモを 2 回目にも載せる。別の支払いのメモは使わない。
    const earlierNotify = partialOrderNotifyPromiseRef.current;
    const notifyMemo =
      customerMemo ??
      (earlierNotify?.key === standard.merchantTxHash
        ? earlierNotify.customerMemo
        : undefined);

    logger.info('checkout.order.delivered_fee_uncollected', {
      merchantTxHash: standard.merchantTxHash,
      feeTxHash: standard.feeTxHash,
      merchant: params.to,
      orderId: params.orderId,
      token: params.token,
      chain: chainSlug,
    });

    const webhookTelemetry = redactUrlForTelemetry(params.webhook);
    const payload = {
      type: 'openpay.checkout.success',
      mode: 'standard',
      merchant: params.to,
      from: attempt.from,
      token: params.token,
      chain: chainSlug,
      chainId: deployment.chainId,
      amount: formatUnits(snapshot.totalWei, deployment.decimals),
      items: params.items,
      ...(params.discount ? { discount: params.discount } : {}),
      merchantAmount: snapshot.merchantReceives.toString(),
      feeAmount: snapshot.feeAmount.toString(),
      customerPays: snapshot.customerPays.toString(),
      orderId: params.orderId,
      description: params.description,
      ...(statusTokenForOrder ? { statusToken: statusTokenForOrder } : {}),
      ...(params.pickupAt !== undefined ? { pickupAt: params.pickupAt } : {}),
      ...(notifyMemo ? { customerMemo: notifyMemo } : {}),
      merchantTxHash: standard.merchantTxHash,
      ...(standard.feeTxHash ? { feeTxHash: standard.feeTxHash } : {}),
      blockNumber: standard.merchantBlockNumber.toString(),
      feeUncollected: true,
      ts: Date.now(),
    };
    const merchantTxHash = standard.merchantTxHash;
    const sentAt = orderNotifySendTimes(orderNotifySentAtRef.current, merchantTxHash);
    const request = postOrderNotify(
      params.webhook,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        mode: 'cors',
        keepalive: true,
      },
      true,
      // 送り方は変えない。同じ支払いの完了の通知 (effect A) の自動の送り直しが、server の枠を数えるための時刻だけ記す。
      () => {
        sentAt.push(Date.now());
      },
    )
      .then(async (res) => {
        // 届いた (2xx かつ本文が { ok: true }) 支払いを記す。完了の通知が届かなかったときに、注文がもうお店にあるかを
        // 見分けるためだけに使う (この通知の記録・案内は変えない)。
        if (res.ok && (await readOrderNotifyBody(res))?.ok === true) {
          partialDeliveredKeyRef.current = merchantTxHash;
        }
        if (!res.ok) {
          // 中継層の非 JSON 応答が既存の HTTP status 記録を飛ばす波及を断つ。
          if (
            res.status === 422 &&
            (await res.json().catch(() => null))?.error === 'tx_too_old'
          ) {
            // merchant leg は確定済み。受注拒否を店舗への二重送金へ波及させない。
            setOrderNotifyFailed(true);
            setRedirectIn(null);
          }
          const redacted = await webhookTelemetry;
          logger.warn('checkout.webhook.non_ok', {
            status: res.status,
            statusText: res.statusText,
            webhookOrigin: redacted.origin,
            webhookHash: redacted.hash,
          });
        }
      })
      .catch(async (err) => {
        const redacted = await webhookTelemetry;
        logger.warn('checkout.webhook.failed', {
          error: err,
          webhookOrigin: redacted.origin,
          webhookHash: redacted.hash,
        });
      });
    partialOrderNotifyPromiseRef.current = {
      key: standard.merchantTxHash,
      promise: request,
      // 2 回目の部分の通知が作り直すときも、覚えたメモを落とさない (中身は log に出さない)。
      customerMemo: notifyMemo,
    };

    if (customerMemo && params.orderId) {
      try {
        window.sessionStorage.removeItem(
          `${ORDER_MEMO_STORAGE_PREFIX}${params.orderId}`,
        );
      } catch {
        // 送信済みメモの後片付け失敗を受注通知へ波及させない。
      }
    }
  }, [
    address,
    chainSlug,
    deployment.chainId,
    deployment.decimals,
    isStandard,
    params.description,
    params.discount,
    params.items,
    params.orderId,
    params.pickupAt,
    params.storeHandle,
    params.to,
    params.token,
    params.webhook,
    restoredStandardOrderAttempt,
    standard.feeTxHash,
    standard.data,
    standard.lastSubmittedParams,
    standard.merchantBlockNumber,
    standard.merchantTxHash,
    standard.restoredFromStorage,
    setRedirectIn,
    submitSnapshotRef,
  ]);

  return {
    statusToken,
    // 案内は 1 つ (文も止めるものも同じ): 完了の通知が立てたものと、ほかの経路が立てたものの、どちらかがあれば出す。
    orderNotifyFailed: orderNotifyFailed || directNotifyFailed,
    directNotifyRetryable,
    retryDirectNotify: () => directNotifyRetryRef.current?.(),
    boundNotifyRetryable,
    boundNotifyAcknowledged,
    previousOrderNotice,
    setBoundNotifyAcknowledged,
    setBoundNotifyRetry,
  };
}
