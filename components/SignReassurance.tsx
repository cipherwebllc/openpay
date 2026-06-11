'use client';

// 「署名安心 UX」(plans/sign-reassurance-ux.md §3) の表示専用コンポーネント。
//
// 役割: 顧客がウォレットの署名画面を見た瞬間の「ドレイナー詐欺では?」という恐怖を、
// 署名要求の前後で「次に何が表示され・それが何を意味し・何を意味しないか」を先回りで
// 説明して除去する。EIP-3009 free mode は構造的に最小権限 (Approve なし・金額固定・
// 受取先固定・5 分失効・1 回限り) で、この恐怖は実態と乖離した「認知の問題」なので
// 説明だけで解消できる (計画 §1)。
//
// スコープは P1 = JPYC relay free mode のみ。standard/USDC/recover は別 kind が必要なため
// 本コンポーネントは出さない (計画 §3.3)。決済ロジックには一切触れない (preview を受けて
// 描画するだけ・isPending を受けて待機表示に切替えるだけ)。
//
// トーン: 断定的安全宣言を避け事実 (構造) の説明に徹する (計画 §3.3/§6・景表法整合)。
// 非技術表現を主・技術表現を従で併記する (計画 §8 Q4)。

import { useTranslations } from 'next-intl';
import { ShieldCheck, Check, Loader2 } from 'lucide-react';
import { shortAddress } from '@/lib/format';
import type { JpycRelaySignPreview } from '@/lib/signPreview';

export function SignReassurance({
  preview,
  awaiting,
}: {
  preview: JpycRelaySignPreview;
  awaiting: boolean;
}) {
  const t = useTranslations('SignReassurance');
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
