'use client';

// Creator Store hosted 商品専用の buyer hook。recover/relay hook とは署名 wire・retry 契約を共有しない。
//
// flow:
//   prepare()  = 選択 rail と payer を付けて v1 402 を取得し、rail 専用 normalizer で card/intent を検証
//   purchase() = 最終確認 UI の確定操作後に初めて EIP-3009 typed-data を署名し、X-PAYMENT 付き GET
//   retry()    = 保持済みの同一 X-PAYMENT header で同じ GET を再送するだけ（再署名しない）
//   202/通信断 = intentSalt の status を自動 polling。settled 後も own content API の 200 read-back まで
//                「購入完了」にしない

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAddress, type Address, type Hex } from 'viem';
import { useAccount, useWalletClient } from 'wagmi';
import {
  buildHostedPurchaseTypedData,
  createHostedPurchaseAuthorization,
  encodeHostedPaymentHeader,
  hostedPaymentPayload,
  HostedPurchaseWireError,
  normalizeHostedPaymentRequired,
  type HostedPurchaseQuote,
} from '@/lib/x402/hostedPurchaseWire';
import {
  buildHostedUsdcPurchaseTypedData,
  createHostedUsdcAuthorization,
  encodeHostedUsdcPaymentHeader,
  hostedUsdcPaymentSnapshotMatchesQuote,
  HostedUsdcPurchaseWireError,
  normalizeHostedUsdcPaymentRequired,
  type HostedUsdcPurchaseQuote,
} from '@/lib/x402/hostedUsdcPurchaseWire';

// status route は 30 req/min/IP。初回即時 fetch を含めても limiter を踏まない余白を持たせる。
const STATUS_POLL_INTERVAL_MS = 3_000;
const CONTENT_POLL_INTERVAL_MS = 2_000;
const OWNERSHIP_READ_BACK_TIMEOUT_MS = 60_000;
const PAYMENT_STATUS_RECOVERY_TIMEOUT_MS = 90_000;

export type HostedStorePaymentRail = 'jpyc' | 'usdc';
export type HostedStorePurchaseQuote =
  | HostedPurchaseQuote
  | HostedUsdcPurchaseQuote;

export type HostedStorePurchasePhase =
  | 'idle'
  | 'loading-quote'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'indeterminate'
  | 'indeterminate-exhausted'
  | 'provisioning'
  | 'ready'
  | 'needs-support'
  | 'failed-prebroadcast'
  | 'error';

export type HostedStorePaymentStatus =
  | 'not-started'
  | 'not-executed'
  | 'unknown'
  | 'confirmed';

export type HostedStoreAccessStatus =
  | 'none'
  | 'provisioning'
  | 'ready'
  | 'needs-support';

export type HostedPurchasedContent = {
  ok: true;
  state: 'ready';
  resourceId: string;
  intentSalt: Hex;
  title: string;
  contentRevision: number;
  kind: 'url' | 'text';
  value: string;
};

export type HostedProvidedEnded = {
  ok: true;
  state: 'provided-ended';
  resourceId: string;
  intentSalt: Hex;
  title: string;
  contentRevision: number;
};

export type HostedStoreNeedsSupportReason =
  | 'provided-ended'
  | 'ownership-readback-timeout'
  | 'payment-status-timeout';

export type HostedStorePurchaseErrorCode =
  | 'disabled'
  | 'wallet_not_connected'
  | 'siwe_required'
  | 'wrong_chain'
  | 'quote_http_error'
  | 'quote_expected_402'
  | 'quote_invalid_json'
  | 'quote_invalid'
  | 'review_required'
  | 'wallet_unavailable'
  | 'wallet_changed'
  | 'signature_rejected'
  | 'signed_payment_unavailable';

export class HostedStorePurchaseError extends Error {
  readonly code: HostedStorePurchaseErrorCode;

  constructor(
    code: HostedStorePurchaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HostedStorePurchaseError';
    this.code = code;
  }
}

type PurchaseStatusResponse =
  | { ok: true; state: 'pending' }
  | { ok: true; state: 'failed' }
  | { ok: true; state: 'settled'; txHash: Hex };

