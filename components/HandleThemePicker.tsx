'use client';

import {
  HANDLE_THEMES,
  HANDLE_THEME_NAMES,
  handlePreviewBackground,
  handleViewTheme,
  type HandleTheme,
} from '@/lib/handleTheme';

export function HandleThemePicker({
  accent,
  selected,
  onSelect,
  label,
  hint,
}: {
  accent: string;
  selected: HandleTheme;
  onSelect(theme: HandleTheme): void;
  label: string;
  hint: string;
}) {
  return (
    <div>
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {HANDLE_THEMES.map((theme) => {
          const active = selected === theme;
          const swatchBg =
            handlePreviewBackground(accent, theme) ?? '#f8fafc';
          const chip = handleViewTheme(accent, theme).linkStyle ?? {
            backgroundColor: '#ffffff',
            boxShadow: '0 1px 3px rgba(15,23,42,0.12)',
          };
          return (
            <button
              key={theme}
              type="button"
              onClick={() => onSelect(theme)}
              aria-pressed={active}
              data-theme-option={theme}
              className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 transition ${
                active
                  ? 'border-brand ring-2 ring-brand/40'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <span
                className="flex h-9 w-full items-center justify-center rounded-md"
                style={{ background: swatchBg }}
                aria-hidden
              >
                <span
                  className="h-2.5 w-3/4 rounded-full"
                  style={{
                    backgroundColor: chip.backgroundColor,
                    boxShadow: chip.boxShadow,
                    outline: chip.outline,
                  }}
                />
              </span>
              <span
                className={`text-xs font-medium ${
                  active ? 'text-brand' : 'text-slate-600'
                }`}
              >
                {HANDLE_THEME_NAMES[theme]}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}
