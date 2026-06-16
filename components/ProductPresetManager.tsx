'use client';

// 商品プリセットの管理 UI (レジモード内に統合)。状態は親 (RegisterMode) が持つ
// useProductPresets を props で受け取り、単一 store インスタンスを共有する
// (同一タブ内で 2 つ hook を持つと storage event が飛ばず state が乖離するため)。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Field } from './Field';
import type { ProductPreset } from '@/hooks/useProductPresets';
import { TAX_OPTIONS, defaultRateForCategory, type TaxCategory } from '@/lib/tax';
import { TOKEN_SYMBOLS, defaultDeploymentForSymbol, type TokenSymbol } from '@/lib/tokens';

type Props = {
  presets: ProductPreset[];
  addPreset: (input: Omit<ProductPreset, 'id' | 'sortOrder'>) => void;
  updatePreset: (
    id: string,
    patch: Partial<Omit<ProductPreset, 'id' | 'sortOrder'>>,
  ) => void;
  removePreset: (id: string) => void;
  movePreset: (id: string, dir: 'up' | 'down') => void;
};

const EMPTY_DRAFT = {
  name: '',
  unitPrice: '',
  token: 'jpyc' as TokenSymbol,
  taxCategory: 'taxable_10' as TaxCategory,
  image: '',
  category: '',
};

export function ProductPresetManager({
  presets,
  addPreset,
  updatePreset,
  removePreset,
  movePreset,
}: Props) {
  const t = useTranslations('ProductPresetManager');
  const tTax = useTranslations('Tax');
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const canAdd = draft.name.trim().length > 0 && /^\d+(\.\d+)?$/.test(draft.unitPrice);

  function handleAdd() {
    if (!canAdd) return;
    addPreset({
      name: draft.name.trim(),
      unitPrice: draft.unitPrice,
      token: draft.token,
      taxRate: defaultRateForCategory(draft.taxCategory),
      taxCategory: draft.taxCategory,
      memo: null,
      enabled: true,
      image: draft.image.trim() || undefined,
      category: draft.category.trim() || undefined,
    });
    setDraft(EMPTY_DRAFT);
  }

  return (
    <div className="space-y-4">
      {/* 既存プリセット一覧 */}
      {presets.length === 0 ? (
        <p className="text-xs text-slate-500">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {presets.map((p, i) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2"
            >
              <input
                type="text"
                value={p.name}
                aria-label={t('nameLabel')}
                onChange={(e) => updatePreset(p.id, { name: e.target.value })}
                className="min-w-0 flex-[2] rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-brand focus:outline-none"
                maxLength={80}
              />
              <input
                type="text"
                inputMode="decimal"
                value={p.unitPrice}
                aria-label={t('priceLabel')}
                onChange={(e) =>
                  updatePreset(p.id, {
                    unitPrice: e.target.value.replace(/[^\d.]/g, ''),
                  })
                }
                className="w-20 rounded-md border border-slate-200 px-2 py-1 text-right font-mono text-sm focus:border-brand focus:outline-none"
              />
              <span className="text-xs text-slate-400">
                {defaultDeploymentForSymbol(p.token).displaySymbol}
              </span>
              <select
                value={p.taxCategory ?? ''}
                aria-label={t('taxLabel')}
                onChange={(e) => {
                  const v = e.target.value;
                  const cat = v === '' ? null : (v as TaxCategory);
                  updatePreset(p.id, {
                    taxCategory: cat,
                    taxRate: cat ? defaultRateForCategory(cat) : null,
                  });
                }}
                className="rounded-md border border-slate-200 px-1 py-1 text-xs focus:border-brand focus:outline-none"
              >
                <option value="">{tTax('none')}</option>
                {TAX_OPTIONS.map((o) => (
                  <option key={o.category} value={o.category}>
                    {tTax(o.i18nKey)}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => updatePreset(p.id, { enabled: e.target.checked })}
                />
                {t('enabledLabel')}
              </label>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => movePreset(p.id, 'up')}
                  disabled={i === 0}
                  aria-label={t('moveUp')}
                  className="rounded p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => movePreset(p.id, 'down')}
                  disabled={i === presets.length - 1}
                  aria-label={t('moveDown')}
                  className="rounded p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(t('removeConfirm', { name: p.name }))) {
                      removePreset(p.id);
                    }
                  }}
                  aria-label={t('remove')}
                  className="rounded p-1 text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {/* 専用の全幅行へ (商品名欄を潰さない)。画像 (サムネ + URL) を隣接させ、
                  カテゴリーはラベル付きの別グループに分離 (間に挟まず分かりやすく)。 */}
              <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {p.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                  )}
                  <input
                    type="url"
                    value={p.image ?? ''}
                    aria-label={t('imageLabel')}
                    placeholder={t('imagePlaceholder')}
                    onChange={(e) =>
                      updatePreset(p.id, { image: e.target.value.trim() || undefined })
                    }
                    className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs focus:border-brand focus:outline-none"
                  />
                </div>
                <label className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
                  {t('categoryLabel')}
                  <input
                    type="text"
                    value={p.category ?? ''}
                    placeholder={t('categoryPlaceholder')}
                    maxLength={24}
                    onChange={(e) => updatePreset(p.id, { category: e.target.value || undefined })}
                    className="w-28 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:border-brand focus:outline-none"
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 追加フォーム */}
      <div className="rounded-lg border border-dashed border-slate-300 p-3">
        <p className="mb-2 text-xs font-semibold text-slate-600">{t('addTitle')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('nameLabel')}>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder={t('namePlaceholder')}
              className="w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none"
              maxLength={80}
            />
          </Field>
          <Field label={t('priceLabel')}>
            <input
              type="text"
              inputMode="decimal"
              value={draft.unitPrice}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  unitPrice: e.target.value.replace(/[^\d.]/g, ''),
                }))
              }
              placeholder={t('pricePlaceholder')}
              className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-right font-mono text-sm focus:border-brand focus:outline-none"
            />
          </Field>
          <Field label={t('tokenLabel')}>
            <select
              value={draft.token}
              onChange={(e) =>
                setDraft((d) => ({ ...d, token: e.target.value as TokenSymbol }))
              }
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none"
            >
              {TOKEN_SYMBOLS.map((sym) => (
                <option key={sym} value={sym}>
                  {defaultDeploymentForSymbol(sym).displaySymbol}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('taxLabel')}>
            <select
              value={draft.taxCategory}
              onChange={(e) =>
                setDraft((d) => ({ ...d, taxCategory: e.target.value as TaxCategory }))
              }
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none"
            >
              {TAX_OPTIONS.map((o) => (
                <option key={o.category} value={o.category}>
                  {tTax(o.i18nKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('categoryLabel')}>
            <input
              type="text"
              value={draft.category}
              onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
              placeholder={t('categoryPlaceholder')}
              maxLength={24}
              className="w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none"
            />
          </Field>
          <Field label={t('imageLabel')}>
            <input
              type="url"
              value={draft.image}
              onChange={(e) => setDraft((d) => ({ ...d, image: e.target.value }))}
              placeholder={t('imagePlaceholder')}
              className="w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none"
            />
          </Field>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!canAdd}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('addButton')}
          </button>
        </div>
      </div>
    </div>
  );
}
