'use client';

// 「売上をほかのウォレットへ移す」(plans/store-sales-move.md §2.2・§2.3・P2a) の client hook。
// お店がウォレットの JPYC を、利用料 (relay の gas floor) の上乗せで自分の別のウォレットへ移す。署名はチップと同じ recover の形:
// receiveWithAuthorization (to = forwarder・nonce = 分割のコミットメント) に 1 回署名 → POST /api/relay/jpyc/move →
// OpenPay の relayer が Eip3009Forwarder.settle を送る → 送り先へ移す額・OpenPay へ利用料。
//
// 応答の分類と latch は hooks/useJpycEip3009Payment.ts の postRelayPayload・hooks/useUsageFeePayment.ts の
// postUsageFeeRelay と **同じ語彙・同じ分岐順** にする (どれか 1 つだけが新しい応答を fallback 安全と読むと、その hook だけ
// 再署名 = 二重の送金の経路が残る・tests/hooks/relayResponseClassification.test.tsx が 4 つの hook を 1 つの表で固定する)。
//   - 200 ok + txHash → 成功。200 reverted + txHash → 成立しなかった (JPYC は動いていない・次は新しい署名で構わない)。
//   - 202 pending → 送信済み・未確定。throw せずに返し、保持を続ける (次は nonce の status 照会だけ)。
//   - 429 ip_rate_limited → 署名済みの payload を memory に保持し、次は同じ payload の再 POST だけ。
//   - 構造化の non-2xx → server が broadcast 前に確定させた拒否。保持を外す (次は新しい署名)。
//   - それ以外 (fetch の失敗・非 JSON・形の崩れた応答) → 応答不明。ambiguous の latch (単調) を張り、再署名しない。
// ambiguous の解き方は決済 hook と同じ: 署名は保存せず、公開 metadata (openpay:move-intent:v1・決済の枠とは別のキー) だけを
// 保存して /api/relay/jpyc/status を nonce で照会する (lib/relay/relayIntentRecovery.ts)。ページを開き直したときも同じ。
//
// 試みは 1 つずつで、試みごとに番号 (ticket) を持つ。入口 (move / moveAsync) は react-query に渡す **前に** 同期で
//   1. 試み中 (claimed / running) なら新しい mutation を作らずに断る (二度押し・並行の呼び出し)。
//   2. 番号を取り、mutation の変数に載せる。
// unmount で番号を進めるので、まだ始まっていない (react-query の待ち行列にある・offline で止まっている) 試みも無効になる。
// mutationFn は最初に番号を確かめ (保持した payload の再送・照会の分岐より前)、さらにウォレットの JPYC の読み直しと署名の
// await の後ごとに確かめる。最後の確認と枠の保存・POST の間に await は無い。無効になった試みは枠を書かず POST もしない
// (画面を離れて戻り、新しい試みが送信済みになった後で、古い署名や止まっていた再送が動いても、2 本目を送らず枠も上書きしない)。
// POST を始めた後は今までどおり保持と照会で解く。
// IP 制限 (429) で保持した署名済みの payload は、この hook の memory (retainedRef) にだけある (枠には残さない)。それを送るのは
// この hook の mutationFn の再送の分岐だけで、timer も照会 (照会は ambiguous の保持だけ・読み取りだけ) も送らない。だから
// hook が unmount すると、その payload は二度と送られない (429 は冪等の claim より前の拒否で、その POST は何も動かしていない =
// 開き直した画面で新しい署名をしても二重にはならない)。送られない署名は期限 (5 分) で失効する。
//
// 受容した限界 (決済 hook と同じ): 202 pending の後に tx が revert すると authorization は未使用に戻るが、server の冪等の記録
// (relay:idem: の hash・lib/relay/relayGuards.ts の IDEM_TTL_SEC = 1,800 秒) が残る間は /api/relay/jpyc/status が
// indeterminate を返す (hash があるのに unused を新しい署名の許可に使わない・status route)。その間この画面は「送信済み・確定待ち」の
// まま再署名を止める。解除は照会の部品 (lib/relay/relayIntentRecovery.ts) の規則どおり、**連続 2 回の unused で、最新の応答が
// expiry: 'expired' (チェーンで期限切れ未使用を証明)** のときだけ (indeterminate や応答なしは連続の数を 0 に戻す)。記録が消えて
// から開き直すと、この規則で入力に戻る。1 回の revert を理由に解除する道は作らない (置換や再送と区別できない)。
//
// 決済でもチップでもないので、お店の履歴 (lib/history・売上・CSV・集計) には入れない。支払う側の控え (lib/payerReceipt) にだけ
// 「届く額」と「利用料」を別の項目で残す (§2.2・Q6)。署名・鍵・秘密の値はログに出さない (logger には chainId と段階だけ)。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { erc20Abi, formatUnits, type Address, type Hex } from 'viem';
import {
  AUTHORIZATION_VALIDITY_WINDOW_SEC,
  randomAuthorizationNonce,
} from '@/lib/jpycEip3009';
import {
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { jpycForwarderFor, relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { isSalesMoveChain } from '@/lib/relay/salesMove';
import { resolveRelayIntent } from '@/lib/relay/relayIntentRecovery';
import { waitForStoredRelayReceipt } from '@/lib/relay/relayStoredReceipt';
import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
  RelayIpRateLimitedError,
  RelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';
import {
  clearSalesMoveIntent,
  loadSalesMoveIntent,
  saveSalesMoveIntent,
  type RelayIntentMetadata,
  type SalesMoveIntentMetadata,
} from '@/lib/paymentIntentStorage';
import {
  appendPayerReceipt,
  buildPayerReceipt,
  promotePayerReceiptStatus,
  type BuildPayerReceiptInput,
} from '@/lib/payerReceipt';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { isUserRejection } from '@/lib/walletErrors';
import type { TokenDeployment } from '@/lib/tokens';

export const SALES_MOVE_RELAY_URL = '/api/relay/jpyc/move';

export type SalesMoveParams = {
  /** 送り先 (画面で形と拒否を確かめた後の値)。 */
  destination: Address;
  /** 送り先に届く額 (wei)。利用料はこの額に上乗せされる。 */
  amount: bigint;
};

// success=false (pending でない) は「relay は成立したが tx が on-chain で revert」。pending は送信済み・未確定 (throw しない:
// throw すると呼出側が新しい署名へ進めてしまう)。txHash は pending (使用済みの authorization) で null になりうる。
export type SalesMoveResult = {
  txHash: Hex | null;
  success: boolean;
  pending?: boolean;
};

/** 支払う側の控えの明細の名前 (画面の言語の文言を呼出側が渡す)。 */
export type SalesMoveReceiptLabels = {
  delivered: string;
  fee: string;
  locale: string;
};

type RetainedMove = {
  // 開き直した後の照会では署名を持たないので null。status は公開 metadata の nonce で照会する。
  payload: Record<string, unknown> | null;
  intent: SalesMoveIntentMetadata;
  // false→true のみ許す単調 latch。on-chain の成功 / revert か失効が証明されたときだけ ref ごと外す。
  ambiguous: boolean;
};

/**
 * 保持の状態 (画面に出す)。'ambiguous' = 送信済みかもしれない (再署名しない・status 照会だけ)。'retry' = IP 制限で保持した
 * 署名済み payload (同じ payload の再送だけ)。null = 保持なし (次は新しい署名)。
 */
export type SalesMoveHeld = 'ambiguous' | 'retry' | null;

function heldOf(retained: RetainedMove | null): SalesMoveHeld {
  if (retained === null) return null;
  return retained.ambiguous || !retained.payload ? 'ambiguous' : 'retry';
}

type RelayResponse = {
  ok?: boolean;
  txHash?: Hex | null;
  reverted?: boolean;
  pending?: boolean;
  error?: string;
  retryAfter?: number;
};

function isRelayResponse(value: unknown): value is RelayResponse {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// tx hash は 0x + 64 桁の hex だけ。形の崩れた txHash の応答は成功・revert・pending のどれにもせず、末尾の応答不明に落とす。
function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function retryAfterSeconds(res: Response, body: RelayResponse): number | null {
  const raw = body.retryAfter ?? res.headers.get('retry-after');
  if (raw === null || raw === undefined || raw === '') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

// relay POST + 応答判定。useJpycEip3009Payment.postRelayPayload と同じ語彙・同じ分岐順 (URL だけが違う)。
async function postSalesMove(
  payload: Record<string, unknown>,
): Promise<SalesMoveResult> {
  let res: Response;
  try {
    res = await fetch(SALES_MOVE_RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // POST が server に届いた後で応答だけ失われた可能性がある。通常エラーへ倒すと新しい署名が二重の移動へ波及するため、
    // 専用の曖昧状態にする。
    throw new RelayResponseUnknownError();
  }

  let parsedBody: unknown;
  try {
    parsedBody = await res.json();
  } catch {
    // body 読取失敗も broadcast 前を証明できないため、再署名してよい拒否にしない。
    throw new RelayResponseUnknownError();
  }
  if (!isRelayResponse(parsedBody)) throw new RelayResponseUnknownError();
  const body = parsedBody;

  if (res.ok && body.ok === true && isTxHash(body.txHash)) {
    return { txHash: body.txHash, success: true };
  }
  // relay は成立したが tx が revert (ウォレットの JPYC の変動等)。送金は起きていない。
  if (body.reverted === true && isTxHash(body.txHash)) {
    return { txHash: body.txHash, success: false };
  }
  // 202: broadcast 済だが未確定。throw せず pending を返す。txHash は使用済みのケースで null になりうる。
  if (
    res.status === 202 &&
    body.pending === true &&
    (body.txHash === undefined || body.txHash === null || isTxHash(body.txHash))
  ) {
    return { txHash: body.txHash ?? null, success: false, pending: true };
  }
  // 早期 IP limiter は冪等チェックより前に返る。同じ authorization の応答喪失後再送も 429 になりうるため、通常の構造化
  // error より先に専用状態へ分類する。
  if (!res.ok && res.status === 429 && body.error === 'ip_rate_limited') {
    throw new RelayIpRateLimitedError(retryAfterSeconds(res, body));
  }
  // その他の non-2xx + 構造化 {error:string} は server が broadcast 前に確定させた拒否。2xx の不完全 envelope /
  // 非構造化 non-2xx は未送信を証明できない。
  if (!res.ok && typeof body.error === 'string') throw new Error(body.error);
  throw new RelayResponseUnknownError();
}

// status の照会は既存の recover の形のまま (status route は routeKind を見ない・同じ relay:idem: を読む)。
function relayIntentOf(intent: SalesMoveIntentMetadata): RelayIntentMetadata {
  return {
    chainId: intent.chainId,
    from: intent.from,
    merchant: intent.merchant,
    merchantValue: intent.merchantValue,
    feeValue: intent.feeValue,
    nonce: intent.nonce,
    validBefore: intent.validBefore,
    routeKind: 'recover',
    issuedAt: intent.issuedAt,
  };
}

function sameIntent(a: SalesMoveIntentMetadata, b: SalesMoveIntentMetadata): boolean {
  return (
    a.chainId === b.chainId &&
    a.from.toLowerCase() === b.from.toLowerCase() &&
    a.nonce.toLowerCase() === b.nonce.toLowerCase()
  );
}

function clearSavedIntent(intent: SalesMoveIntentMetadata): void {
  const saved = loadSalesMoveIntent();
  if (saved && sameIntent(saved, intent)) clearSalesMoveIntent();
}

const JPYC_DECIMALS = 18;

type ReceiptLine = NonNullable<BuildPayerReceiptInput['lineItems']>[number];

function receiptLine(name: string, amount: string): ReceiptLine {
  return {
    name,
    quantity: 1,
    unitPrice: amount,
    amount,
    taxRate: null,
    taxCategory: 'out_of_scope',
    taxAmount: '0',
    memo: null,
  };
}

export function useSalesMove(
  deployment: TokenDeployment,
  labels: SalesMoveReceiptLabels,
) {
  const { data: walletClient } = useWalletClient();
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: deployment.chainId });

  const retainedRef = useRef<RetainedMove | null>(null);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const mountedRef = useRef(true);
  // 試みの番号 (ticket)。入口で進めて mutation の変数に載せ、unmount でも進める。mutationFn の中で自分の番号でなくなった試みは
  // 何も書かずに止める (まだ始まっていない試みも、署名を待っている試みも)。
  const attemptRef = useRef(0);
  // 入口の直列化 (同期の印)。'claimed' = 入口が mutation を作った (mutationFn はまだ) ・'running' = mutationFn の中。
  // 入口 (move / moveAsync) が react-query に渡す前に見るので、2 つ目の mutation を作らない (react-query の observer は最後の
  // mutation だけを見るので、断った 2 つ目で 1 つ目の結果・送信済みの印を画面から消さない)。
  const entryRef = useRef<'idle' | 'claimed' | 'running'>('idle');
  const recoveryPromiseRef = useRef<{ retained: RetainedMove; promise: Promise<SalesMoveResult> } | null>(null);
  const recoverySleepRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryWakeRef = useRef<(() => void) | null>(null);
  const recoveryFetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [restoredResult, setRestoredResult] = useState<SalesMoveResult | null>(null);
  const [restoredError, setRestoredError] = useState<Error | null>(null);
  const [recoveryState, setRecoveryState] = useState<'auto' | 'exhausted' | null>(null);
  // 保持 (retainedRef) の写し。ref は描画を起こさないので、変えるときは必ず setRetained を通して画面にも知らせる。
  const [held, setHeld] = useState<SalesMoveHeld>(null);
  const setRetained = useCallback((next: RetainedMove | null) => {
    retainedRef.current = next;
    if (mountedRef.current) setHeld(heldOf(next));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 署名を待っている試みを無効にする (署名が後から返っても、この hook は枠を書かず POST もしない)。
      attemptRef.current += 1;
      if (recoverySleepRef.current !== null) clearTimeout(recoverySleepRef.current);
      recoveryWakeRef.current?.();
      recoveryWakeRef.current = null;
      if (recoveryFetchTimeoutRef.current !== null) clearTimeout(recoveryFetchTimeoutRef.current);
      recoveryAbortRef.current?.abort();
    };
  }, []);

  const setRecoveryStateIfMounted = useCallback((state: 'auto' | 'exhausted' | null) => {
    if (mountedRef.current) setRecoveryState(state);
  }, []);

  // 支払う側の控え (届く額と利用料を別の明細・合計 = ウォレットから出た額)。同じ tx は receiptId (txHash) で 1 件にまとまり、
  // pending の控えは後から confirmed / failed に上がる (appendPayerReceipt)。revert は pending の控えがあるときだけ failed に
  // する (成立しなかった移動の控えを新しく作らない)。
  const recordReceipt = useCallback(
    (intent: SalesMoveIntentMetadata, txHash: Hex, status: 'confirmed' | 'pending' | 'failed') => {
      if (status === 'failed') {
        promotePayerReceiptStatus(txHash, 'failed');
        return;
      }
      const delivered = BigInt(intent.merchantValue);
      const fee = BigInt(intent.feeValue);
      const total = formatUnits(delivered + fee, JPYC_DECIMALS);
      const { delivered: deliveredLabel, fee: feeLabel, locale } = labelsRef.current;
      appendPayerReceipt(
        buildPayerReceipt({
          txHash,
          chainId: intent.chainId,
          asset: 'jpyc',
          tokenAddress: deployment.address,
          amount: total,
          merchantAddress: intent.merchant,
          payerAddress: intent.from,
          paymentMode: 'gasless',
          gasMode: 'customer',
          lineItems: [
            receiptLine(deliveredLabel, formatUnits(delivered, JPYC_DECIMALS)),
            receiptLine(feeLabel, formatUnits(fee, JPYC_DECIMALS)),
          ],
          totalAmount: total,
          feeAmount: formatUnits(fee, JPYC_DECIMALS),
          status,
          sourceRoute: '/create#move',
          locale,
        }),
      );
    },
    [deployment.address],
  );

  const resolveAmbiguous = useCallback(
    (retained: RetainedMove): Promise<SalesMoveResult> => {
      const existing = recoveryPromiseRef.current;
      if (existing?.retained === retained) return existing.promise;

      const run = (async (): Promise<SalesMoveResult> => {
        setRecoveryStateIfMounted('auto');
        const outcome = await resolveRelayIntent({
          intent: relayIntentOf(retained.intent),
          isMounted: () => mountedRef.current,
          registerSleep: (timer, wake) => {
            recoverySleepRef.current = timer;
            recoveryWakeRef.current = wake;
          },
          clearSleep: (timer) => {
            if (recoverySleepRef.current === timer) {
              recoverySleepRef.current = null;
              recoveryWakeRef.current = null;
            }
          },
          registerFetch: (timer, controller) => {
            recoveryFetchTimeoutRef.current = timer;
            recoveryAbortRef.current = controller;
          },
          clearFetch: (timer, controller) => {
            if (recoveryFetchTimeoutRef.current === timer) recoveryFetchTimeoutRef.current = null;
            if (recoveryAbortRef.current === controller) recoveryAbortRef.current = null;
          },
          waitForReceipt:
            publicClient && retained.intent.chainId === deployment.chainId
              ? async (hash, timeout) => {
                  const receipt = await publicClient.waitForTransactionReceipt({
                    hash,
                    confirmations: 1,
                    timeout,
                  });
                  return { status: receipt.status };
                }
              : (hash, timeout) => waitForStoredRelayReceipt(retained.intent.chainId, hash, timeout),
        });
        if (outcome.kind === 'expired') {
          // チェーン上で期限切れかつ未使用と証明された = この署名ではもう移らない。保持を外し、次は新しい署名を許す。
          if (retainedRef.current === retained) setRetained(null);
          clearSavedIntent(retained.intent);
          setRecoveryStateIfMounted(null);
          throw new Error('relay_unused');
        }
        if (outcome.kind === 'settled') {
          if (retainedRef.current === retained) setRetained(null);
          clearSavedIntent(retained.intent);
          setRecoveryStateIfMounted(null);
          recordReceipt(retained.intent, outcome.txHash, outcome.success ? 'confirmed' : 'failed');
          return { txHash: outcome.txHash, success: outcome.success };
        }
        setRecoveryStateIfMounted('exhausted');
        throw new RelayResponseUnknownError();
      })();

      recoveryPromiseRef.current = { retained, promise: run };
      void run
        .finally(() => {
          if (recoveryPromiseRef.current?.promise === run) recoveryPromiseRef.current = null;
        })
        .catch(() => undefined);
      return run;
    },
    [deployment.chainId, publicClient, recordReceipt, setRecoveryStateIfMounted, setRetained],
  );
  const resolveAmbiguousRef = useRef(resolveAmbiguous);
  resolveAmbiguousRef.current = resolveAmbiguous;

  // 開き直したときの照会: 枠があれば、署名を持たない保持として nonce の status を照会し、結果を出す (終端で枠を消す)。
  // React の開発時の二重 mount では、1 回目に張った保持と照会にそのまま付き直す (同じ nonce を 2 本照会しない)。
  useEffect(() => {
    let active = true;
    let retained = retainedRef.current;
    if (!retained) {
      const saved = loadSalesMoveIntent();
      if (saved) retained = { payload: null, intent: saved, ambiguous: true };
    }
    if (retained) setRetained(retained);
    setStorageReady(true);
    if (retained && retained.payload === null) {
      void resolveAmbiguousRef
        .current(retained)
        .then((result) => {
          if (!active) return;
          setRestoredResult(result);
          setRestoredError(null);
        })
        .catch((error: unknown) => {
          if (!active) return;
          if (error instanceof Error && error.message === 'relay_unused') {
            // 期限切れで使われなかった枠は何も出さない (前の画面の操作の失敗を新しい操作に持ち越さない)。
            setRestoredError(null);
            return;
          }
          setRestoredError(error instanceof Error ? error : new RelayResponseUnknownError());
        });
    }
    return () => {
      active = false;
    };
    // setRetained は依存の無い useCallback (mount の間は同じ関数) なので、この effect は mount ごとに 1 回だけ動く。
  }, [setRetained]);

  // POST の前に公開 metadata を保存し、応答で保持と枠を決める。初回の送信と、IP 制限で保持した payload の再送で共有する。
  const send = useCallback(
    async (payload: Record<string, unknown>, intent: SalesMoveIntentMetadata): Promise<SalesMoveResult> => {
      // 何の波及を断つか: POST が届いた後に応答を失ってページを閉じても、開き直したときに同じ nonce を照会できる
      // (照会できないと新しい署名 = 二重の移動へ進めてしまう)。署名そのものは保存しない。
      saveSalesMoveIntent(intent);
      try {
        const result = await postSalesMove(payload);
        if (result.pending) {
          // broadcast 済み・未確定。保持を ambiguous にし (次は status 照会だけ)、枠も残す。
          setRetained({ payload, intent, ambiguous: true });
          if (result.txHash) recordReceipt(intent, result.txHash, 'pending');
        } else {
          // txHash 付きの成功 / revert は on-chain の確定結果。保持と枠を外す。
          setRetained(null);
          clearSavedIntent(intent);
          if (result.txHash) recordReceipt(intent, result.txHash, result.success ? 'confirmed' : 'failed');
        }
        setRecoveryState(null);
        return result;
      } catch (error) {
        if (isRelayResponseUnknownError(error)) {
          // ambiguity は単調 latch。同じ nonce の status を照会して解く (再署名しない)。
          const ambiguous: RetainedMove = { payload, intent, ambiguous: true };
          setRetained(ambiguous);
          return resolveAmbiguous(ambiguous);
        }
        if (isRelayIpRateLimitedError(error)) {
          // IP limiter は relay 処理前の確定的拒否。署名済み payload は同じ mount の再送用に memory へ残し、未 broadcast の
          // 枠が開き直した後の操作を塞ぐ波及は断つ (再送の前に保存し直す)。
          setRetained({ payload, intent, ambiguous: false });
          clearSavedIntent(intent);
        } else {
          setRetained(null);
          clearSavedIntent(intent);
        }
        throw error;
      }
    },
    [recordReceipt, resolveAmbiguous, setRetained],
  );

  const runMove = useCallback(
    async ({ destination, amount }: SalesMoveParams, ticket: number): Promise<SalesMoveResult> => {
      // この試みがまだ有効か (unmount・新しい試みで無効になる)。入口と await の後ごとに確かめ、無効なら枠も POST も触らずに止める。
      const stillCurrent = () => mountedRef.current && attemptRef.current === ticket;
      // react-query が mutationFn を始めた時点で、もう画面を離れていた (待ち行列・offline で止まっていた) 試みは何もしない。
      // 保持した payload の再送 (IP 制限の後) もここで止まる (送るのはこの確認の直後で、間に await は無い)。
      if (!stillCurrent()) throw new Error('move_cancelled');
      // 未解決の保持がある間は、呼出側が誤って通常の入口を呼んでも新しい署名を出さない (同じ payload の再送か照会だけ)。
      const retained = retainedRef.current;
      if (retained) {
        if (retained.ambiguous || !retained.payload) return resolveAmbiguous(retained);
        return send(retained.payload, retained.intent);
      }

      if (!walletClient || !address || chainId === undefined) {
        throw new Error('wallet_not_connected');
      }
      if (chainId !== deployment.chainId || !isSalesMoveChain(chainId)) {
        throw new Error('unsupported_chain');
      }
      const forwarder = jpycForwarderFor(chainId);
      if (!forwarder) throw new Error('relay_not_configured');
      const from = address as Address;
      const fee = relayGasFeeValue(chainId);

      // 署名の前にウォレットにある JPYC を読み直す (画面に出した値は古いことがある)。足りない署名は出させない。
      if (!publicClient) throw new Error('balance_unavailable');
      let balance: bigint;
      try {
        balance = await publicClient.readContract({
          address: deployment.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [from],
        });
      } catch {
        // 読めないまま署名させない (足りない署名は server の検証で落ちるだけだが、確かめずに署名を求めない)。
        throw new Error('balance_unavailable');
      }
      if (!stillCurrent()) throw new Error('move_cancelled');
      if (amount + fee > balance) throw new Error('insufficient_balance');

      const validBefore = BigInt(Math.floor(Date.now() / 1000) + AUTHORIZATION_VALIDITY_WINDOW_SEC);
      const params: ForwarderSettleParams = {
        from,
        merchant: destination,
        merchantValue: amount,
        feeReceiver: env.feeReceiver as Address,
        feeValue: fee,
        validAfter: 0n,
        validBefore,
        intentSalt: randomAuthorizationNonce(),
      };
      const typed = buildReceiveWithAuthorizationTypedData(params, chainId, deployment.address, forwarder);
      const intent: SalesMoveIntentMetadata = {
        version: 1,
        chainId,
        from,
        merchant: destination,
        merchantValue: amount.toString(),
        feeValue: fee.toString(),
        nonce: typed.message.nonce,
        validBefore: validBefore.toString(),
        issuedAt: Date.now(),
      };

      // 署名の前後と取り消しを記録する (署名の中身・エラーの本文は記録しない)。catch は分類のためで必ず投げ直す。
      logger.info('sales_move.sign_requested', { chainId });
      let signature: Hex;
      try {
        signature = (await walletClient.signTypedData({
          account: from,
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        })) as Hex;
      } catch (err) {
        if (isUserRejection(err)) logger.info('sales_move.sign_rejected', { chainId });
        else logger.warn('sales_move.sign_failed', { chainId });
        throw err;
      }
      logger.info('sales_move.sign_completed', { chainId });
      if (!stillCurrent()) {
        // 署名を待つ間に画面を離れた (または新しい試みが始まった)。この署名は送らず、保存もしない (送らない署名は期限で失効する)。
        logger.info('sales_move.sign_abandoned', { chainId });
        throw new Error('move_cancelled');
      }

      // gasMode・feeKind・tipMessage は送らない (route は利用料を relay の gas floor に固定し、送られても読まない)。
      // feeReceiver も送らない (server 権威・nonce で一致を強制する)。
      const payload: Record<string, unknown> = {
        chainId,
        from,
        merchant: destination,
        merchantValue: amount.toString(),
        feeValue: fee.toString(),
        validAfter: '0',
        validBefore: validBefore.toString(),
        intentSalt: params.intentSalt,
        signature,
      };
      intent.issuedAt = Date.now();
      return send(payload, intent);
    },
    [address, chainId, deployment.address, deployment.chainId, publicClient, resolveAmbiguous, send, walletClient],
  );

  // mutation の変数 = 押された内容と、入口で取った試みの番号。mutation は入口 (claimEntry を通ったもの) だけが作る
  // (mutate / mutateAsync をそのまま外へ出さない)。
  const mutation = useMutation<SalesMoveResult, Error, { params: SalesMoveParams; ticket: number }>({
    mutationFn: async ({ params, ticket }) => {
      entryRef.current = 'running';
      try {
        return await runMove(params, ticket);
      } finally {
        entryRef.current = 'idle';
      }
    },
  });

  const mutationData = mutation.data;
  const mutationMutate = mutation.mutate;
  const mutationMutateAsync = mutation.mutateAsync;
  const mutationReset = mutation.reset;

  // 入口の同期の部分: 試み中なら null (新しい mutation を作らない)。そうでなければ印を立てて試みの番号を返す。
  const claimEntry = useCallback((): number | null => {
    if (entryRef.current !== 'idle') return null;
    entryRef.current = 'claimed';
    attemptRef.current += 1;
    return attemptRef.current;
  }, []);

  const move = useCallback(
    (variables: SalesMoveParams) => {
      // 開き直した後の照会の前に押されたもの・成立した / 送信済みの後に押されたものは送らない (二重の移動を止める)。
      if (!storageReady) return;
      if (
        mutationData?.success ||
        mutationData?.pending ||
        restoredResult?.success ||
        restoredResult?.pending
      ) {
        return;
      }
      // 二度押し: 前の押下の mutationFn が始まる前 (claimed) も、その途中 (running) も、新しい mutation を作らない。
      const ticket = claimEntry();
      if (ticket === null) return;
      setRestoredResult(null);
      setRestoredError(null);
      mutationMutate({ params: variables, ticket });
    },
    [claimEntry, mutationData, mutationMutate, restoredResult, storageReady],
  );

  // 結果を待てる入口 (テストと、結果を await したい呼出側)。move と同じ同期の直列化を通す: 試み中なら mutation を作らずに
  // move_in_progress で断る (1 つ目の結果・送信済みの印を画面から消さない)。成立・送信済みの後に呼んでも、新しい署名は出ない
  // (mutationFn の保持の分岐が同じ payload の再送か照会だけにする)。
  const moveAsync = useCallback(
    (variables: SalesMoveParams): Promise<SalesMoveResult> => {
      const ticket = claimEntry();
      if (ticket === null) return Promise.reject(new Error('move_in_progress'));
      setRestoredResult(null);
      setRestoredError(null);
      return mutationMutateAsync({ params: variables, ticket });
    },
    [claimEntry, mutationMutateAsync],
  );

  // 前の結果 (revert・拒否) を消して入力からやり直す。保持がある間 (送信済みかもしれない・IP 制限の再送待ち) は消さない。
  const reset = useCallback(() => {
    if (retainedRef.current) return;
    mutationReset();
    setRestoredResult(null);
    setRestoredError(null);
  }, [mutationReset]);

  return {
    moveAsync,
    move,
    reset,
    result: mutationData ?? restoredResult ?? undefined,
    error: mutation.error ?? restoredError,
    isPending: !storageReady || mutation.isPending || recoveryState === 'auto',
    isRestoring: !storageReady,
    /** 照会中 (送信済みかもしれない移動の status を読んでいる)。 */
    isRecovering: recoveryState === 'auto',
    held,
  };
}
