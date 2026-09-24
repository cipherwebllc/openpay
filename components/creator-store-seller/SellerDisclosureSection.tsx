'use client';

// 販売者情報 (購入者向け開示) の表示部品。下書き・保存済み表示・保存 mutation は親
// (SignedInSellerPanel) が持ち、ここは描画と入力の中継だけを行う — wallet 切替時に親が
// sessionAddress を key に remount して入力値ごと破棄する境界の内側に留めるため、state を持たせない。

import { useTranslations } from 'next-intl';
import { errorCode, errorDetailKey } from './request';
import { inputClass, type MutationView, type SellerDisclosure, type SellerForm } from './shared';

type Props = {
  seller: SellerDisclosure | null;
  sellerForm: SellerForm;
  sellerSaved: boolean;
  isLicense: boolean;
  updateSeller: (patch: Partial<SellerForm>) => void;
  saveSeller: MutationView<SellerForm>;
};

export function SellerDisclosureSection({ seller, sellerForm, sellerSaved, isLicense, updateSeller, saveSeller }: Props) {
  const t = useTranslations('CreatorStoreSeller');
  const sellerComplete = seller !== null;
  const SellerDisclosure = sellerComplete ? 'details' : 'div';

  return (
    <section
      aria-labelledby="creator-store-seller-disclosure-heading"
      className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5"
    >
      <SellerDisclosure>
        {sellerComplete ? (
          <>
            <summary className="cursor-pointer text-base font-semibold text-slate-800">
              <span id="creator-store-seller-disclosure-heading">{t('sellerHeading')}</span>{' '}
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                {t('sellerRegistered')}
              </span>{' '}
              <span className="text-sm font-normal text-slate-600">{seller.name}</span>
            </summary>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {t('sellerIntro')}
            </p>
          </>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3
                id="creator-store-seller-disclosure-heading"
                className="text-base font-semibold text-slate-800"
              >
                {t('sellerHeading')}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                {t('sellerIntro')}
              </p>
            </div>
            <span className="rounded-full px-2.5 py-1 text-xs font-semibold bg-amber-100 text-amber-800">
              {t('sellerUnregistered')}
            </span>
          </div>
        )}

        <form
          className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveSeller.mutate(sellerForm);
          }}
        >
          <label
            htmlFor="creator-store-seller-name"
            className="block text-sm font-medium text-slate-700"
          >
            {t('sellerNameLabel')}
            <input
              id="creator-store-seller-name"
              type="text"
              required
              maxLength={60}
              value={sellerForm.name}
              onChange={(event) => updateSeller({ name: event.target.value })}
              className={inputClass}
            />
          </label>
          <label
            htmlFor="creator-store-seller-contact"
            className="block text-sm font-medium text-slate-700"
          >
            {t('sellerContactLabel')}
            <input
              id="creator-store-seller-contact"
              type="text"
              required
              maxLength={200}
              value={sellerForm.contact}
              onChange={(event) =>
                updateSeller({ contact: event.target.value })
              }
              className={inputClass}
            />
          </label>
          <div className="sm:col-span-2">
            <label
              htmlFor="creator-store-seller-disclosure"
              className="block text-sm font-medium text-slate-700"
            >
              {t('sellerDisclosureLabel')}
            </label>
            <textarea
              id="creator-store-seller-disclosure"
              aria-describedby="creator-store-seller-disclosure-hint"
              rows={4}
              maxLength={1000}
              value={sellerForm.disclosure}
              onChange={(event) =>
                updateSeller({ disclosure: event.target.value })
              }
              className={inputClass}
            />
            <p
              id="creator-store-seller-disclosure-hint"
              className="mt-1 text-xs leading-relaxed text-slate-500"
            >
              {t('sellerDisclosureHint')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button
              type="submit"
              disabled={saveSeller.isPending}
              className={`${isLicense ? 'min-h-11 ' : ''}rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {saveSeller.isPending ? t('saving') : t('saveSeller')}
            </button>
            {sellerSaved ? (
              <p className="text-sm font-medium text-emerald-700">
                {t('sellerSaved')}
              </p>
            ) : null}
            {saveSeller.isError ? (
              <p className="text-sm text-red-600">
                {(() => {
                  const detailKey = errorDetailKey(saveSeller.error);
                  return detailKey
                    ? t(detailKey)
                    : t('requestError', {
                        error: errorCode(saveSeller.error),
                      });
                })()}
              </p>
            ) : null}
          </div>
        </form>
      </SellerDisclosure>
    </section>
  );
}