type ContentReadBack =
  | { state: 'pending' }
  | { state: 'timed-out' }
  | HostedPurchasedContent
  | HostedProvidedEnded;

type SignedHostedRequest = {
  url: string;
  header: string;
  intentSalt: Hex;
  payer: Address;
  quote: HostedStorePurchaseQuote;
};

type PreparedHostedSigning =
  | {
      rail: 'jpyc';
      quote: HostedPurchaseQuote;
      authorization: ReturnType<typeof createHostedPurchaseAuthorization>;
      typedData: ReturnType<typeof buildHostedPurchaseTypedData>;
    }
  | {
      rail: 'usdc';
      quote: HostedUsdcPurchaseQuote;
      authorization: ReturnType<typeof createHostedUsdcAuthorization>;
      typedData: ReturnType<typeof buildHostedUsdcPurchaseTypedData>;
    };

type UseHostedStorePurchaseInput = {
  resourceId: string;
  /** card に表示した商品名。USDC 402 description と照合する。 */
  title: string;
  /** profile の hosted product metadata にある seller payTo。402 merchant と照合する。 */
  merchant: Address;
  /** profile card に表示した human JPYC 整数。402 merchantValue と署名前に一致確認する。 */
  priceJpyc: string;
  /** 現在の SIWE session。connected wallet と一致しない限り quote を取得しない。 */
  sessionAddress: Address | null;
  /** modal 内で明示選択した rail。未指定時は既存 JPYC 経路。 */
  rail?: HostedStorePaymentRail;
  enabled?: boolean;
};

function sameAddress(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function purchaseStatusFrom(value: unknown): PurchaseStatusResponse {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error('purchase_status_invalid');
  }
  if (value.state === 'pending' || value.state === 'failed') {
    return { ok: true, state: value.state };
  }
  if (
    value.state === 'settled' &&
    typeof value.txHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(value.txHash)
  ) {
    return {
      ok: true,
      state: 'settled',
      txHash: value.txHash as Hex,
    };
  }
  throw new Error('purchase_status_invalid');
}

function contentReadBackFrom(
  value: unknown,
  resourceId: string,
  intentSalt: Hex,
): HostedPurchasedContent | HostedProvidedEnded {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.resourceId !== resourceId ||
    typeof value.intentSalt !== 'string' ||
    value.intentSalt.toLowerCase() !== intentSalt.toLowerCase() ||
    typeof value.title !== 'string' ||
    !Number.isSafeInteger(value.contentRevision) ||
    (value.contentRevision as number) <= 0
  ) {
    throw new Error('store_content_invalid');
  }
  if (value.state === 'provided-ended') {
    return {
      ok: true,
      state: 'provided-ended',
      resourceId,
      intentSalt,
      title: value.title,
      contentRevision: value.contentRevision as number,
    };
  }
  if (
    value.state === 'ready' &&
    (value.kind === 'url' || value.kind === 'text') &&
    typeof value.value === 'string'
  ) {
    return {
      ok: true,
      state: 'ready',
      resourceId,
      intentSalt,
      title: value.title,
      contentRevision: value.contentRevision as number,
      kind: value.kind,
      value: value.value,
    };
  }
  throw new Error('store_content_invalid');
}

function paymentStatusForPhase(
  phase: HostedStorePurchasePhase,
): HostedStorePaymentStatus {
  if (
    phase === 'provisioning' ||
    phase === 'ready' ||
    phase === 'needs-support'
  ) {
    return 'confirmed';
  }
  if (phase === 'submitting' || phase === 'indeterminate') return 'unknown';
  if (phase === 'indeterminate-exhausted') return 'unknown';
  if (phase === 'failed-prebroadcast' || phase === 'error') {
    return 'not-executed';
  }
  return 'not-started';
}

