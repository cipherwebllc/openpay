'use client';

// 「署名安心 UX」(plans/sign-reassurance-ux.md §3) の表示専用コンポーネント。
//
// 役割: 顧客がウォレットの署名画面を見た瞬間の「ドレイナー詐欺では?」という恐怖を、
// 署名要求の前後で「次に何が表示され・それが何を意味し・何を意味しないか」を先回りで
// 説明して除去する。EIP-3009 free mode は構造的に最小権限 (Approve なし・金額固定・
// 受取先固定・5 分失効・1 回限り) で、この恐怖は実態と乖離した「認知の問題」なので
// 説明だけで解消できる (計画 §1)。
//
// kind 別の出し分け (計画 §3.3 経路別コピーマトリクス・誠実性の要):
//   jpyc-relay-free   : 上記 5 点フルパネル (最強コピー・P1 不変)。
//   jpyc-relay-recover: recover (forwarder) 経路 (P4)。to=forwarder (決済コントラクト) で free
//                       と説明が異なる。customer モードではウォレットが「表示額 + 手数料」を出す
//                       ため (例 1000 円決済 → ウォレットは 1002 JPYC)、照合表で内訳を必ず説明し
//                       「お店の言う額とウォレットの額が違う」恐怖を除去する (P4 の核)。
//   usdc-permit       : Circle Paymaster 経路。EIP-2612 permit (Spending cap) を求めるので
//                       「Approve は求めません」とは書けない。有界 permit (この決済額+ガス
//                       上限のみ・無制限ではない) を正直に説明する (計画 §3.3 の誠実性が本質)。
//   standard/native   : 通常の送金確認。説明過剰にしない 1 行ヒントのみ (計画 §3.3)。
//
// 決済ロジックには一切触れない (preview/値を受けて描画するだけ・awaiting を受けて待機表示に
// 切替えるだけ)。トーン: 断定的安全宣言を避け事実 (構造) の説明に徹する (計画 §3.3/§6・
// 景表法整合)。非技術表現を主・技術表現を従で併記する (計画 §8 Q4)。

import { useTranslations } from 'next-intl';
import { ShieldCheck, Check, Loader2 } from 'lucide-react';
import { shortAddress } from '@/lib/format';
import type {
  JpycRelaySignPreview,
  JpycRecoverSignPreview,
} from '@/lib/signPreview';

export type SignReassuranceProps =
  // P1 の JPYC relay free フルパネル (照合表込み・不変)。
  | { kind: 'jpyc-relay-free'; preview: JpycRelaySignPreview; awaiting: boolean }
  // P4 の JPYC relay recover フルパネル。to=forwarder で customer モードは「表示額+手数料」を
  // ウォレットに出す。照合表で内訳を説明し恐怖を除去する。
  | {
      kind: 'jpyc-relay-recover';
      preview: JpycRecoverSignPreview;
      awaiting: boolean;
    }
  // Circle Paymaster (USDC) 経路。permit (Spending cap) を有界として説明する。
  // permitCapHuman は circle quote の permitAmount を formatUnits したもの (取れなければ省略)。
  // transferCount>1 は split (分割受取) を 1 回の permit で行うケース。
  | {
      kind: 'usdc-permit';
      amountHuman: string;
      symbol: string;
      permitCapHuman?: string;
      transferCount?: number;
      awaiting: boolean;
    }
  // 通常送金 (standard / native)。フルパネルでなく 1 行ヒント。awaiting なし。
  | { kind: 'standard' | 'native'; awaiting?: false };

export function SignReassurance(props: SignReassuranceProps) {
  const t = useTranslations('SignReassurance');

  if (props.kind === 'jpyc-relay-free') {
    return <JpycRelayFreePanel preview={props.preview} awaiting={props.awaiting} t={t} />;
  }

  if (props.kind === 'jpyc-relay-recover') {
    return (
      <JpycRelayRecoverPanel preview={props.preview} awaiting={props.awaiting} t={t} />
    );
  }

  if (props.kind === 'usdc-permit') {
    return <UsdcPermitPanel {...props} t={t} />;
  }

  // standard / native: 通常の送金確認なので説明過剰にしない 1 行ヒント (計画 §3.3)。
  // 文言は同一だがキーは分ける (将来分岐用)。
  return (
    <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <ShieldCheck
        className="mt-0.5 h-4 w-4 flex-none text-slate-500"
        aria-hidden
      />
      <span>{t(props.kind === 'native' ? 'nativeHint' : 'standardHint')}</span>
    </p>
  );
}

