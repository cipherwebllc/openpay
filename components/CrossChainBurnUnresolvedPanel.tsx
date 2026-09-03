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

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Address, Hex } from 'viem';
import { blockExplorerUrl } from '@/lib/chains';

export interface CrossChainBurnUnresolvedPanelProps {
  kind: 'wait' | 'manual';
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
      <div className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
        <p className="font-semibold text-amber-900">{t('burnWaitTitle')}</p>
        <p className="text-xs text-amber-800">{t('burnWaitBody')}</p>
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
    </div>
  );
}
