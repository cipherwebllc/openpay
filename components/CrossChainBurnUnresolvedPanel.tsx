'use client';

// A1: cross-chain (CCTP) の再開時に「前回 burn を broadcast したか」を自動判定できなかった
// ときの説明パネル。CrossChainHint から next/dynamic で遅延読込する (/pay・/tip の First Load
// JS 予算に載せないため — この UI は中断からの再開という稀なケースでしか描画されない)。
//
// 2 種類:
//   wait   … mempool に自分の tx が居る等、時間を置けば自動で解決する。ボタンは無効。
//   manual … 自動判定不能。買い手が explorer で **自分の USDC が減っていないこと** を確認し、
//            二段確認 (チェック + ボタン) を通した場合だけ再送金を許可する。
//            「もう一度払う」ことを勧める UI ではないので、文面で明確に「二重に払わない」
//            ことを最優先に伝える。

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { Address, Hex } from 'viem';
import { blockExplorerUrl } from '@/lib/chains';
import type { AdoptBurnTxHashResult } from '@/hooks/useCrossChainPayment';

type AdoptResult = AdoptBurnTxHashResult;

export interface CrossChainBurnUnresolvedPanelProps {
  kind: 'wait' | 'manual';
  /** D4: 買い手が explorer で見つけた burn tx hash を貼って続きから再開する。
   *  検証は on-chain (receipt + DepositForBurn log) で行われ、一致しなければ
   *  reason が返り、state は変わらない。 */
  onAdoptHash?: (hash: string) => Promise<AdoptResult>;
  /** wait パネルの「もう一度確認する」。判定をやり直す (送金はしない)。 */
  onRetry?: () => void;
  /** 送金元 chain (explorer link の解決に使う) */
  sourceChainId: number;
  /** 買い手のアドレス (burn tx が特定できないときの確認先) */
  depositor: Address;
  /** 判っている場合の burn tx hash */
  burnTxHash?: Hex;
  /** 二段確認を通してよい状態か (false = 一致する burn が複数見つかっている等) */
  reburnable: boolean;
  /** 二段確認済み (再 Pay 待ち) */
  armed: boolean;
  onArm: () => void;
}

export function CrossChainBurnUnresolvedPanel(
  props: CrossChainBurnUnresolvedPanelProps,
) {
  const t = useTranslations('CrossChainHint');
  const [checked, setChecked] = useState(false);
  const explorerBase = blockExplorerUrl(props.sourceChainId);
  const explorerHref = explorerBase
    ? props.burnTxHash
      ? `${explorerBase}/tx/${props.burnTxHash}`
      : `${explorerBase}/address/${props.depositor}`
    : undefined;

  if (props.kind === 'wait') {
    return (
      <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
        <p className="font-semibold text-amber-900">{t('burnWaitTitle')}</p>
        <p className="text-xs text-amber-800">{t('burnWaitBody')}</p>
        {/* wait の間は親の Pay ボタンを無効にしているので、再確認の導線はここに置く。
            置かないと「数分おいてからもう一度」と書いてあるのに押す先が無い (D2)。 */}
        {props.onRetry && (
          <button
            type="button"
            onClick={props.onRetry}
            className="w-full rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-900"
          >
            {t('burnWaitRetry')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
      <p className="font-semibold text-amber-900">{t('burnManualTitle')}</p>
      <p className="text-xs text-amber-800">{t('burnManualBody')}</p>
      {explorerHref && (
        <a
          href={explorerHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-xs text-amber-900 underline"
        >
          {t('burnManualCheckExplorer')}
        </a>
      )}
      {props.reburnable ? (
        props.armed ? (
          <p className="text-xs font-semibold text-amber-900">
            {t('burnManualArmedHint')}
          </p>
        ) : (
          <>
            <label className="flex items-start gap-2 text-xs text-amber-900">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>{t('burnManualConfirmLabel')}</span>
            </label>
            <button
              type="button"
              disabled={!checked}
              onClick={props.onArm}
              className="w-full rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-50"
            >
              {t('burnManualReburn')}
            </button>
          </>
        )
      ) : (
        <p className="text-xs text-amber-900">{t('burnManualBlocked')}</p>
      )}
      {props.onAdoptHash && <AdoptHashForm onAdoptHash={props.onAdoptHash} />}
    </div>
  );
}

/** 「USDC は減っている (= burn は着弾した) が hash が判らない」買い手の自己救済入力。
 *  再送金 (二段確認) とは逆向きの出口 — こちらは **送らずに** 続きから進める。 */
function AdoptHashForm({
  onAdoptHash,
}: {
  onAdoptHash: (hash: string) => Promise<AdoptResult>;
}) {
  const t = useTranslations('CrossChainHint');
  const inputId = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdoptErrorKey | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onAdoptHash(value);
      if (!res.ok) setError(adoptErrorKey(res.reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-1 border-t border-amber-200 pt-2">
      <label
        htmlFor={inputId}
        className="block text-xs font-semibold text-amber-900"
      >
        {t('burnAdoptLabel')}
      </label>
      <p className="text-xs text-amber-800">{t('burnAdoptHint')}</p>
      <input
        id={inputId}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0x…"
        className="w-full rounded-lg border border-amber-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-800"
      />
      <button
        type="submit"
        disabled={busy || value.trim() === ''}
        className="w-full rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-50"
      >
        {busy ? t('burnAdoptChecking') : t('burnAdoptSubmit')}
      </button>
      {error && <p className="text-xs text-red-700">{t(error)}</p>}
    </form>
  );
}

type AdoptErrorKey =
  | 'burnAdoptErrorFormat'
  | 'burnAdoptErrorNotFound'
  | 'burnAdoptErrorReverted'
  | 'burnAdoptErrorMismatch'
  | 'burnAdoptErrorUnavailable';

function adoptErrorKey(
  reason: Extract<AdoptResult, { ok: false }>['reason'],
): AdoptErrorKey {
  switch (reason) {
    case 'format':
      return 'burnAdoptErrorFormat';
    case 'notfound':
      return 'burnAdoptErrorNotFound';
    case 'reverted':
      return 'burnAdoptErrorReverted';
    case 'mismatch':
      return 'burnAdoptErrorMismatch';
    case 'unavailable':
      return 'burnAdoptErrorUnavailable';
  }
}
