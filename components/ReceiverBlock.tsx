'use client';

// /create 3 モード共通の「① 受取先」ブロック: 受取ウォレット → 通貨 → チェーン を縦に並べる。
// 状態は持たず props + callback で受ける (QR/レジ=useQrSettings・Tip=useTipSettings から各 mode が渡す)。
// i18n は namespace 非依存 = labels prop (ReceiverWalletChip と同方針・新 namespace を作らない)。
//
// props は mode の discriminated union:
//   mode='editable' (Tip): 受取先=AddressInput + 通貨/チェーン=TokenChooser/ChainChooser で選択可。
//   mode='readonly' (レジ): 受取先=静的バッジ + 通貨/チェーン=継承値バッジ + 「決済QRで変更」リンク。
// readonly は editable 専用の編集 props (onReceiverChange/onTokenChange/availableChains 等) を
// *渡せない* (型エラー)。これにより呼出側がダミー値を渡す必要が無くなる。
//
// 重要: editable の onTokenChange/onChainChange には各 mode の既存 selectToken/selectChain を
// 渡すこと。これらは副作用 (payMode→standard fallback / FX convert クリア / amount truncate /
// chain reset) を保持しており、raw setSettings に置き換えると不変条件が壊れる。

import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { AddressInput } from './AddressInput';
import { ReceiverWalletChip } from './ReceiverWalletChip';
import { TokenChooser } from './TokenChooser';
import { ChainChooser } from './ChainChooser';
import { Field } from './Field';
import { defaultDeploymentForSymbol, type TokenSymbol } from '@/lib/tokens';
import { chainForSlug, type ChainSlug } from '@/lib/chains';
import { shortAddress } from '@/lib/format';

// 0x アドレスは短縮表示、ENS 等はそのまま。空は '—'。
function displayReceiver(receiver: string): string {
  const v = receiver.trim();
  if (!v) return '—';
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? shortAddress(v) : v;
}

type CommonLabels = {
  receiver: string;
  currency: string;
  receiverMatchesWallet: string;
};

type CommonProps = {
  receiver: string;
  token: TokenSymbol;
  chain: ChainSlug;
};

type EditableProps = CommonProps & {
  mode: 'editable';
  labels: CommonLabels & {
    chain: string;
    useConnectedWallet: string;
    /** 受取先が不正 (0x/ENS いずれでもない) のときの注意文。 */
    addressInvalid?: string;
  };
  onReceiverChange: (v: string) => void;
  onResolved: (addr: Address | null) => void;
  showAddressInvalid: boolean;
  wallet: { canUse: boolean; matches: boolean; onUse: () => void };
  availableChains: readonly ChainSlug[];
  onTokenChange: (t: TokenSymbol) => void;
  onChainChange: (c: ChainSlug) => void;
  chainGridClassName?: string;
};

type ReadonlyProps = CommonProps & {
  mode: 'readonly';
  labels: CommonLabels & {
    /** 「決済QRで変更」リンク文言 (onEditCurrency とセット)。 */
    changeLink?: string;
    /** 継承元を示す控えめな注記。 */
    inheritedNote?: string;
  };
  wallet: { matches: boolean };
  onEditCurrency?: () => void;
  /** 通貨/チェーンバッジの下に差し込む決済設定サマリ (payMode/gasMode 等)。 */
  advancedSummary?: ReactNode;
};

export type ReceiverBlockProps = EditableProps | ReadonlyProps;

export function ReceiverBlock(props: ReceiverBlockProps) {
  const { receiver, token, chain, labels } = props;
  return (
    <div className="space-y-4">
      {props.mode === 'readonly' ? (
        <Field label={labels.receiver}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-mono text-sm text-slate-700">
              {displayReceiver(receiver)}
            </span>
            {props.wallet.matches && (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                {labels.receiverMatchesWallet}
              </span>
            )}
          </div>
        </Field>
      ) : (
        <Field label={labels.receiver}>
          <AddressInput
            value={receiver}
            onChange={props.onReceiverChange}
            onResolved={props.onResolved}
          />
          <ReceiverWalletChip
            canUse={props.wallet.canUse}
            matches={props.wallet.matches}
            onUse={props.wallet.onUse}
            useLabel={props.labels.useConnectedWallet}
            matchLabel={labels.receiverMatchesWallet}
          />
          {props.showAddressInvalid && props.labels.addressInvalid && (
            <p className="mt-1 text-xs text-red-600">{props.labels.addressInvalid}</p>
          )}
        </Field>
      )}

      {props.mode === 'editable' ? (
        <>
          <Field label={labels.currency}>
            <TokenChooser selected={token} onSelect={props.onTokenChange} />
          </Field>
          <Field label={props.labels.chain}>
            <ChainChooser
              slugs={props.availableChains}
              selected={chain}
              onSelect={props.onChainChange}
              gridClassName={props.chainGridClassName}
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
            {props.onEditCurrency && props.labels.changeLink && (
              <button
                type="button"
                onClick={props.onEditCurrency}
                className="text-xs font-medium text-brand hover:underline"
              >
                {props.labels.changeLink}
              </button>
            )}
          </div>
          {props.advancedSummary && <div className="mt-2">{props.advancedSummary}</div>}
          {props.labels.inheritedNote && (
            <p className="mt-1 text-[11px] text-slate-500">
              {props.labels.inheritedNote}
            </p>
          )}
        </Field>
      )}
    </div>
  );
}