type Translate = ReturnType<typeof useTranslations<'SignReassurance'>>;

// Circle Paymaster (USDC) の有界 permit パネル。emerald 同系だがバッジ文言を変える
// (Approve なしとは書かない・有界 permit を正直に説明する)。照合表は P2 では出さない
// (permit の生フィールドは P4 検討・虚偽や不正確を出さないため・計画 §3.3)。
function UsdcPermitPanel({
  amountHuman,
  symbol,
  permitCapHuman,
  transferCount,
  awaiting,
  t,
}: {
  amountHuman: string;
  symbol: string;
  permitCapHuman?: string;
  transferCount?: number;
  awaiting: boolean;
  t: Translate;
}) {
  // 署名「中」: ウォレットアプリへ画面が切り替わるモバイルでも文脈を見失わないよう、
  // 通常パネルと置換して大きく待機表示を出す (計画 §3.2)。
  if (awaiting) {
    return (
      <div
        className="rounded-2xl border-2 border-brand bg-brand/5 p-5"
        role="status"
        aria-live="polite"
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-brand-dark">
          <Loader2 className="h-4 w-4 flex-none animate-spin" aria-hidden />
          {permitCapHuman
            ? t('permitAwaitingTitleCapped', { cap: permitCapHuman, symbol })
            : t('permitAwaitingTitle')}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
      <p className="flex items-start gap-2 text-sm font-semibold text-emerald-900">
        <ShieldCheck
          className="mt-0.5 h-5 w-5 flex-none text-emerald-600"
          aria-hidden
        />
        <span>{t('permitHeadline')}</span>
      </p>

      <ul className="mt-3 space-y-2 text-sm text-emerald-900">
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>
            {permitCapHuman
              ? t('permitBadgeCapCapped', { cap: permitCapHuman, symbol })
              : t('permitBadgeCap')}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>
            {transferCount !== undefined && transferCount > 1
              ? t('permitBadgeRecipientSplit', { count: transferCount })
              : t('permitBadgeRecipient')}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>{t('permitBadgeScope', { amount: amountHuman, symbol })}</span>
        </li>
      </ul>

      {/* Blockaid 暫定注記は jpyc-relay-free と共通文言を再利用 (計画指定)。 */}
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {t('blockaidNote')}
      </p>
    </div>
  );
}

// P1 の JPYC relay free フルパネル + 署名待ちオーバーレイ。挙動は P1 から不変。
function JpycRelayFreePanel({
  preview,
  awaiting,
  t,
}: {
  preview: JpycRelaySignPreview;
  awaiting: boolean;
  t: Translate;
}) {
  const { amountHuman, symbol, amountAtomic, to, storeName, expiresInMin, decimals } =
    preview;

  // 署名「中」: ウォレットアプリへ画面が切り替わるモバイルでも文脈を見失わないよう、
  // 通常パネルと置換して大きく待機表示を出す (計画 §3.2)。
  if (awaiting) {
    return (
      <div
        className="rounded-2xl border-2 border-brand bg-brand/5 p-5"
        role="status"
        aria-live="polite"
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-brand-dark">
          <Loader2 className="h-4 w-4 flex-none animate-spin" aria-hidden />
          {t('awaitingTitle')}
        </p>
        <dl className="mt-3 space-y-1 text-sm text-slate-700">
          <div className="flex justify-between gap-2">
            <dt className="opacity-70">{t('awaitingAmountLabel')}</dt>
            <dd className="font-semibold">
              {amountHuman} {symbol}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="opacity-70">{t('awaitingToLabel')}</dt>
            <dd className="min-w-0 text-right">
              {storeName ? `${storeName} ` : ''}
              <span className="font-mono text-xs">({shortAddress(to)})</span>
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-slate-600">{t('awaitingNote')}</p>
      </div>
    );
  }

  // 署名「前」: 常設の安心カード。
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
      <p className="flex items-start gap-2 text-sm font-semibold text-emerald-900">
        <ShieldCheck className="mt-0.5 h-5 w-5 flex-none text-emerald-600" aria-hidden />
        <span>{t('headline')}</span>
      </p>

      <ul className="mt-3 space-y-2 text-sm text-emerald-900">
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>{t('badgeApprove')}</span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>{t('badgeAmount', { amount: amountHuman, symbol })}</span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>{t('badgeExpiry', { minutes: expiresInMin })}</span>
        </li>
      </ul>

      {/* Blockaid 暫定注記 (計画 §10-6 の実物準拠文言)。警告が出る環境では UI 文言だけ
          では救えないが、警告内の spender が下記の店アドレスと一致していれば 1 回限りの
          送金だけだと事実を説明する。 */}
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {t('blockaidNote')}
      </p>

      {/* 折りたたみ「ウォレットに表示される内容を確認」(既定閉)。照合表は安心マーケで
          あると同時に本物のセキュリティ教育 (to/value の一致確認を促す) になる。値は
          署名 payload と同一ソース (preview) を出し乖離をゼロにする。 */}
      <details className="group mt-3">
        <summary className="cursor-pointer list-none text-xs font-medium text-emerald-800 underline decoration-dotted underline-offset-2">
          {t('detailsSummary')}
        </summary>
        <div className="mt-2 overflow-hidden rounded-lg border border-emerald-200 bg-white">
          <table className="w-full text-left text-xs">
            <tbody className="divide-y divide-slate-100">
              <tr>
                <th scope="row" className="px-3 py-2 font-medium text-slate-600">
                  {t('rowToField')}
                </th>
                <td className="px-3 py-2 text-slate-500">{t('rowToMeaning')}</td>
                <td className="break-all px-3 py-2 font-mono text-slate-700">
                  {to}
                </td>
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 font-medium text-slate-600">
                  {t('rowValueField')}
                </th>
                <td className="px-3 py-2 text-slate-500">
                  {t('rowValueMeaning', { amount: amountHuman, symbol, decimals })}
                </td>
                <td className="break-all px-3 py-2 font-mono text-slate-700">
                  {amountAtomic}
                </td>
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 font-medium text-slate-600">
                  {t('rowValidBeforeField')}
                </th>
                <td className="px-3 py-2 text-slate-500">
                  {t('rowValidBeforeMeaning', { minutes: expiresInMin })}
                </td>
                <td className="px-3 py-2 text-slate-400">—</td>
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 font-medium text-slate-600">
                  {t('rowNonceField')}
                </th>
                <td className="px-3 py-2 text-slate-500">{t('rowNonceMeaning')}</td>
                <td className="px-3 py-2 text-slate-400">—</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">{t('detailsWalletVariesNote')}</p>
      </details>
    </div>
  );
}

