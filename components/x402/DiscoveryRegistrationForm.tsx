'use client';

// 認証後の出品フォームだけを遅延読み込みする。下書き・mutation は eager な facade で維持する。

import { useTranslations } from 'next-intl';
import { CheckCircle2, ChevronDown } from 'lucide-react';
import { Field } from '@/components/Field';
import { env } from '@/lib/env';
import { shortAddress } from '@/lib/format';
import type { DiscoveryDisplay } from './discoveryDisplay';
import { PaywallSnippet } from './PaywallSnippet';
import type { DiscoveryOwner } from './useDiscoveryOwner';

const RESOURCE_DOCS_URL_MAX = 512;
const RESOURCE_LICENSE_MAX = 60;

export function DiscoveryRegistrationForm({
  owner,
  display,
  maxResourcesPerMerchant,
  address,
}: {
  owner: DiscoveryOwner;
  display: DiscoveryDisplay;
  maxResourcesPerMerchant: number;
  address: string | undefined;
}) {
  const t = useTranslations('Facilitator');
  const {
    form, setForm, editId, created, notice, usdcReminder,
    error, errorSnippet, attested, setAttested, ownedQuery, owned, onCancelEdit, submitMutation,
  } = owner;
  const { copiedKey, copyText } = display;
  const atResourceLimit = owned.length >= maxResourcesPerMerchant;
  const submitting = submitMutation.isPending;

  const inputCls =
    'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15';

  // エラー key → 親切な文言。resource_not_gated は 402 自体が返らない URL、gate_not_openpay は
  // 402 は返るが OpenPay JPYC 方式でない URL、と原因と直し方を分ける。
  const errorMsg =
    error === 'resource_not_gated'
      ? t('errorNotGated')
      : error === 'gate_not_openpay' && errorSnippet
        ? t('errorGateNotOpenPay')
        : error === 'attestation_required'
          ? t('errorAttestationRequired')
          : error === 'too_many_resources'
            ? t('errorTooManyResources', { limit: maxResourcesPerMerchant })
            : error === 'invalid_usdc_price'
              ? t('errorUsdcPrice')
              : error === 'invalid_usdc_pay_to'
                ? t('errorUsdcPayTo')
                : error
                  ? t('errorGeneric', { reason: error })
                  : null;

  const formCategories = ['api', 'data', 'mcp'];
  const legacyCategory = owned.find((resource) => resource.id === editId)?.category;
  if (legacyCategory && !formCategories.includes(legacyCategory)) {
    formCategories.push(legacyCategory);
  }
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          title={address}
          className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-500"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
          {t('signedInAs', { address: shortAddress(address ?? '') })}
        </p>
        {owned.length > 0 && (
          <p
            className={`text-xs font-semibold ${
              atResourceLimit ? 'text-amber-700' : 'text-slate-500'
            }`}
          >
            {owned.length >= maxResourcesPerMerchant * 0.8
              ? t('registrationCount', { count: owned.length, limit: maxResourcesPerMerchant })
              : t('registrationCountShort', { count: owned.length })}
          </p>
        )}
      </div>
      {atResourceLimit && !editId && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          {t('registrationLimitReached')}
        </p>
      )}
      <Field label={t('formUrlLabel')}>
        <input
          className={inputCls}
          placeholder={t('formUrl')}
          value={form.url}
          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
        />
      </Field>
      <Field label={t('formDescriptionLabel')}>
        <input
          className={inputCls}
          placeholder={t('formDescription')}
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('formPriceLabel')}>
          <input
            className={inputCls}
            inputMode="numeric"
            placeholder={t('formPrice')}
            value={form.priceJpyc}
            onChange={(e) => setForm((f) => ({ ...f, priceJpyc: e.target.value }))}
          />
        </Field>
        <Field label={t('formCategoryLabel')}>
          <div className="flex flex-wrap gap-1.5">
            {formCategories.map((category) => (
              <button
                key={category}
                type="button"
                aria-pressed={form.category === category}
                onClick={() => setForm((f) => ({ ...f, category }))}
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  form.category === category
                    ? 'border-brand bg-brand text-white'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-brand'
                }`}
              >
                {category}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <Field label={t('formPayToLabel')}>
        <input
          className={inputCls}
          placeholder={t('formPayTo')}
          value={form.payTo}
          onChange={(e) => setForm((f) => ({ ...f, payTo: e.target.value }))}
        />
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          {t('formPayToHint')}
        </p>
      </Field>
      {/* dual-rail USDC 面 (opt-in)。UI flag OFF でも既存面 (prefill) があれば出す —
          見えない状態で面を消させない。 */}
      {(env.enableX402DualRailUi || form.usdcEnabled) && (
        <div className="rounded-xl border border-sky-200/80 bg-sky-50/50 px-3 py-2.5">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={form.usdcEnabled}
              onChange={(e) =>
                setForm((f) => ({ ...f, usdcEnabled: e.target.checked }))
              }
              className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand/30"
            />
            <span className="text-xs font-semibold text-slate-700">
              {t('formUsdcEnable')}
            </span>
          </label>
          <p className="mt-1.5 pl-6 text-xs leading-relaxed text-slate-500">
            {t('formUsdcHint')}
          </p>
          {form.usdcEnabled && (
            <div className="mt-2.5 space-y-3 border-t border-sky-100 pt-3">
              <Field label={t('formUsdcPriceLabel')}>
                <input
                  className={inputCls}
                  inputMode="decimal"
                  placeholder={t('formUsdcPrice')}
                  value={form.usdcPriceUsd}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, usdcPriceUsd: e.target.value }))
                  }
                />
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                  {t('formUsdcPriceHint')}
                </p>
              </Field>
              <Field label={t('formUsdcPayToLabel')}>
                <input
                  className={inputCls}
                  placeholder={t('formUsdcPayTo')}
                  value={form.usdcPayTo}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, usdcPayTo: e.target.value }))
                  }
                />
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                  {t('formUsdcPayToHint')}
                </p>
              </Field>
              <Field label={t('formUsdcServiceNameLabel')}>
                <input
                  className={inputCls}
                  maxLength={60}
                  placeholder={t('formUsdcServiceName')}
                  value={form.usdcServiceName}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, usdcServiceName: e.target.value }))
                  }
                />
              </Field>
            </div>
          )}
        </div>
      )}
      {/* 任意項目は折りたたみ (既定で閉じる)。編集中か入力済みなら開いた状態で見せる。 */}
      <details
        className="group rounded-xl border border-slate-200/70"
        open={Boolean(editId || form.title || form.trigger || form.docsUrl || form.license)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-semibold text-slate-700">
          {t('formOptionalGroupTitle')}
          <ChevronDown
            className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div className="space-y-3 border-t border-slate-100 px-3 py-3">
          <Field label={t('formTitleLabel')}>
            <input
              className={inputCls}
              placeholder={t('formTitle')}
              maxLength={60}
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {t('formTitleHint')}
            </p>
          </Field>
          <Field label={t('formTriggerLabel')}>
            <input
              className={inputCls}
              placeholder={t('formTrigger')}
              maxLength={200}
              value={form.trigger}
              onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}
            />
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {t('formTriggerHint')}
            </p>
          </Field>
          <Field label={t('formDocsUrlLabel')}>
            <input
              type="url"
              className={inputCls}
              placeholder={t('formDocsUrl')}
              maxLength={RESOURCE_DOCS_URL_MAX}
              value={form.docsUrl}
              onChange={(e) => setForm((f) => ({ ...f, docsUrl: e.target.value }))}
            />
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {t('formDocsUrlHint')}
            </p>
          </Field>
          <Field label={t('formLicenseLabel')}>
            <input
              className={inputCls}
              placeholder={t('formLicense')}
              maxLength={RESOURCE_LICENSE_MAX}
              value={form.license}
              onChange={(e) => setForm((f) => ({ ...f, license: e.target.value }))}
            />
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {t('formLicenseHint')}
            </p>
          </Field>
        </div>
      </details>

      {/* 出品の正当性表明 (新規登録のみ・必須)。サーバ側でも attested を強制する。 */}
      {!editId && (
        <div className="rounded-xl border border-slate-200/70 bg-slate-50/60 px-3 py-2.5">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand/30"
            />
            <span className="text-xs font-medium text-slate-700">
              {t('attestSummary')}
            </span>
          </label>
          <details className="group mt-1.5 pl-6">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
              {t('detailsLabel')}
              <ChevronDown
                className="h-3.5 w-3.5 transition group-open:rotate-180"
                aria-hidden
              />
            </summary>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              {t('listingPolicySummary')}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              {t('attestLabel')}
            </p>
          </details>
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => submitMutation.mutate()}
          disabled={
            submitting ||
            (!editId && (ownedQuery.isPending || atResourceLimit || !attested))
          }
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {submitting
            ? editId
              ? t('updating')
              : t('submitting')
            : editId
              ? t('updateCta')
              : t('submitCta')}
        </button>
        {editId && (
          <button
            type="button"
            onClick={onCancelEdit}
            disabled={submitting}
            className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-400 disabled:opacity-50"
          >
            {t('cancelCta')}
          </button>
        )}
      </div>
      {!editId && !atResourceLimit && !attested && !submitting && (
        <p className="text-[11px] text-slate-500">{t('attestRequired')}</p>
      )}
      {errorMsg &&
        (error === 'gate_not_openpay' && errorSnippet ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm leading-relaxed text-red-700">{errorMsg}</p>
            <PaywallSnippet
              snippet={errorSnippet}
              copyKey="error-snippet"
              copied={copiedKey === 'error-snippet'}
              onCopy={copyText}
              title={t('snippetTitle')}
              copyLabel={t('copy')}
              copiedLabel={t('copied')}
            />
          </div>
        ) : (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMsg}
          </p>
        ))}
      {notice === 'updated' && (
        <div className="space-y-2">
          <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {t('updated')}
          </p>
          {usdcReminder && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              {t('usdcGateReminder')}
            </p>
          )}
        </div>
      )}
      {notice === 'deleted' && (
        <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          {t('deleted')}
        </p>
      )}
      {created && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {t('created')}
          </p>
          {usdcReminder && (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              {t('usdcGateReminder')}
            </p>
          )}
          <PaywallSnippet
            snippet={created.paywallSnippet}
            copyKey="snippet"
            copied={copiedKey === 'snippet'}
            onCopy={copyText}
            title={t('snippetTitle')}
            copyLabel={t('copy')}
            copiedLabel={t('copied')}
          />
        </div>
      )}
    </div>
  );
}
