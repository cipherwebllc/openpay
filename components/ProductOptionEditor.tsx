'use client';

// 商品プリセットのオプション (サイズ/トッピング) 編集 UI。ProductPresetManager の各行内に
// 折りたたみで配置。controlled: options を受け取り onChange で全体を返す (親が updatePreset)。
// flag NEXT_PUBLIC_ENABLE_MENU_OPTIONS は親 (ProductPresetManager) がマウントをゲートする。

import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { randomId } from '@/lib/id';
import {
  OPTION_GROUPS_MAX,
  OPTION_CHOICES_MAX,
  OPTION_NAME_MAX,
  type OptionGroup,
} from '@/lib/menuOptions';

export function ProductOptionEditor({
  options,
  onChange,
}: {
  options?: OptionGroup[];
  onChange: (next: OptionGroup[] | undefined) => void;
}) {
  const t = useTranslations('MenuOptions');
  const groups = options ?? [];
  // 空になったら undefined を返す (round-trip 最小化・「オプション無し」へ戻す)。
  const emit = (next: OptionGroup[]) => onChange(next.length > 0 ? next : undefined);

  const addGroup = () => {
    if (groups.length >= OPTION_GROUPS_MAX) return;
    emit([
      ...groups,
      { id: randomId(), name: '', type: 'single', choices: [{ id: randomId(), label: '', priceDelta: '0' }] },
    ]);
  };
  const removeGroup = (gid: string) => emit(groups.filter((g) => g.id !== gid));
  const patchGroup = (gid: string, patch: Partial<OptionGroup>) =>
    emit(groups.map((g) => (g.id === gid ? { ...g, ...patch } : g)));
  const addChoice = (gid: string) =>
    emit(
      groups.map((g) =>
        g.id === gid && g.choices.length < OPTION_CHOICES_MAX
          ? { ...g, choices: [...g.choices, { id: randomId(), label: '', priceDelta: '0' }] }
          : g,
      ),
    );
  const removeChoice = (gid: string, cid: string) =>
    emit(
      groups.map((g) =>
        g.id === gid ? { ...g, choices: g.choices.filter((c) => c.id !== cid) } : g,
      ),
    );
  const patchChoice = (
    gid: string,
    cid: string,
    patch: Partial<{ label: string; priceDelta: string }>,
  ) =>
    emit(
      groups.map((g) =>
        g.id === gid
          ? { ...g, choices: g.choices.map((c) => (c.id === cid ? { ...c, ...patch } : c)) }
          : g,
      ),
    );

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.id} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={g.name}
              maxLength={OPTION_NAME_MAX}
              placeholder={t('groupNamePlaceholder')}
              aria-label={t('groupNameLabel')}
              onChange={(e) => patchGroup(g.id, { name: e.target.value })}
              className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-brand focus:outline-none"
            />
            <select
              value={g.type}
              aria-label={t('typeLabel')}
              onChange={(e) => patchGroup(g.id, { type: e.target.value === 'multi' ? 'multi' : 'single' })}
              className="rounded-md border border-slate-200 px-1 py-1 text-xs focus:border-brand focus:outline-none"
            >
              <option value="single">{t('typeSingle')}</option>
              <option value="multi">{t('typeMulti')}</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={g.required ?? false}
                onChange={(e) => patchGroup(g.id, { required: e.target.checked || undefined })}
              />
              {t('required')}
            </label>
            <button
              type="button"
              onClick={() => removeGroup(g.id)}
              aria-label={t('removeGroup')}
              className="ml-auto rounded p-1 text-slate-400 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {g.choices.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <input
                  type="text"
                  value={c.label}
                  maxLength={OPTION_NAME_MAX}
                  placeholder={t('choiceLabelPlaceholder')}
                  aria-label={t('choiceLabelLabel')}
                  onChange={(e) => patchChoice(g.id, c.id, { label: e.target.value })}
                  className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-brand focus:outline-none"
                />
                <span className="text-xs text-slate-400">+</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={c.priceDelta}
                  aria-label={t('priceDeltaLabel')}
                  placeholder="0"
                  onChange={(e) =>
                    patchChoice(g.id, c.id, { priceDelta: e.target.value.replace(/[^\d.]/g, '') })
                  }
                  className="w-20 rounded-md border border-slate-200 px-2 py-1 text-right font-mono text-sm focus:border-brand focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeChoice(g.id, c.id)}
                  aria-label={t('removeChoice')}
                  className="rounded p-1 text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          {g.choices.length < OPTION_CHOICES_MAX && (
            <button
              type="button"
              onClick={() => addChoice(g.id)}
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              <Plus className="h-3 w-3" aria-hidden />
              {t('addChoice')}
            </button>
          )}
        </div>
      ))}
      {groups.length < OPTION_GROUPS_MAX && (
        <button
          type="button"
          onClick={addGroup}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand-dark"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t('addGroup')}
        </button>
      )}
    </div>
  );
}
