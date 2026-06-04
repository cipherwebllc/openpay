'use client';

// /create 3 モード共通の「① 受取先」ブロック: 受取ウォレット → 通貨 → チェーン を縦に並べる。
// 状態は持たず props + callback で受ける (QR/レジ=useQrSettings・Tip=useTipSettings から各 mode が渡す)。
// i18n は namespace 非依存 = labels prop (ReceiverWalletChip と同方針・新 namespace を作らない)。
//
// 通貨/チェーンは 2 表示モード:
//   editable (QR/Tip): TokenChooser + ChainChooser で選択可。
//   readonly (レジ):    継承値をバッジ表示 + 「決済QRで変更」リンク (継承を隠さない)。
//
// 重要: onTokenChange/onChainChange には各 mode の既存 selectToken/selectChain を渡すこと。
// これらは副作用 (payMode→standard fallback / FX convert クリア / amount truncate / chain reset)
// を保持しており、raw setSettings に置き換えると不変条件が壊れる。

import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { AddressInput } from './AddressInput';
import { ReceiverWalletChip } from './ReceiverWalletChip';
import { TokenChooser } from './TokenChooser';
import { ChainChooser } from './ChainChooser';
import { Field } from './Field';
import { defaultDeploymentForSymbol, type TokenSymbol } from '@/lib/tokens';
import { chainForSlug, type ChainSlug } from '@/lib/chains';

export type ReceiverBlockLabels = {
  receiver: string;
  currency: string;
  chain: string;
  useConnectedWallet: string;
  receiverMatchesWallet: string;
  /** 受取先が不正 (0x/ENS いずれでもない) のときの注意文。 */
  addressInvalid?: string;
  /** readonly モード: 継承元を示す控えめな注記。 */
  inheritedNote?: string;
  /** readonly モード: 「決済QRで変更」リンク文言 (onEditCurrency とセット)。 */
  changeLink?: string;
};

export function ReceiverBlock({
  receiver,
  onReceiverChange,
  onResolved,
  showAddressInvalid,
  receiverExtra,
  wallet,
  token,
  chain,
  availableChains,
  onTokenChange,
  onChainChange,
  currencyMode,
  onEditCurrency,
  chainGridClassName,
  labels,
}: {
  receiver: string;
  onReceiverChange: (v: string) => void;
  onResolved: (addr: Address | null) => void;
  showAddressInvalid: boolean;
  /** 受取先 Field 内 (アドレス直下) に差し込む任意の追加要素 (例: QR の Explorer リンク)。 */
  receiverExtra?: ReactNode;
  wallet: { canUse: boolean; matches: boolean; onUse: () => void };
  token: TokenSymbol;
  chain: ChainSlug;
  availableChains: readonly ChainSlug[];
  onTokenChange: (t: TokenSymbol) => void;
  onChainChange: (c: ChainSlug) => void;
  currencyMode: 'editable' | 'readonly';
  onEditCurrency?: () => void;
  chainGridClassName?: string;
  labels: ReceiverBlockLabels;
}) {
  return (
    <div className="space-y-4">
      <Field label={labels.receiver}>
        <AddressInput
          value={receiver}
          onChange={onReceiverChange}
          onResolved={onResolved}
        />
        <ReceiverWalletChip
          canUse={wallet.canUse}
          matches={wallet.matches}
          onUse={wallet.onUse}
          useLabel={labels.useConnectedWallet}
          matchLabel={labels.receiverMatchesWallet}
        />
        {showAddressInvalid && labels.addressInvalid && (
          <p className="mt-1 text-xs text-red-600">{labels.addressInvalid}</p>
        )}
        {receiverExtra}
      </Field>

      {currencyMode === 'editable' ? (
        <>
          <Field label={labels.currency}>
            <TokenChooser selected={token} onSelect={onTokenChange} />
          </Field>
          <Field label={labels.chain}>
            <ChainChooser
              slugs={availableChains}
              selected={chain}
              onSelect={onChainChange}
              gridClassName={chainGridClassName}
            />
          </Field>
        </>
      ) : (
        <Field label={labels.currency}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm font-medium text-slate-700">
              {defaultDeploymentForSymbol(token).displaySymbol}
              <span className="text-slate-300" aria-hidden>
                ·
              </span>
              {chainForSlug(chain).name}
            </span>
            {onEditCurrency && labels.changeLink && (
              <button
                type="button"
                onClick={onEditCurrency}
                className="text-xs font-medium text-brand hover:underline"
              >
                {labels.changeLink}
              </button>
            )}
          </div>
          {labels.inheritedNote && (
            <p className="mt-1 text-[11px] text-slate-400">{labels.inheritedNote}</p>
          )}
        </Field>
      )}
    </div>
  );
}