function accessStatusForPhase(
  phase: HostedStorePurchasePhase,
): HostedStoreAccessStatus {
  if (phase === 'ready') return 'ready';
  if (phase === 'needs-support') return 'needs-support';
  if (phase === 'indeterminate-exhausted') return 'needs-support';
  if (
    phase === 'submitting' ||
    phase === 'indeterminate' ||
    phase === 'provisioning'
  ) {
    return 'provisioning';
  }
  return 'none';
}

export function useHostedStorePurchase({
  resourceId,
  title,
  merchant,
  priceJpyc,
  sessionAddress,
  rail = 'jpyc',
  enabled = true,
}: UseHostedStorePurchaseInput) {
  const queryClient = useQueryClient();
  const { address, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [phase, setPhase] =
    useState<HostedStorePurchasePhase>('idle');
  const [quote, setQuote] =
    useState<HostedStorePurchaseQuote | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [content, setContent] =
    useState<HostedPurchasedContent | null>(null);
  const [needsSupportReason, setNeedsSupportReason] =
    useState<HostedStoreNeedsSupportReason | null>(null);

  const signedRequestRef = useRef<SignedHostedRequest | null>(null);
  const currentAddressRef = useRef<Address | undefined>(address);
  const currentSessionRef = useRef<Address | null>(sessionAddress);
  const confirmedAtRef = useRef<number | null>(null);
  const indeterminateAtRef = useRef<number | null>(null);
  const scopeRef = useRef<string | null>(null);
  const productScopeRef = useRef<string | null>(null);
  currentAddressRef.current = address;
  currentSessionRef.current = sessionAddress;

  const clearPurchaseState = useCallback(() => {
    signedRequestRef.current = null;
    confirmedAtRef.current = null;
    indeterminateAtRef.current = null;
    setPhase('idle');
    setQuote(null);
    setError(null);
    setTxHash(null);
    setContent(null);
    setNeedsSupportReason(null);
  }, []);

  // connected wallet または SIWE session が変わったら、旧 wallet の private store data を
  // cache/UI に残さない。初回 mount は current scope の query を消さない。
  useEffect(() => {
    const scope = `${address?.toLowerCase() ?? ''}:${
      sessionAddress?.toLowerCase() ?? ''
    }`;
    if (scopeRef.current === null) {
      scopeRef.current = scope;
      return;
    }
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    queryClient.removeQueries({ queryKey: ['store'] });
    clearPurchaseState();
  }, [address, sessionAddress, queryClient, clearPurchaseState]);

  useEffect(() => {
    const productScope = `${resourceId}:${title}:${merchant.toLowerCase()}:${priceJpyc}:${rail}`;
    if (productScopeRef.current === null) {
      productScopeRef.current = productScope;
      return;
    }
    if (productScopeRef.current === productScope) return;
    productScopeRef.current = productScope;
    clearPurchaseState();
  }, [resourceId, title, merchant, priceJpyc, rail, clearPurchaseState]);

  const prepare = useCallback(async (): Promise<HostedStorePurchaseQuote> => {
    if (!enabled) {
      throw new HostedStorePurchaseError(
        'disabled',
        'Creator Store purchase is disabled',
      );
    }
    if (!address) {
      throw new HostedStorePurchaseError(
        'wallet_not_connected',
        'A connected wallet is required',
      );
    }
    if (!sameAddress(address, sessionAddress)) {
      throw new HostedStorePurchaseError(
        'siwe_required',
        'A matching SIWE session is required',
      );
    }

    signedRequestRef.current = null;
    confirmedAtRef.current = null;
    indeterminateAtRef.current = null;
    setPhase('loading-quote');
    setQuote(null);
    setError(null);
    setTxHash(null);
    setContent(null);
    setNeedsSupportReason(null);

    const url = `/api/paid/hosted/${encodeURIComponent(
      resourceId,
    )}?payer=${encodeURIComponent(address)}${
      rail === 'usdc' ? '&rail=usdc' : ''
    }`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (cause) {
      const next = new HostedStorePurchaseError(
        'quote_http_error',
        'Failed to fetch the hosted purchase quote',
        { cause },
      );
      setError(next);
      setPhase('error');
      throw next;
    }
    if (response.status !== 402) {
      const next = new HostedStorePurchaseError(
        'quote_expected_402',
        `Expected HTTP 402, received ${response.status}`,
      );
      setError(next);
      setPhase('error');
      throw next;
    }

    const raw = await responseJson(response);
    if (raw === null) {
      const next = new HostedStorePurchaseError(
        'quote_invalid_json',
        'Hosted purchase quote is not valid JSON',
      );
      setError(next);
      setPhase('error');
      throw next;
    }

    let validated: HostedStorePurchaseQuote;
    try {
      validated =
        rail === 'usdc'
          ? normalizeHostedUsdcPaymentRequired(raw, {
              selectedRail: 'usdc',
              resourceId,
              title,
              priceJpyc,
              merchant,
              payer: getAddress(address),
            })
          : normalizeHostedPaymentRequired(raw, priceJpyc, merchant);
    } catch (cause) {
      const next =
        cause instanceof HostedPurchaseWireError ||
        cause instanceof HostedUsdcPurchaseWireError
          ? cause
          : new HostedStorePurchaseError(
              'quote_invalid',
              'Hosted purchase quote is invalid',
              { cause },
            );
      setError(next);
      setPhase('error');
      throw next;
    }

    // wallet/session が quote fetch 中に切り替わった場合、旧 payer の quote を review に出さない。
    if (
      !sameAddress(currentAddressRef.current, address) ||
      !sameAddress(currentSessionRef.current, address)
    ) {
      const next = new HostedStorePurchaseError(
        'wallet_changed',
        'Wallet changed while loading the purchase quote',
      );
      setError(next);
      setPhase('error');
      throw next;
    }

    setQuote(validated);
    setPhase('review');
    return validated;
  }, [
    enabled,
    address,
    sessionAddress,
    resourceId,
    title,
    merchant,
    priceJpyc,
    rail,
  ]);

  const markConfirmed = useCallback((settledTxHash?: Hex) => {
    confirmedAtRef.current = Date.now();
    indeterminateAtRef.current = null;
    if (settledTxHash) setTxHash(settledTxHash);
    setError(null);
    setPhase('provisioning');
  }, []);

  const markIndeterminate = useCallback((cause?: unknown) => {
    if (indeterminateAtRef.current === null) {
      indeterminateAtRef.current = Date.now();
    }
    if (cause !== undefined) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
    setPhase('indeterminate');
  }, []);

  const submitSignedRequest = useCallback(
    async (signed: SignedHostedRequest): Promise<void> => {
      setError(null);
      setPhase('submitting');
      let response: Response;
      try {
        response = await fetch(signed.url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'X-PAYMENT': signed.header,
          },
          cache: 'no-store',
          credentials: 'same-origin',
        });
      } catch (cause) {
        if (
          !sameAddress(currentAddressRef.current, signed.payer) ||
          !sameAddress(currentSessionRef.current, signed.payer)
        ) {
          return;
        }
        // header が server に届いた可能性を client だけでは否定できない。新しい署名へ倒さず、
        // 同じ intent の public status polling に収束させる。
        markIndeterminate(cause);
        return;
      }

      const body = await responseJson(response);
      if (
        !sameAddress(currentAddressRef.current, signed.payer) ||
        !sameAddress(currentSessionRef.current, signed.payer)
      ) {
        return;
      }
      if (response.status === 200) {
        if (
          isRecord(body) &&
          body.ok === true &&
          body.state === 'settled' &&
          body.resourceId === resourceId &&
          Number.isSafeInteger(body.contentRevision) &&
          (body.contentRevision as number) > 0 &&
          typeof body.title === 'string' &&
          (body.kind === 'url' || body.kind === 'text') &&
          typeof body.value === 'string' &&
          typeof body.txHash === 'string' &&
          /^0x[0-9a-fA-F]{64}$/.test(body.txHash) &&
          (signed.quote.rail === 'jpyc' ||
            hostedUsdcPaymentSnapshotMatchesQuote(
              body.payment,
              signed.quote,
            ))
        ) {
          markConfirmed(body.txHash as Hex);
          return;
        }
        // 署名送信後の壊れた/proxy 200 を payment success と偽表示しない。
        // coarse status が on-chain/KV の権威ある settled/failed へ収束させる。
        markIndeterminate(new Error('hosted_purchase_invalid_success'));
        return;
      }
      if (
        response.status === 503 &&
        isRecord(body) &&
        body.error === 'purchase_provisioning'
      ) {
        // hosted route のこの code は settle success 後の entitlement finalize/read-back 障害だけ。
        // payment truth は confirmed とし、content API の own read-back に自動収束させる。
        markConfirmed();
        return;
      }
      if (response.status === 202) {
        markIndeterminate();
        return;
      }
      if (
        response.status === 409 &&
        isRecord(body) &&
        body.error === 'purchase_intent_failed'
      ) {
        setError(
          new Error('purchase_intent_failed'),
        );
        setPhase('failed-prebroadcast');
        return;
      }
      if (
        response.status === 402 ||
        (response.status === 404 &&
          isRecord(body) &&
          body.error === 'purchase_intent_not_found') ||
        (response.status === 409 &&
          isRecord(body) &&
          (body.error === 'purchase_intent_expired' ||
            body.error === 'authorization_expired' ||
            body.error === 'authorization_too_late' ||
            body.error === 'content_unavailable'))
      ) {
        // hosted route が verify/CAS/broadcast より前にだけ返す code。期限切れ quote を
        // public status の pending へ送ると永久確認中になるため、未実行へ明示収束させる。
        setError(
          new Error(
            isRecord(body) && typeof body.error === 'string'
              ? body.error
              : 'payment_invalid',
          ),
        );
        setPhase('failed-prebroadcast');
        return;
      }

      // 署名 header の送信後は、予期しない HTTP error だけから broadcast 有無を推測しない。
      // status endpoint が settled / failed_prebroadcast の権威ある coarse state へ収束させる。
      setError(
        new Error(
          isRecord(body) && typeof body.error === 'string'
            ? body.error
            : `hosted_purchase_http_${response.status}`,
        ),
      );
      markIndeterminate();
    },
    [markConfirmed, markIndeterminate, resourceId],
  );

  const purchase = useCallback(async (): Promise<void> => {
    if (phase !== 'review' || quote === null) {
      throw new HostedStorePurchaseError(
        'review_required',
        'A validated purchase review is required before signing',
      );
    }
    if (
      !address ||
      !sameAddress(address, sessionAddress) ||
      !sameAddress(currentAddressRef.current, address) ||
      !sameAddress(currentSessionRef.current, address)
    ) {
      throw new HostedStorePurchaseError(
        'wallet_changed',
        'The connected wallet no longer matches the purchase review',
      );
    }
    if (chainId !== quote.chainId) {
      const next = new HostedStorePurchaseError(
        'wrong_chain',
        `Switch wallet network to chain ${quote.chainId}`,
      );
      setError(next);
      throw next;
    }
    if (!walletClient) {
      const next = new HostedStorePurchaseError(
        'wallet_unavailable',
        'Wallet signer is unavailable',
      );
      setError(next);
      throw next;
    }

    let prepared: PreparedHostedSigning;
    try {
      if (quote.rail === 'usdc') {
        const authorization = createHostedUsdcAuthorization(
          quote,
          getAddress(address),
        );
        prepared = {
          rail: 'usdc',
          quote,
          authorization,
          typedData: buildHostedUsdcPurchaseTypedData(quote, authorization),
        };
      } else {
        const authorization = createHostedPurchaseAuthorization(
          quote,
          getAddress(address),
        );
        prepared = {
          rail: 'jpyc',
          quote,
          authorization,
          typedData: buildHostedPurchaseTypedData(quote, authorization),
        };
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setPhase('error');
      throw cause;
    }
    setError(null);
    setPhase('signing');

    let signature: Hex;
    try {
      if (prepared.rail === 'usdc') {
        signature = (await walletClient.signTypedData({
          account: prepared.authorization.from,
          domain: prepared.typedData.domain,
          types: prepared.typedData.types,
          primaryType: prepared.typedData.primaryType,
          message: prepared.typedData.message,
        })) as Hex;
      } else {
        signature = (await walletClient.signTypedData({
          account: prepared.authorization.from,
          domain: prepared.typedData.domain,
          types: prepared.typedData.types,
          primaryType: prepared.typedData.primaryType,
          message: prepared.typedData.message,
        })) as Hex;
      }
    } catch (cause) {
      const next = new HostedStorePurchaseError(
        'signature_rejected',
        'Hosted purchase signature was not completed',
        { cause },
      );
      setError(next);
      setPhase('review');
      throw next;
    }

    // 署名 modal 中の wallet/session 切替を検出し、旧 wallet の署名を送信しない。
    if (
      !sameAddress(currentAddressRef.current, address) ||
      !sameAddress(currentSessionRef.current, address)
    ) {
      const next = new HostedStorePurchaseError(
        'wallet_changed',
        'Wallet changed before the signed payment was submitted',
      );
      setError(next);
      setPhase('error');
      throw next;
    }

    const header =
      prepared.rail === 'usdc'
        ? encodeHostedUsdcPaymentHeader(
            prepared.quote,
            prepared.authorization,
            signature,
          )
        : encodeHostedPaymentHeader(
            hostedPaymentPayload(
              prepared.quote,
              prepared.authorization,
              signature,
            ),
          );
    const signed: SignedHostedRequest = {
      url: `/api/paid/hosted/${encodeURIComponent(
        resourceId,
      )}?payer=${encodeURIComponent(address)}${
        quote.rail === 'usdc' ? '&rail=usdc' : ''
      }`,
      header,
      intentSalt: quote.intentSalt,
      payer: getAddress(address),
      quote,
    };
    signedRequestRef.current = signed;
    await submitSignedRequest(signed);
  }, [
    phase,
    quote,
    address,
    sessionAddress,
    chainId,
    walletClient,
    resourceId,
    submitSignedRequest,
  ]);

  const retry = useCallback(async (): Promise<void> => {
    const signed = signedRequestRef.current;
    if (!signed) {
      throw new HostedStorePurchaseError(
        'signed_payment_unavailable',
        'There is no signed hosted payment to retry',
      );
    }
    // 新しい authorization/signature は組まず、保持した header をそのまま再送する。
    await submitSignedRequest(signed);
  }, [submitSignedRequest]);

  const shouldPollStatus =
    phase === 'indeterminate' || phase === 'provisioning';
  const statusQuery = useQuery({
    queryKey: [
      'store',
      'purchase-status',
      sessionAddress,
      quote?.rail ?? null,
      quote?.intentSalt ?? null,
    ],
    queryFn: async (): Promise<PurchaseStatusResponse> => {
      if (!quote) throw new Error('purchase_status_missing_intent');
      const response = await fetch(
        `/api/store/purchase/status?intentSalt=${encodeURIComponent(
          quote.intentSalt,
        )}${quote.rail === 'usdc' ? '&rail=usdc' : ''}`,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
        },
      );
      const body = await responseJson(response);
      if (!response.ok) {
        throw new Error(
          isRecord(body) && typeof body.error === 'string'
            ? body.error
            : `purchase_status_http_${response.status}`,
        );
      }
      return purchaseStatusFrom(body);
    },
    enabled: enabled && shouldPollStatus && quote !== null,
    refetchInterval: shouldPollStatus
      ? STATUS_POLL_INTERVAL_MS
      : false,
    retry: false,
  });

  useEffect(() => {
    if (phase !== 'indeterminate') return;
    const startedAt = indeterminateAtRef.current;
    if (startedAt === null) return;
    const remaining = Math.max(
      0,
      PAYMENT_STATUS_RECOVERY_TIMEOUT_MS - (Date.now() - startedAt),
    );
    const timeout = window.setTimeout(() => {
      setNeedsSupportReason('payment-status-timeout');
      setPhase('indeterminate-exhausted');
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [phase]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.state === 'settled') {
      if (phase === 'indeterminate') {
        markConfirmed(statusQuery.data.txHash);
      } else if (phase === 'provisioning') {
        // purchase_provisioning 後も status が finalizer を駆動する。既に始めた
        // own read-back timeout は延長せず、確定した hash だけを補完する。
        setTxHash(statusQuery.data.txHash);
      }
      return;
    }
    if (
      phase === 'indeterminate' &&
      statusQuery.data.state === 'failed'
    ) {
      setError(new Error('purchase_intent_failed'));
      setPhase('failed-prebroadcast');
    }
  }, [phase, statusQuery.data, markConfirmed]);

  const contentQuery = useQuery({
    queryKey: [
      'store',
      'content',
      sessionAddress,
      resourceId,
      'purchase-readback',
      quote?.intentSalt ?? null,
    ],
    queryFn: async (): Promise<ContentReadBack> => {
      if (!quote) throw new Error('store_content_missing_intent');
      const response = await fetch(
        `/api/store/content/${encodeURIComponent(
          resourceId,
        )}?intentSalt=${encodeURIComponent(quote.intentSalt)}`,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
        },
      );
      if (response.status === 404) {
        const confirmedAt = confirmedAtRef.current;
        return confirmedAt !== null &&
          Date.now() - confirmedAt >= OWNERSHIP_READ_BACK_TIMEOUT_MS
          ? { state: 'timed-out' }
          : { state: 'pending' };
      }
      const body = await responseJson(response);
      if (!response.ok) {
        throw new Error(
          isRecord(body) && typeof body.error === 'string'
            ? body.error
            : `store_content_http_${response.status}`,
        );
      }
      return contentReadBackFrom(body, resourceId, quote.intentSalt);
    },
    enabled:
      enabled &&
      phase === 'provisioning' &&
      quote !== null &&
      sameAddress(address, sessionAddress),
    refetchInterval:
      phase === 'provisioning' ? CONTENT_POLL_INTERVAL_MS : false,
    retry: false,
  });

  useEffect(() => {
    if (phase !== 'provisioning' || !contentQuery.data) return;
    if (contentQuery.data.state === 'ready') {
      setContent(contentQuery.data);
      setNeedsSupportReason(null);
      setError(null);
      setPhase('ready');
      void queryClient.invalidateQueries({
        queryKey: ['store', 'library', sessionAddress],
      });
      return;
    }
    if (contentQuery.data.state === 'provided-ended') {
      setContent(null);
      setNeedsSupportReason('provided-ended');
      setError(null);
      setPhase('needs-support');
      return;
    }
    if (contentQuery.data.state === 'timed-out') {
      setContent(null);
      setNeedsSupportReason('ownership-readback-timeout');
      setError(new Error('ownership_readback_timeout'));
      setPhase('needs-support');
    }
  }, [
    phase,
    contentQuery.data,
    queryClient,
    sessionAddress,
  ]);

  const reset = useCallback(() => {
    // broadcast 有無が不明な間に新 quote/signature へ進ませない。解決経路は status と同一header retry。
    if (
      signedRequestRef.current &&
      (phase === 'submitting' ||
        phase === 'indeterminate' ||
        phase === 'indeterminate-exhausted')
    ) {
      return;
    }
    clearPurchaseState();
  }, [phase, clearPurchaseState]);

  const paymentStatus = paymentStatusForPhase(phase);
  const accessStatus = accessStatusForPhase(phase);

  return {
    phase,
    paymentStatus,
    accessStatus,
    quote,
    content,
    txHash,
    needsSupportReason,
    error,
    requiredChainId: quote?.chainId ?? null,
    isWrongChain: quote !== null && chainId !== quote.chainId,
    isBusy:
      phase === 'loading-quote' ||
      phase === 'signing' ||
      phase === 'submitting',
    canRetrySignedPayment:
      signedRequestRef.current !== null &&
      (phase === 'indeterminate' || phase === 'indeterminate-exhausted'),
    prepare,
    purchase,
    retry,
    reset,
  };
}
