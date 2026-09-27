'use client';

// トップ「販売する」章の自己表現デモ: @handle プロフィールのテーマ (6 種) と色を選ぶと、見本のページがその場で変わる
// (plans/lp-polish-2026-09.md P3)。色の組み立ては公開プロフィールと同じ lib/handleTheme の純関数を使い、
// 本物と同じ見た目を出す (KV もネットワークも使わない)。文言は server から props で受け取る (namespace を増やさない)。

import { useState } from 'react';
import {
  HANDLE_THEMES,
  HANDLE_THEME_NAMES,
  handlePageTheme,
  handleViewTheme,
  type HandleTheme,
} from '@/lib/handleTheme';

const ACCENTS = {
  blue: '#2563eb',
  green: '#059669',
  rose: '#e11d48',
  amber: '#d97706',
  violet: '#7c3aed',
} as const;
type AccentKey = keyof typeof ACCENTS;
const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

export type LandingProfileDemoCopy = {
  title: string;
  hint: string;
  themeLabel: string;
  colorLabel: string;
  colorNames: Record<AccentKey, string>;
  sample: { initial: string; name: string; handle: string; bio: string; featured: string; link: string };
};

// clean の通常リンクは公開ページでも class だけで描く (トークン無し)。見本では同じ見た目を inline で近似する。
const CLEAN_LINK = { backgroundColor: '#ffffff', color: '#1e293b', boxShadow: '0 1px 3px rgba(15,23,42,0.12)' };

export function LandingProfileDemo({ c }: { c: LandingProfileDemoCopy }) {
  const [theme, setTheme] = useState<HandleTheme>('gradient');
  const [accentKey, setAccentKey] = useState<AccentKey>('blue');
  const accent = ACCENTS[accentKey];
  const view = handleViewTheme(accent, theme);
  const page = handlePageTheme(accent, theme);
  const chip = (active: boolean) =>
    `inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
      active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
    }`;

  return (
    <div className="mx-auto mt-8 grid max-w-4xl grid-cols-1 items-center gap-6 rounded-3xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:grid-cols-[minmax(0,1fr)_16rem] sm:gap-8 sm:p-8">
      <div className="min-w-0">
        <h3 className="text-lg font-bold text-slate-900 sm:text-xl">{c.title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{c.hint}</p>
        {/* 選択肢は見えている名前 (テーマ名・色名) をそのまま名前にする (掟 8)。 */}
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-slate-500">{c.themeLabel}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {HANDLE_THEMES.map((value) => (
              <button key={value} type="button" aria-pressed={theme === value} className={chip(theme === value)} onClick={() => setTheme(value)}>
                {HANDLE_THEME_NAMES[value]}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-slate-500">{c.colorLabel}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {ACCENT_KEYS.map((key) => (
              <button key={key} type="button" aria-pressed={accentKey === key} className={chip(accentKey === key)} onClick={() => setAccentKey(key)}>
                <span aria-hidden className="h-3 w-3 rounded-full ring-1 ring-white/60" style={{ backgroundColor: ACCENTS[key] }} />
                {c.colorNames[key]}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {/* 見本 (装飾): 読み上げは左の説明と選択肢で足りるので隠す。 */}
      <div
        aria-hidden
        className="relative mx-auto w-full max-w-[16rem] overflow-hidden rounded-[1.75rem] ring-1 ring-slate-200"
        style={{ background: page.full ? page.background : '#ffffff' }}
      >
        {page.full ? null : <div className="absolute inset-x-0 top-0 h-40" style={{ background: page.background }} />}
        <div className="relative flex flex-col items-center px-5 pb-6 pt-8 text-center">
          <span
            className="grid h-16 w-16 place-items-center rounded-full text-2xl font-bold text-white"
            style={{ backgroundColor: accent, boxShadow: view.avatarRing }}
          >
            {c.sample.initial}
          </span>
          <p className="mt-4 text-lg font-bold" style={{ color: view.inkColor ?? '#0f172a' }}>{c.sample.name}</p>
          <p className="text-xs font-semibold" style={{ color: view.handleColor }}>{c.sample.handle}</p>
          <p className="mt-2 text-xs leading-relaxed" style={{ color: view.bioColor ?? '#475569' }}>{c.sample.bio}</p>
          <span className="mt-4 block w-full rounded-xl px-3 py-2.5 text-sm font-semibold" style={view.featuredStyle}>
            {c.sample.featured}
          </span>
          <span className="mt-2 block w-full rounded-xl px-3 py-2.5 text-sm font-semibold" style={view.linkStyle ?? CLEAN_LINK}>
            {c.sample.link}
          </span>
        </div>
      </div>
    </div>
  );
}
