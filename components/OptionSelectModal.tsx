'use client';

// オプション (サイズ/トッピング) 選択モーダル。MobileOrderView (顧客) と RegisterMode (店員) が共用。
// single=ラジオ (既定で先頭を選択) / multi=チェックボックス。required グループ未選択は確定不可。
// 確定すると選択 choice 配列 + 識別用 selections を親へ返す (親が実効単価 + 名前サフィックスを組む)。

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  effectiveUnitPrice,
  resolveSelection,
  type OptionChoice,
  type OptionGroup,
  type OptionSelection,
} from '@/lib/menuOptions';

// single グループは既定で先頭 choice を選択 (サイズは常に 1 つ選ぶ UX)。multi は空。
function initialSelection(groups: OptionGroup[]): OptionSelection {
  const sel: OptionSelection = {};
  for (const g of groups) {
    if (g.type === 'single') sel[g.id] = g.choices[0]?.id ?? '';
    else sel[g.id] = [];
  }
  return sel;
}

export function OptionSelectModal({
  open,
  itemName,
  basePrice,
  options,
  symbol,
  onConfirm,
  onClose,
}: {
  open: boolean;
  itemName: string;
  basePrice: string;
  options: OptionGroup[];
  symbol: string;
  onConfirm: (
    choices: OptionChoice[],
    selections: { groupId: string; choiceId: string }[],
  ) => void;
  onClose: () => void;
}) {
  const t = useTranslations('MenuOptions');
  const [sel, setSel] = useState<OptionSelection>(() => initialSelection(options));
  const [missing, setMissing] = useState<string | null>(null);

  // 開くたび / 商品が変わるたびに選択をリセット。
  useEffect(() => {
    if (open) {
      setSel(initialSelection(options));
      setMissing(null);
    }
  }, [open, options]);

  const resolved = useMemo(() => resolveSelection(options, sel), [options, sel]);
  const priceText = resolved.ok ? effectiveUnitPrice(basePrice, resolved.choices) : basePrice;

  if (!open) return null;

  const toggleMulti = (gid: string, cid: string) => {
    setMissing(null);
    setSel((s) => {
      const cur = Array.isArray(s[gid]) ? (s[gid] as string[]) : [];
      return {
        ...s,
        [gid]: cur.includes(cid) ? cur.filter((x) => x !== cid) : [...cur, cid],
      };
    });
  };
  const pickSingle = (gid: string, cid: string) => {
    setMissing(null);
    setSel((s) => ({ ...s, [gid]: cid }));
  };

  const confirm = () => {
    const r = resolveSelection(options, sel);
    if (!r.ok) {
      setMissing(r.missingGroupId);
      return;
    }
    onConfirm(r.choices, r.selections);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={itemName}
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-slate-900">{itemName}</h2>
        <div className="mt-3 space-y-4">
          {options.map((g) => (
            <fieldset key={g.id}>
              <legend className="text-sm font-semibold text-slate-700">
                {g.name}
                {g.required && <span className="ml-1 text-xs text-red-500">{t('required')}</span>}
                {missing === g.id && (
                  <span className="ml-2 text-xs text-red-600">{t('requiredError')}</span>
                )}
              </legend>
              <div className="mt-1 space-y-1">
                {g.choices.map((c) => {
                  const checked =
                    g.type === 'single'
                      ? sel[g.id] === c.id
                      : Array.isArray(sel[g.id]) && (sel[g.id] as string[]).includes(c.id);
                  const delta = Number(c.priceDelta) > 0 ? ` +${c.priceDelta} ${symbol}` : '';
                  return (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 has-[:checked]:border-brand has-[:checked]:bg-brand/5"
                    >
                      <input
                        type={g.type === 'single' ? 'radio' : 'checkbox'}
                        name={`opt-${g.id}`}
                        checked={checked}
                        onChange={() =>
                          g.type === 'single' ? pickSingle(g.id, c.id) : toggleMulti(g.id, c.id)
                        }
                      />
                      <span className="flex-1">{c.label}</span>
                      {delta && <span className="text-xs text-slate-500">{delta}</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-sm font-bold text-slate-900">
            {priceText} {symbol}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={confirm}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
            >
              {t('addToCart')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
