'use client';

import { useTranslations } from 'next-intl';
import { isAddress } from 'viem';
import { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';

export type LicenseFormFields = {
  payTo: string;
  supply: string;
  transferable: boolean;
  termsPreset: typeof LICENSE_STANDARD_TERMS.version | undefined;
  termsUrl: string;
  termsVersion: string;
};

export function validLicenseForm(fields: LicenseFormFields, price: string): boolean {
  let https = false;
  try { const url = new URL(fields.termsUrl); https = url.protocol === 'https:' && !url.username && !url.password; } catch { /* 入力中の URL は検証エラーとして表示する。 */ }
  return /^[0-9]+$/.test(fields.supply) && Number(fields.supply) >= 1 && Number(fields.supply) <= 10_000 &&
    /^[0-9]+$/.test(price) && Number(price) >= 1_000 && Number(price) <= 1_000_000 &&
    isAddress(fields.payTo) && (fields.termsPreset === LICENSE_STANDARD_TERMS.version ||
      (https && fields.termsUrl.length <= 512 && fields.termsVersion.trim().length > 0 && fields.termsVersion.trim().length <= 128));
}

export function CreatorStoreLicenseFields({ fields, readOnly, onChange }: {
  fields: LicenseFormFields;
  readOnly: boolean;
  onChange: (patch: Partial<LicenseFormFields>) => void;
}) {
  const t = useTranslations('CreatorStoreSeller');
  const inputClass = 'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm read-only:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand';
  return (
    <div className="grid grid-cols-1 gap-4 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 sm:col-span-2 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className="text-sm font-medium text-slate-800">
          {t('licensePayToLabel')}
          <input type="text" required pattern="0x[0-9a-fA-F]{40}" readOnly={readOnly} value={fields.payTo} onChange={(e) => onChange({ payTo: e.target.value })} className={inputClass} />
        </label>
        <p className="mt-1 text-xs leading-relaxed text-slate-700">{t('licensePayToHint')}</p>
      </div>
      <label className="text-sm font-medium text-slate-800">
        {t('licenseSupplyLabel')}
        <input type="number" min={1} max={10_000} step={1} required readOnly={readOnly} value={fields.supply} onChange={(e) => onChange({ supply: e.target.value })} className={inputClass} />
      </label>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">{t('licenseTransferLabel')}</legend>
        <div className="flex flex-wrap gap-4">
          {[false, true].map((value) => (
            <label key={String(value)} className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-800">
              <input type="radio" name="license-transferable" checked={fields.transferable === value} disabled={readOnly} onChange={() => onChange({ transferable: value })} />
              {t(value ? 'licenseTransferYes' : 'licenseTransferNo')}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium text-slate-800">{t('licenseTermsLabel')}</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
          <input type="radio" name="license-terms" checked={fields.termsPreset === LICENSE_STANDARD_TERMS.version} disabled={readOnly} onChange={() => onChange({ termsPreset: LICENSE_STANDARD_TERMS.version })} />
          {t('licenseTermsStandard')}
        </label>
        <a href={LICENSE_STANDARD_TERMS.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-indigo-800 underline underline-offset-2">{t('licenseTermsStandardLink')}</a>
        <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
          <input type="radio" name="license-terms" checked={fields.termsPreset === undefined} disabled={readOnly} onChange={() => onChange({ termsPreset: undefined })} />
          {t('licenseTermsCustom')}
        </label>
      </fieldset>
      {fields.termsPreset === undefined ? <>
        <label className="text-sm font-medium text-slate-800 sm:col-span-2">
          {t('licenseTermsUrlLabel')}
          <input type="url" required pattern="https://.*" maxLength={512} readOnly={readOnly} value={fields.termsUrl} onChange={(e) => onChange({ termsUrl: e.target.value })} className={inputClass} />
        </label>
        <div className="sm:col-span-2">
          <label className="text-sm font-medium text-slate-800">
            {t('licenseTermsVersionLabel')}
            <input type="text" required maxLength={128} readOnly={readOnly} value={fields.termsVersion} onChange={(e) => onChange({ termsVersion: e.target.value })} aria-describedby="license-terms-version-hint" className={inputClass} />
          </label>
          <p id="license-terms-version-hint" className="mt-1 text-xs leading-relaxed text-slate-700">{t('licenseTermsVersionHint')}</p>
        </div>
      </> : null}
      <p className="text-sm leading-relaxed text-slate-700 sm:col-span-2">{t('licenseUsdcNotice')}</p>
      <p className="text-sm leading-relaxed text-slate-700 sm:col-span-2">{t('licenseImmutableNotice')}</p>
    </div>
  );
}
