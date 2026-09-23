'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { getAddress } from 'viem';
import { useSiweSession } from '@/hooks/useSiweSession';
import type { AgentPageContent } from '@/lib/agentPage';
import type { PurchaseItem } from '@/lib/agent/purchases';
import { trackAgentEvent } from '@/lib/agentTrack';
import { parseAgentProof } from '@/lib/agent/proofEnvelope';
import { normalizeAgentAddress } from '@/lib/agent/purchaseAddress';
import { txExplorerUrl } from '@/lib/chains';
import { env } from '@/lib/env';
import { chainIdFromCaip2 } from '@/lib/x402/network';

type Props = { address: string; locale: string; c: AgentPageContent['purchases']; isConnected: boolean };
type Purchases = { ok: true; since: string; items: PurchaseItem[]; truncated: boolean; boundAt: string };
type Result = Purchases | { ok: false; reason: 'not_bound' | 'not_signed_in' | 'feature_disabled' };
class PurchaseError extends Error {
  constructor(readonly reason: string) { super('agent_purchases_failed'); }
}

async function failure(response: Response, unbinding = false): Promise<PurchaseError> {
  if (response.status === 404 && !unbinding) return new PurchaseError('feature_disabled');
  try {
    const body = await response.json();
    if (response.status === 404 && body.reason !== 'not_bound') return new PurchaseError('feature_disabled');
    return new PurchaseError(typeof body.reason === 'string' ? body.reason : 'storage_error');
  } catch {
    // CDN 等の非 JSON 応答をパネル内の固定エラーに閉じ、ウォレット全体へ波及させない。
    return new PurchaseError(response.status === 404 ? 'feature_disabled' : 'storage_error');
  }
}

