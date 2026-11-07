'use client';

// OpenPay 利用料のガスレス支払い専用 hook。店主が transferWithAuthorization(店主→FEE_RECEIVER, fee) に
// 1 署名 → /api/relay/jpyc が中継 (free モード)。顧客決済用 useJpycEip3009Payment と異なり forwarder
// (recover) 分岐を持たず、常に FEE_RECEIVER への直接 transfer を組む (利用料の宛先は固定・分割不要で、
// forwarder 設定の有無に左右されない)。relay 関所は isFeePayment=true (to=FEE_RECEIVER) を常に通す。
//
// 応答判定と latch の語彙は useJpycEip3009Payment.postRelayPayload と **同一** にする
// (分岐が食い違うと片方だけ二重課金経路が残るため)。

import { useCallback, useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAccount, useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import {
  AUTHORIZATION_VALIDITY_WINDOW_SEC,
  buildTransferWithAuthorizationTypedData,
  randomAuthorizationNonce,
} from '@/lib/jpycEip3009';
import { env } from '@/lib/env';
import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
  RelayIpRateLimitedError,
  RelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import {
  clearUsageFeeIntent,
  loadUsageFeeIntent,
  saveUsageFeeIntent,
  type UsageFeeIntentMetadata,
} from '@/lib/paymentIntentStorage';
import type { TokenDeployment } from '@/lib/tokens';

// success: relay 成立で確定。pending: broadcast 済だが未確定 (再送禁止 = 二重支払い防止)。
// success=false かつ pending=false は「relay は成立したが tx が on-chain で revert」
// (useJpycEip3009Payment と同じ B2 方針。送金は成立していないので再署名して構わない)。
export type UsageFeePayResult = {
  txHash: Hex | null;
  success: boolean;
  pending: boolean;
};

// mutation の変数 (押された利用料の額)。
type UsageFeePayVariables = { value: bigint };

type RelayBody = {
  ok?: boolean;
  txHash?: Hex | null;
  reverted?: boolean;
  pending?: boolean;
  error?: string;
  retryAfter?: number;
};

// relay へ送る署名済 payload (保存/再 POST で byte 同一にするため型を固定する)。
type UsageFeeRelayPayload = {
  chainId: number;
  from: Address;
  to: Address;
  value: string;
  validAfter: '0';
  validBefore: string;
  nonce: Hex;
  signature: Hex;
};

// 応答不明 / IP 制限で保持した署名済 payload。確定応答が来るまで同一 payload だけを
// 再 POST し、新しい nonce での再署名を構造的に封じる。
type RetainedUsageFeePayload = {
  payload: UsageFeeRelayPayload;
  // この payload が請求している利用料 (別 amount の要求と取り違えないための照合キー)。
  value: bigint;
  // chain / account を跨いだ再 POST を防ぐ照合キー (payload と同値だが比較用に持つ)。
  chainId: number;
  from: Address;
  // false→true のみ許す単調 latch。on-chain 終端 (success / revert) が証明されたときだけ外す。
  ambiguous: boolean;
};

// tx hash は 0x + 64 桁の hex だけ (useJpycEip3009Payment と同じ)。形の崩れた txHash の応答は
// 成功・revert にせず、末尾の RelayResponseUnknownError (曖昧 latch・同一 payload の再 POST) に落とす。
function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function retryAfterSeconds(res: Response, body: RelayBody): number | null {
  const raw = body.retryAfter ?? res.headers.get('retry-after');
  if (raw === null || raw === undefined || raw === '') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// relay POST + 応答判定。useJpycEip3009Payment.postRelayPayload と同じ語彙・同じ分岐順:
// 「未送信を証明できない」応答は全て RelayResponseUnknownError に倒す。
async function postUsageFeeRelay(
  payload: UsageFeeRelayPayload,
): Promise<UsageFeePayResult> {
  let res: Response;
  try {
    res = await fetch('/api/relay/jpyc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // POST が server に届いた後で応答だけ失われた可能性がある。通常 Error に倒すと
    // 呼出側の再試行が新しい nonce で署名し直し、server の冪等キー
    // (chainId+from+nonce) が変わって二重課金になるため、専用の曖昧状態にする。
    throw new RelayResponseUnknownError();
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    // body 読取失敗は 2xx でも broadcast 前を証明できない。成功にも再送可能な
    // server error にもせず曖昧状態にする。
    throw new RelayResponseUnknownError();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayResponseUnknownError();
  }
  const b = parsed as RelayBody;

  if (res.ok && b.ok === true && isTxHash(b.txHash)) {
    return { txHash: b.txHash, success: true, pending: false };
  }
  // relay は成立したが tx が revert (残高変動等)。200 {ok:false,reverted:true} で返るため
  // ここで拾わないと「非構造化 2xx」= 応答不明に落ち、送金が起きていないのに latch が残る。
  if (b.reverted === true && isTxHash(b.txHash)) {
    return { txHash: b.txHash, success: false, pending: false };
  }
  // 202: broadcast 済・未確定。再送/settle せず pending を返す (二重支払い防止)。
  // txHash は無し・null・0x + 64 桁の hex のどれか (useJpycEip3009Payment と同じ条件)。それ以外は末尾の応答不明へ。
  if (
    res.status === 202 &&
    b.pending === true &&
    (b.txHash === undefined || b.txHash === null || isTxHash(b.txHash))
  ) {
    return { txHash: b.txHash ?? null, success: false, pending: true };
  }
  // 早期 IP limiter は冪等チェックより前に返る。同じ authorization の応答喪失後再送も
  // 429 になりうるため、通常の構造化 error より先に専用状態へ分類する。
  if (!res.ok && res.status === 429 && b.error === 'ip_rate_limited') {
    throw new RelayIpRateLimitedError(retryAfterSeconds(res, b));
  }
  // その他の non-2xx + 構造化 {error:string} は server が broadcast 前に確定させた従来の
  // fallback-safe error (fee_required 等)。ここだけ再署名を許す。
  if (!res.ok && typeof b.error === 'string') throw new Error(b.error);
  // 2xx の不完全 envelope / 非構造化 non-2xx は未送信を証明できない。
  throw new RelayResponseUnknownError();
}

function payloadFromIntent(
  intent: UsageFeeIntentMetadata,
): UsageFeeRelayPayload {
  return {
    chainId: intent.chainId,
    from: intent.from,
    to: intent.to,
    value: intent.value,
    validAfter: '0',
    validBefore: intent.validBefore,
    nonce: intent.nonce,
    signature: intent.signature,
  };
}

export function useUsageFeePayment(deployment: TokenDeployment) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();

  // 応答不明 latch。broadcast 済みかもしれない署名済 payload を保持し、確定応答が来る
  // まで新規署名を封じる (何の波及を断つか: 応答喪失 → 再試行 → 新 nonce → server 冪等
  // キー不一致 → 二重課金、という連鎖を断つ)。
  const retainedRef = useRef<RetainedUsageFeePayload | null>(null);

  // この hook が画面に載っているか (mutationFn の確認に使う)。React の StrictMode の mount→unmount→mount は
  // effect が同期で true に戻すので、その後に押された正当な 1 回目は止めない。番号 (useSalesMove の ticket) でなく
  // mountedRef で足りる: unmount した instance の ref は false のまま戻らず、試みを止めたいのはこの hook が画面から
  // 外れたときだけ (同じ mount の中の並行の試み = 同じ tick の二度押しはここでは扱わない・下の attemptInFlightRef が扱う)。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 試み中の印 (同期)。包みの mutate / mutateAsync が react-query に渡す前に立て (claimAttempt)、その mutation が終わった
  // (成功・失敗・throw のどれでも) ときに useMutation の onSettled で外す。
  // 何の波及を断つか: 同じ描画のうちの二度押し (/billing の支払いボタンを、pay.isPending の disabled を描いた再描画より前に
  // 2 回押した) が 2 つ目の mutation を作り、別の署名 (別の nonce) を求めて両方 POST すること (利用料の送金が 2 本とも成立し、
  // 2 本目が復旧の枠 openpay:usage-fee-intent:v1 を上書きする)。ボタンを止める isPending は react-query が知らせた後の
  // 再描画まで変わらないので、ref で同期に見る (useJpycEip3009Payment の #1043 と同じ形)。
  const attemptInFlightRef = useRef(false);

  // reload をまたいでも latch を失わないよう sessionStorage から復元する。復元後は
  // ambiguous 扱い = 同一 payload の再 POST だけを許可し、再署名は出さない。
  useEffect(() => {
    if (retainedRef.current) return;
    const intent = loadUsageFeeIntent();
    if (!intent) return;
    retainedRef.current = {
      payload: payloadFromIntent(intent),
      value: BigInt(intent.value),
      chainId: intent.chainId,
      from: intent.from,
      ambiguous: true,
    };
  }, []);

  const mutation = useMutation<UsageFeePayResult, Error, UsageFeePayVariables>({
    mutationFn: async ({ value }) => {
      // 何の波及を断つか: 画面 (/billing) を離れた (unmount した) hook の試みが、離れた後に POST と復旧の枠
      // (openpay:usage-fee-intent:v1) の保存・消去へ進むこと。react-query の mutation は (アプリで 1 つの) QueryClient の
      // MutationCache に残るので、mutate と同じ tick に unmount した試みは unmount の後に mutationFn を始め、offline で
      // 止まった (networkMode 'online' の paused) 試みは unmount の後でも online に戻ると再開する。開き直した画面 (新しい
      // hook) が払った後で、古い hook が保持した payload (応答不明 / IP 制限の後) を POST すると、新しい hook が枠を復元
      // できずに別の nonce で払っていれば (枠の保存の失敗等) 利用料の送金が 2 本になり、応答 (成立・構造化 4xx) によっては
      // 新しい hook の枠も消す。ここで止めれば、下の再送の分岐も新しい署名の分岐も何もしない (再送の分岐はこの確認から
      // POST の開始まで await を挟まない)。新しい署名の分岐もこの確認から署名を求めるまで await を挟まないので、署名を
      // 求める前の確認はこれ 1 つで足りる。止めた reject は呼出側 (OpenPayFeePanel の startPay) の .catch(() => null) が
      // 握り、unmount の後なので画面の状態は変わらない。
      if (!mountedRef.current) throw new Error('payment_cancelled');
      const retained = retainedRef.current;
      if (retained) {
        // 別 amount / 別 chain / 別 account の要求は、latch を落とさずに封鎖する
        // (落とすと未解決 payload を抱えたまま新しい nonce で署名できてしまう)。
        if (
          retained.value !== value ||
          (chainId !== undefined && retained.chainId !== chainId) ||
          (address !== undefined && !sameAddress(retained.from, address))
        ) {
          throw new RelayResponseUnknownError();
        }
        return settleUsageFeeRelay(retainedRef, retained, retained.payload);
      }

      if (!walletClient || !address || chainId === undefined) {
        throw new Error('wallet_not_connected');
      }
      const from = address as Address;
      const validBefore = BigInt(
        Math.floor(Date.now() / 1000) + AUTHORIZATION_VALIDITY_WINDOW_SEC,
      );
      const auth = {
        from,
        to: env.feeReceiver as Address,
        value,
        validAfter: 0n,
        validBefore,
        nonce: randomAuthorizationNonce(),
      };
      const typed = buildTransferWithAuthorizationTypedData(
        auth,
        chainId,
        deployment.address,
      );
      const signature = (await walletClient.signTypedData({
        account: address,
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      })) as Hex;

      const payload: UsageFeeRelayPayload = {
        chainId,
        from,
        to: auth.to,
        value: value.toString(),
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce: auth.nonce,
        signature,
      };
      // 何の波及を断つか: 署名を待つ間に画面を離れた試みが、署名が返った後で枠を上書きし POST すること。離れて開き直した
      // 画面 (新しい hook) で払い直して成立した後で、古い署名の画面でも承認すると、古い hook がその payload を POST して
      // 利用料の送金が 2 本になる (nonce が別なので両方成立する)。枠も古い payload で上書きされる。送らない署名は期限
      // (validBefore) で失効する。この確認から persistUsageFeeIntent・POST の開始まで await を挟まない。
      if (!mountedRef.current) throw new Error('payment_cancelled');
      // POST の **前に** 保存する。応答喪失とページ離脱が同時に起きても、reload 後に同じ
      // nonce を再 POST できる (保存失敗は握りつぶす = 決済本体を止めない・下記 persist 参照)。
      persistUsageFeeIntent(payload);
      return settleUsageFeeRelay(retainedRef, null, payload);
    },
    // 試み中の印を外す。mutationFn の本体を try/finally で包み直さず onSettled にしたのは (#1043 と同じ)、差分が小さいうえ、
    // mutationFn が始まらずに終わった mutation でも外れるため。react-query は成功でも失敗 (mutationFn の throw・入口の
    // payment_cancelled を含む) でもこれを呼ぶ (@tanstack/query-core 5.100 の Mutation.execute は、失敗の側の callback を
    // 1 つずつ try で包んで呼ぶ)。offline で止まった試み・署名の応答を待つ試みは終わるまで印が残るが、その間は isPending も
    // true (ボタンは disabled) なので、印が今まで押せた押下を新しく止めることは無い。
    onSettled: () => {
      attemptInFlightRef.current = false;
    },
  });

  const mutationMutate = mutation.mutate;
  const mutationMutateAsync = mutation.mutateAsync;

  // 試み中なら false (新しい mutation を作らない)。そうでなければ印を立てて true。true のときは同期のまま mutation を作る
  // (印を立てて mutation を作らない筋を作らない = 印が外れないまま残らない)。
  const claimAttempt = useCallback((): boolean => {
    if (attemptInFlightRef.current) return false;
    attemptInFlightRef.current = true;
    return true;
  }, []);

  // 二度押しの 2 回目は mutation を作らずに payment_in_progress で断る。新しい mutation を作らないので、react-query の
  // observer が見る 1 つ目の mutation (その途中の状態・結果) を画面から外さない。断った押下に送金の結果は無いので、結果を
  // 偽って resolve せず reject する。
  const mutateAsync = useCallback(
    (variables: UsageFeePayVariables): Promise<UsageFeePayResult> => {
      if (!claimAttempt()) return Promise.reject(new Error('payment_in_progress'));
      return mutationMutateAsync(variables);
    },
    [claimAttempt, mutationMutateAsync],
  );

  // 呼ぶ所は無いが、印を通らない入口を外に出さない (mutateAsync と同じく 2 回目は mutation を作らない)。
  const mutate = useCallback(
    (variables: UsageFeePayVariables): void => {
      if (!claimAttempt()) return;
      mutationMutate(variables);
    },
    [claimAttempt, mutationMutate],
  );

  // 試み中か (同じ印を同期に読む)。呼出側 (OpenPayFeePanel の startPay) が、押下を受けて画面の状態 (清算中の期間など) を
  // 書き換える **前に** 見る (断られる押下で 1 つ目の表示を書き換えない)。描画の値でなく関数なのは、同じ描画のうちの 2 回目に
  // 描画の時点の古い値を見せないため。
  const isAttemptInFlight = useCallback(() => attemptInFlightRef.current, []);

  return { ...mutation, mutate, mutateAsync, isAttemptInFlight };
}

// sessionStorage への保存は best-effort。何の波及を断つか: storage 障害 (Safari private /
// 容量) を「利用料が払えない」に変えない。保存できなくても同一 mount の memory latch は
// 効き続け、失うのは reload をまたいだ復元だけ。
function persistUsageFeeIntent(payload: UsageFeeRelayPayload): void {
  saveUsageFeeIntent({
    version: 1,
    chainId: payload.chainId,
    from: payload.from,
    to: payload.to,
    value: payload.value,
    validAfter: payload.validAfter,
    validBefore: payload.validBefore,
    nonce: payload.nonce,
    signature: payload.signature,
    issuedAt: Date.now(),
  });
}

// POST し、応答に応じて latch を更新する。
//   - 確定 (success / revert): latch を外す。再署名を許す唯一の結果。
//   - 202 pending: broadcast 済。latch を ambiguous のまま維持する。
//   - 応答不明: ambiguous latch を張る (単調・以後は外れない)。
//   - IP 制限: 未 broadcast の確定拒否だが、同一 payload の再 POST を強制するため latch は残す。
//   - 構造化 4xx: broadcast 前の拒否。ambiguous でなければ latch を外して再署名を許す。
async function settleUsageFeeRelay(
  retainedRef: { current: RetainedUsageFeePayload | null },
  retained: RetainedUsageFeePayload | null,
  payload: UsageFeeRelayPayload,
): Promise<UsageFeePayResult> {
  const latch = (ambiguous: boolean): RetainedUsageFeePayload => ({
    payload,
    value: BigInt(payload.value),
    chainId: payload.chainId,
    from: payload.from,
    ambiguous,
  });
  try {
    const result = await postUsageFeeRelay(payload);
    if (result.pending) {
      // broadcast 済・未確定。確定するまで再署名させない。
      retainedRef.current = latch(true);
    } else {
      // success / revert はどちらも on-chain 終端。ここだけが ambiguous latch を外せる。
      retainedRef.current = null;
      clearUsageFeeIntent();
    }
    return result;
  } catch (error) {
    if (retained?.ambiguous || isRelayResponseUnknownError(error)) {
      // ambiguity は単調 latch。後続の構造化 400 / 429 / 再 unknown で解除すると、
      // 実は着金済みだったときに新しい nonce で署名し直して二重課金になる。
      retainedRef.current = latch(true);
    } else if (isRelayIpRateLimitedError(error)) {
      // IP limiter は relay 処理前の確定的拒否。payload は同一 nonce 再 POST 用に保持する。
      retainedRef.current = latch(false);
    } else {
      // 構造化 4xx (broadcast 前の拒否) / ローカル失敗。再署名して構わない。
      retainedRef.current = null;
      clearUsageFeeIntent();
    }
    throw error;
  }
}