// P4 の JPYC relay recover フルパネル + 署名待ちオーバーレイ。free と同じ emerald カード骨格
// だが、recover では署名先が forwarder (決済コントラクト) で、customer モードはウォレットが
// 「表示額 + 手数料」(= value + fee) を出す。バッジと照合表でこの内訳を説明し、「お店の言う額と
// ウォレットの額が違う」恐怖を除去する (P4 の核)。検証済み主張や explorer リンクは出さない
// (Kaia explorer が未検証のため・汎用文言のみ)。
function JpycRelayRecoverPanel({
  preview,
  awaiting,
  t,
}: {
  preview: JpycRecoverSignPreview;
  awaiting: boolean;
  t: Translate;
}) {
  const {
    amountHuman,
    feeHuman,
    totalHuman,
    totalAtomic,
    forwarder,
    storeName,
    gasMode,
    expiresInMin,
    decimals,
    symbol,
  } = preview;

  // customer モードはウォレットが「表示額 + 手数料」を出す (= totalHuman > amountHuman)。
  // merchant モードはウォレット表示 = 表示価格で free と同じ見え方 (手数料は受取から内枠吸収)。
  const isCustomer = gasMode === 'customer';

  // 署名「中」: ウォレットアプリへ画面が切り替わるモバイルでも文脈を見失わないよう、
  // 通常パネルと置換して大きく待機表示を出す。金額はウォレットに出る生の数字 (totalHuman)
  // を出し、ウォレット表示との突合を成立させる。送金先は店舗名 + 決済コントラクト経由を補足。
  if (awaiting) {
    return (
      <div
        className="rounded-2xl border-2 border-brand bg-brand/5 p-5"
        role="status"
        aria-live="polite"
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-brand-dark">
          <Loader2 className="h-4 w-4 flex-none animate-spin" aria-hidden />
          {t('awaitingTitle')}
        </p>
        <dl className="mt-3 space-y-1 text-sm text-slate-700">
          <div className="flex justify-between gap-2">
            <dt className="opacity-70">{t('awaitingAmountLabel')}</dt>
            <dd className="font-semibold">
              {totalHuman} {symbol}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="opacity-70">{t('awaitingToLabel')}</dt>
            <dd className="min-w-0 text-right">
              {storeName ? `${storeName} ` : ''}
              <span className="text-xs text-slate-500">
                {t('recoverAwaitingToVia')}
              </span>
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-slate-600">{t('awaitingNote')}</p>
      </div>
    );
  }

  // 署名「前」: 常設の安心カード。
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
      <p className="flex items-start gap-2 text-sm font-semibold text-emerald-900">
        <ShieldCheck className="mt-0.5 h-5 w-5 flex-none text-emerald-600" aria-hidden />
        <span>{t('headline')}</span>
      </p>

      <ul className="mt-3 space-y-2 text-sm text-emerald-900">
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>{t('badgeApprove')}</span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>
            {isCustomer
              ? t('recoverBadgeAmountCustomer', {
                  total: totalHuman,
                  amount: amountHuman,
                  fee: feeHuman,
                  symbol,
                })
              : t('recoverBadgeAmountMerchant', { amount: amountHuman, symbol })}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>{t('recoverBadgeRecipient')}</span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600" aria-hidden />
          <span>{t('badgeExpiry', { minutes: expiresInMin })}</span>
        </li>
      </ul>

      {/* 確認ガイダンス (ja+en 中立化済)。金額と受取先がウォレット表示と一致しているか確認を促す。 */}
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {t('blockaidNote')}
      </p>

      {/* 折りたたみ「ウォレットに表示される内容を確認」(既定閉)。recover は value 欄に
          ウォレットに出る生の数字 (totalAtomic) を出し、customer モードでは「表示額 + 手数料」
          の内訳を意味欄で説明する (恐怖除去の核)。to 欄は forwarder (決済コントラクト)。 */}
      <details className="group mt-3">
        <summary className="cursor-pointer list-none text-xs font-medium text-emerald-800 underline decoration-dotted underline-offset-2">
          {t('detailsSummary')}
        </summary>
        <div className="mt-2 overflow-hidden rounded-lg border border-emerald-200 bg-white">
          <table className="w-full text-left text-xs">
            <tbody className="divide-y divide-slate-100">
              <tr>
                <th scope="row" className="px-3 py-2 font-medium text-slate-600">
                  {t('rowToField')}
                </th>
                <td className="px-3 py-2 text-slate-500">
                  {t('recoverRowToMeaning')}
                </td>
                <td className="break-all px-3 py-2 font-mono text-slate-700">
                  {forwarder}
                </td>
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 font-medium text-slate-600">
                  {t('rowValueField')}
                </th>
                <td className="px-3 py-2 text-slate-500">
                  {isCustomer
                    ? t('recoverRowValueMeaningCustomer', {
                        amount: amountHuman,
                        fee: feeHuman,
                        total: totalHuman,
                        symbol,
                      })
                    : t('rowValueMeaning', {
                        amount: amountHuman,
                        symbol,
                        decimals,
                      })}
                </td>
                <td className="break-all px-3 py-2 font-mono text-slate-700">
                  {totalAtomic}
                </td>
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 font-medium text-slate-600">
                  {t('rowValidBeforeField')}
                </th>
                <td className="px-3 py-2 text-slate-500">
                  {t('rowValidBeforeMeaning', { minutes: expiresInMin })}
                </td>
                <td className="px-3 py-2 text-slate-400">—</td>
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 font-medium text-slate-600">
                  {t('rowNonceField')}
                </th>
                <td className="px-3 py-2 text-slate-500">{t('rowNonceMeaning')}</td>
                <td className="px-3 py-2 text-slate-400">—</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">{t('detailsWalletVariesNote')}</p>
      </details>
    </div>
  );
}