async function post(path: string, body: object) {
  const response = await fetch(`/api/agent/proof/${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response, path === 'unbind');
}

export function AgentPurchases(props: Props) {
  if (!env.enableAgentPurchases) return null;
  return <PurchasesForAddress {...props} address={props.address.toLowerCase()} />;
}

function PurchasesForAddress(props: Props) {
  const session = useSiweSession();
  const [mounted, setMounted] = useState(false);
  const [proof, setProof] = useState<string | null>(null);
  const [proofLinkAddress, setProofLinkAddress] = useState<string | null>(null);
  const [hashError, setHashError] = useState(false);
  useEffect(() => {
    const incoming = new URLSearchParams(window.location.hash.slice(1)).get('proof');
    if (incoming !== null) {
      try {
        // proof は URL・履歴に残さず、この mount のメモリだけに保持する。
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
        setProof(incoming);
        setProofLinkAddress(normalizeAgentAddress(new URLSearchParams(window.location.search).get('address')));
      } catch {
        // history API が拒否された場合、秘密を URL に残したまま検証を進めない。
        setHashError(true);
      }
    }
    setMounted(true);
  }, []);

  return (
    <section className="mt-6 min-w-0 max-w-full break-words border-t border-slate-200 pt-5">
      <h3 className="text-lg font-bold text-slate-900">{props.c.title}</h3>
      {!mounted || session.isLoading || hashError ? <p role="status" className="mt-3 text-sm text-slate-600">{hashError ? props.c.error : props.c.loading}</p> : (
        // Agent と持ち主の切替で操作・表示状態は破棄するが、未送信の proof はカードのアドレス確認後も保持する。
        <PurchasesForOwner key={`${props.address}:${session.sessionAddress?.toLowerCase() ?? 'anonymous'}`} {...props} session={session} proof={proof} proofLinkAddress={proofLinkAddress} consumeProof={() => setProof(null)} />
      )}
    </section>
  );
}

function PurchasesForOwner({ address, locale, c, isConnected, session, proof, proofLinkAddress, consumeProof }: Props & {
  session: ReturnType<typeof useSiweSession>; proof: string | null; proofLinkAddress: string | null; consumeProof: () => void;
}) {
  const t = useTranslations('Nav');
  const qc = useQueryClient();
  const [authRequired, setAuthRequired] = useState(false);
  const [signInFailed, setSignInFailed] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const submitted = useRef(false);
  const viewed = useRef(false);
  const owner = session.sessionAddress?.toLowerCase();
  const parsedProof = useMemo(() => parseAgentProof(proof), [proof]);
  const proofMismatch = !!parsedProof && parsedProof.address !== address;
  const proofLinkMismatch = !!parsedProof && !!proofLinkAddress && parsedProof.address !== proofLinkAddress;
  const needsConfirmation = proof !== null && !!parsedProof && !!owner && (!session.isSignedIn || proofMismatch || proofLinkMismatch);
  const instance = useId();
  const queryKey = ['agent-purchases', address, owner, instance] as const;
  const [verification, setVerification] = useState<{ status: 'idle' | 'pending' | 'success' | 'error'; error?: Error; address?: string }>({ status: 'idle' });
  const verify = {
    isPending: verification.status === 'pending', isError: verification.status === 'error',
    isSuccess: verification.status === 'success', error: verification.error,
    reset: () => setVerification({ status: 'idle' }),
  };
  useEffect(() => {
    if (verification.error instanceof PurchaseError && verification.error.reason === 'binding_limit') setBindingsOpen(true);
  }, [verification.error]);
  const submitProof = useCallback(() => {
    if (proof === null || !parsedProof || !owner || submitted.current) return;
    submitted.current = true;
    // 1 回限りの proof は再試行しない。StrictMode や持ち主の切替で二重送信しない。
    consumeProof();
    setVerification({ status: 'pending' });
    void post('verify', { proof }).then(() => {
      setVerification({ status: 'success', address: parsedProof.address });
      trackAgentEvent('agent_proof_bound', { locale });
      void qc.invalidateQueries({ queryKey: ['agent-purchases', parsedProof.address, owner] });
      void qc.invalidateQueries({ queryKey: ['agent-bindings', owner] });
    }, (error: Error) => {
      setVerification({ status: 'error', error });
      if (error instanceof PurchaseError && error.reason === 'not_signed_in') setAuthRequired(true);
    });
  }, [proof, parsedProof, owner, consumeProof, locale, qc]);
  useEffect(() => {
    if (proof === null) return;
    if (!parsedProof) {
      // 不正な envelope を確認表示や自動紐づけに流さず、既存の履歴表示は継続する。
      consumeProof();
      setVerification({ status: 'error', error: new PurchaseError('malformed') });
    } else if (session.isSignedIn && !proofMismatch && !proofLinkMismatch) {
      // cookie だけの持ち主や別 Agent のリンクが、無確認の紐づけへ波及しないようにする。
      submitProof();
    }
  }, [proof, parsedProof, consumeProof, session.isSignedIn, proofMismatch, proofLinkMismatch, submitProof]);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<Result> => {
      const response = await fetch(`/api/agent/purchases?address=${encodeURIComponent(address)}`, { credentials: 'same-origin', cache: 'no-store', signal });
      if (!response.ok) {
        const error = await failure(response);
        if (response.status === 401 && (error.reason === 'not_bound' || error.reason === 'not_signed_in')) return { ok: false, reason: error.reason };
        if (response.status === 404) return { ok: false, reason: 'feature_disabled' };
        throw error;
      }
      const body = await response.json() as Purchases;
      if (body.ok !== true || !Array.isArray(body.items)) throw new PurchaseError('storage_error');
      return body;
    },
    // 検証に失敗しても、既に紐づいている一覧は隠さない (期限切れリンクを開いた持ち主が一覧を失わない)。
    enabled: !!owner && !authRequired && proof === null && !verify.isPending,
    staleTime: 30_000, refetchOnWindowFocus: false, retry: false,
    // mount ごとの key と gcTime で、再ログイン直後にも古い認可の履歴を再表示しない。
    gcTime: 0, refetchOnMount: 'always',
  });
  const unbind = useMutation({
    mutationFn: () => post('unbind', { address }),
    retry: false,
    onSuccess: async () => {
      await qc.cancelQueries({ queryKey });
      qc.setQueryData<Result>(queryKey, { ok: false, reason: 'not_bound' });
      setConfirmUnbind(false);
      verify.reset();
      await qc.invalidateQueries({ queryKey: ['agent-bindings', owner] });
    },
    onError: async (error) => {
      if (!(error instanceof PurchaseError)) return;
      if (error.reason === 'not_signed_in') setAuthRequired(true);
      if (error.reason === 'not_bound' || error.reason === 'feature_disabled') {
        await qc.cancelQueries({ queryKey });
        qc.setQueryData<Result>(queryKey, { ok: false, reason: error.reason });
        setConfirmUnbind(false);
        verify.reset();
        await qc.invalidateQueries({ queryKey: ['agent-bindings', owner] });
      }
    },
  });
  const signedOut = !owner || authRequired || (query.data?.ok === false && query.data.reason === 'not_signed_in');
  const result = !signedOut && !query.isError && proof === null && !verify.isPending && query.data?.ok === true ? query.data : undefined;
  useEffect(() => {
    if (!result || viewed.current) return;
    viewed.current = true;
    trackAgentEvent('agent_purchases_view', { locale });
  }, [result, locale]);

  async function signIn() {
    setSignInFailed(false);
    trackAgentEvent('agent_purchases_signin', { locale });
    try {
      await session.signIn(t('siweStatement'));
      setAuthRequired(false);
      verify.reset();
      unbind.reset();
      await qc.resetQueries({ queryKey });
    } catch {
      // 署名の拒否を unhandled rejection にせず、このログイン操作だけの失敗として表示する。
      setSignInFailed(true);
    }
  }
  function proofFailure(error: Error) {
    if (!(error instanceof PurchaseError)) return c.error;
    return Object.hasOwn(c.failures, error.reason) ? c.failures[error.reason as keyof typeof c.failures] : c.failures.storage_error;
  }
  const notBound = !signedOut && query.data?.ok === false && query.data.reason === 'not_bound';
  const unbindError = unbind.error instanceof PurchaseError && ['not_bound', 'feature_disabled'].includes(unbind.error.reason) ? null : unbind.error;
  const status = session.isSigningIn ? c.signingIn
    : signedOut ? (signInFailed || session.signInError ? c.signInError : proof !== null ? c.continueAfterSignIn : '')
      : needsConfirmation ? c.bindConfirm.replace('{owner}', getAddress(owner!))
        : verify.isPending || proof !== null ? c.verifying
          : verify.error ? proofFailure(verify.error)
            : unbindError || query.isError ? c.error
              : query.data?.ok === false && query.data.reason === 'feature_disabled' ? c.failures.feature_disabled
                : unbind.isPending || query.isPending ? c.loading
                  : confirmUnbind ? c.unbindConfirm
                    : verify.isSuccess ? (verification.address === address ? c.bound : c.boundOther.replace('{address}', verification.address!)) : result?.items.length === 0 ? c.empty : '';
  const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600';
  const button = `min-h-11 max-w-full rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium text-slate-800 disabled:opacity-50 ${focus}`;
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <>
      {signedOut ? <p className="mt-3 text-sm text-slate-600">{c.lead}</p> : <p className="mt-3 text-xs text-slate-500">{c.signedInAs} <span className="font-mono">{owner!.slice(0, 6)}…{owner!.slice(-4)}</span></p>}
      <p id={`${instance}-status`} role="status" className="mt-3 break-all text-sm text-slate-600">{status}</p>
      {/* 未接続ではサインインの署名ができない (useSiweSession が wallet_not_connected を投げる) → ボタンではなく接続への案内。 */}
      {signedOut ? (isConnected
        ? <button type="button" className={`mt-3 ${button}`} disabled={session.isSigningIn} onClick={() => void signIn()}>{session.isSigningIn ? c.signingIn : c.signIn}</button>
        : <p className="mt-3 text-sm text-slate-600">{c.connectFirst}</p>) : null}
      {needsConfirmation ? <div className="mt-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
        {proofMismatch ? <p className="mb-3 break-all">{c.proofAddressMismatch.replace('{proofAddress}', parsedProof!.address).replace('{cardAddress}', address)}</p> : null}
        {proofLinkMismatch && proofLinkAddress !== address ? <p className="mb-3 break-all">{c.proofLinkAddressMismatch.replace('{proofAddress}', parsedProof!.address).replace('{linkAddress}', proofLinkAddress!)}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={button} aria-describedby={`${instance}-status`} onClick={submitProof}>{c.confirmBind}</button>
          <button type="button" className={button} onClick={consumeProof}>{c.cancelBind}</button>
        </div>
      </div> : null}
      {notBound && !verify.isPending && !verify.isError ? <div className="mt-3 text-sm text-slate-600"><p>{c.notBoundLead}</p><ol className="mt-2 list-decimal space-y-2 pl-5">{c.notBoundSteps.map((step) => <li key={step}>{step}</li>)}</ol></div> : null}
      {result ? (
        <>
          {result.items.length > 0 ? <div className="mt-4 min-w-0 max-w-full overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr>{[c.colDate, c.colItem, c.colAmount].map((label) => <th key={label} scope="col" className="px-2 py-2 font-medium text-slate-500">{label}</th>)}</tr></thead>
              <tbody>{result.items.map((item, index) => {
                const chainId = chainIdFromCaip2(item.network) ?? ({ polygon: 137, 'polygon-amoy': 80002, base: 8453, 'base-sepolia': 84532 } as Record<string, number>)[item.network];
                // 未知の network・tx では推測した explorer へ誘導しない。
                const txUrl = chainId && item.tx ? txExplorerUrl(chainId, item.tx) : undefined;
                return <tr key={`${item.at}:${item.tx}:${index}`} className="border-t border-slate-100 align-top">
                  <td className="px-2 py-3 text-xs text-slate-600"><time dateTime={item.at}>{formatter.format(new Date(item.at))}</time>{txUrl ? <a href={txUrl} target="_blank" rel="noopener noreferrer" className={`mt-2 block underline ${focus}`}>{c.viewTx}</a> : null}</td>
                  <td className="max-w-48 break-words px-2 py-3 [overflow-wrap:anywhere]"><span>{item.resource.path ?? item.resource.pathTag ?? '—'}</span>{item.resource.host && item.resource.host !== 'open-pay.jp' ? <span className="mt-1 block text-xs text-slate-500">{item.resource.host}</span> : null}<span className="mt-2 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{item.resourceOrigin === 'first-party' ? c.originFirstParty : item.resourceOrigin === 'listed' ? c.originListed : c.originClaimed}</span></td>
                  <td className="break-words px-2 py-3 tabular-nums [overflow-wrap:anywhere]">{item.amount} {item.asset}{item.fee !== undefined ? <span className="mt-1 block text-xs text-slate-500">+ {item.fee} {c.feeSuffix}</span> : null}</td>
                </tr>;
              })}</tbody>
            </table>
          </div> : verify.isSuccess ? <p className="mt-3 text-sm text-slate-600">{c.empty}</p> : null}
          {result.truncated ? <p className="mt-3 text-xs text-slate-500">{c.truncated}</p> : null}
          <p className="mt-3 text-xs text-slate-500">{c.sinceNote}</p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">{c.caveat}</p>
          <button type="button" className={`mt-4 ${button}`} disabled={unbind.isPending} aria-describedby={confirmUnbind ? `${instance}-status` : undefined} onKeyDown={(event) => { if (event.key === 'Escape') setConfirmUnbind(false); }} onClick={() => { if (confirmUnbind) unbind.mutate(); else setConfirmUnbind(true); }}>{c.unbind}</button>
        </>
      ) : null}
      {!signedOut && proof === null && !verify.isPending && !(query.data?.ok === false && query.data.reason === 'feature_disabled') ? (
        <details className="mt-4 min-w-0 rounded-xl border border-slate-200 p-4" open={bindingsOpen} onToggle={(event) => setBindingsOpen(event.currentTarget.open)}>
          <summary className={`cursor-pointer text-sm font-medium text-slate-800 ${focus}`}>{c.bindingsTitle}</summary>
          {bindingsOpen ? <BindingsList owner={owner!} locale={locale} c={c} button={button} onAuthRequired={() => setAuthRequired(true)} onUnbound={async (unboundAddress) => {
            if (verify.error instanceof PurchaseError && verify.error.reason === 'binding_limit') verify.reset();
            if (unboundAddress !== address) return;
            await qc.cancelQueries({ queryKey });
            qc.setQueryData<Result>(queryKey, { ok: false, reason: 'not_bound' });
            setConfirmUnbind(false);
            verify.reset();
          }} /> : null}
        </details>
      ) : null}
    </>
  );
}

type Bindings = { addresses: { address: string; boundAt: string }[] };

function BindingsList({ owner, locale, c, button, onAuthRequired, onUnbound }: {
  owner: string; locale: string; c: Props['c']; button: string;
  onAuthRequired: () => void; onUnbound: (address: string) => Promise<void>;
}) {
  const instance = useId();
  const qc = useQueryClient();
  const queryKey = ['agent-bindings', owner, instance] as const;
  const [confirmAddress, setConfirmAddress] = useState<string | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<Bindings> => {
      const response = await fetch('/api/agent/purchases/bindings', { credentials: 'same-origin', cache: 'no-store', signal });
      if (!response.ok) throw await failure(response);
      const body = await response.json() as Bindings;
      if (!Array.isArray(body.addresses)) throw new PurchaseError('storage_error');
      return body;
    },
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false,
  });
  async function removeRow(address: string) {
    await qc.cancelQueries({ queryKey });
    qc.setQueryData<Bindings>(queryKey, (old) => old && ({ addresses: old.addresses.filter((row) => row.address !== address) }));
    setConfirmAddress(null);
    await onUnbound(address);
  }
  const unbind = useMutation({
    mutationFn: (address: string) => post('unbind', { address }),
    retry: false,
    onSuccess: (_data, address) => removeRow(address),
    onError: async (error, address) => {
      if (error instanceof PurchaseError && error.reason === 'not_bound') await removeRow(address);
    },
  });
  const error = unbind.error ?? query.error;
  const reason = error instanceof PurchaseError ? error.reason : undefined;
  useEffect(() => {
    // 期限切れ session の一覧を保持せず、購入履歴と同じ再ログイン導線に戻す。
    if (reason === 'not_signed_in') onAuthRequired();
  }, [reason, onAuthRequired]);
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return <div className="mt-3 min-w-0 text-sm text-slate-600">
    <p role="status">{reason === 'feature_disabled' ? c.failures.feature_disabled
      : error && reason !== 'not_bound' ? c.failures.storage_error
        : query.isPending || unbind.isPending ? c.loading
          : query.data?.addresses.length === 0 ? c.bindingsEmpty : ''}</p>
    {!query.isError && reason !== 'feature_disabled' && query.data ? <ul className="space-y-4">
      {query.data.addresses.map((row) => <li key={row.address} className="min-w-0 border-t border-slate-100 pt-3">
        <p className="break-all font-mono text-xs">{row.address}</p>
        <p className="mt-1 text-xs">{c.bindingDate} <time dateTime={row.boundAt}>{formatter.format(new Date(row.boundAt))}</time></p>
        {confirmAddress === row.address ? <p id={`${instance}-confirm`} className="mt-2 break-all">{c.unbindAddressConfirm.replace('{address}', row.address)}</p> : null}
        <button type="button" className={`mt-2 break-all text-left ${button}`} disabled={unbind.isPending} aria-describedby={confirmAddress === row.address ? `${instance}-confirm` : undefined}
          onKeyDown={(event) => { if (event.key === 'Escape') setConfirmAddress(null); }}
          onClick={() => { if (confirmAddress === row.address) unbind.mutate(row.address); else { unbind.reset(); setConfirmAddress(row.address); } }}>{c.unbindAddress.replace('{address}', row.address)}</button>
      </li>)}
    </ul> : null}
  </div>;
}
