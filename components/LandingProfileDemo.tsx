'use client';

// トップ「販売する」章の自己表現デモ: @handle プロフィールのテーマ (6 種) と色を選ぶと、見本のページがその場で変わる
// (plans/lp-polish-2026-09.md P3)。色の組み立ては公開プロフィールと同じ lib/handleTheme の純関数を使い、
// 本物と同じ見た目を出す (KV もネットワークも使わない)。文言は server から props で受け取る (namespace を増やさない)。
// スマホでは縦に長い塊になっていたので (トップで一番長い部分・2026-10-26 user「進めて」)、テーマと色の選択肢を
// それぞれ横にスクロールする 1 行にし、見本のカードを横長にする。PC は今の形のまま変えない。
// 見本の下の入口の行 (「出品をはじめる」「販売ガイド」) もここで描く (plans/lp-polish-2026-11.md P6): テーマか色を一度でも
// 選んだ人だけ、「出品をはじめる」の行き先に選んだテーマと色を付け、作成画面 (プロフのタブ) をその見た目で始める。
// 触っていない人の行き先は今までどおり (作成画面は既定の見た目で始まる)。文言と行き先の土台は server から props で受け取る。

import { useState } from 'react';
import Link from 'next/link';
import {
  HANDLE_THEMES,
  HANDLE_THEME_NAMES,
  handlePageTheme,
  handleViewTheme,
  type HandleTheme,
} from '@/lib/handleTheme';
import { LANDING_ACTION_ROW, LANDING_CARD, LANDING_PRIMARY, LANDING_SECONDARY } from '@/components/LandingControls';
import {
  LANDING_ACCENTS as ACCENTS,
  LANDING_ACCENT_KEYS as ACCENT_KEYS,
  withLandingLook,
  type LandingAccentKey as AccentKey,
} from '@/lib/landingProfilePreset';

export type LandingProfileDemoCopy = {
  title: string;
  hint: string;
  themeLabel: string;
  colorLabel: string;
  colorNames: Record<AccentKey, string>;
  sample: { tag: string; initial: string; name: string; handle: string; bio: string; featured: string; link: string };
};

/** 見本の下の入口の行。sellHref は作成画面 (プロフのタブ) への行き先の土台。 */
export type LandingProfileDemoCta = { sellHref: string; sellLabel: string; guideHref: string; guideLabel: string };

// clean の通常リンクは公開ページでも class だけで描く (トークン無し)。見本では同じ見た目を inline で近似する。
const CLEAN_LINK = { backgroundColor: '#ffffff', color: '#1e293b', boxShadow: '0 1px 3px rgba(15,23,42,0.12)' };

// 選択肢の行: スマホは横にスクロールする 1 行 (枠の余白 p-4 ぶん外へ広げて端まで流す・スクロールバーは出さない)、
// sm 以上は折り返す。中のボタンは押せるので、スクロールする領域もキーボードで届く。
// fieldset は既定で中身の幅より縮まない (min-inline-size: min-content) ので、使う側で min-w-0 を付ける
// (付けないと横に流した行の幅でページが横にはみ出す)。
// スマホは右端の 2.5rem を薄くして「横に続く」ことを見せる (スクロールバーを出していないので、ほかに手がかりが無い)。
// 右の余白を同じ 2.5rem にしてあるので、最後まで送ると最後の選択肢は薄い所の手前で止まる。
// 行の中の選択肢に focus がある間は薄くしない (focus-within): 横送りの途中でキーボードの focus が右端の選択肢に来ると、
// 薄い所に文字と focus の輪が入って、どこに focus があるかが見えにくくなる。
const CHOICE_ROW =
  '-mx-4 mt-2 flex gap-2 overflow-x-auto pb-1 pl-4 pr-10 [mask-image:linear-gradient(to_right,#000_calc(100%_-_2.5rem),transparent)] [scrollbar-width:none] focus-within:[mask-image:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden';

export function LandingProfileDemo({ c, cta }: { c: LandingProfileDemoCopy; cta: LandingProfileDemoCta }) {
  const [theme, setTheme] = useState<HandleTheme>('gradient');
  const [accentKey, setAccentKey] = useState<AccentKey>('blue');
  // テーマか色を一度でも選んだか。選んだ後に既定 (Gradient × 青) へ戻しても、選んだ値として持って行く。
  const [touched, setTouched] = useState(false);
  const pickTheme = (value: HandleTheme) => {
    setTheme(value);
    setTouched(true);
  };
  const pickAccent = (key: AccentKey) => {
    setAccentKey(key);
    setTouched(true);
  };
  const accent = ACCENTS[accentKey];
  const view = handleViewTheme(accent, theme);
  const page = handlePageTheme(accent, theme);
  // 選択肢の高さ: スマホ (sm 未満) は押せる高さ 40px・sm 以上は今までの 36px。
  const chip = (active: boolean) =>
    `inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:min-h-9 ${
      active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
    }`;

  return (
    <>
      {/* 外枠はカードの型 (中の見本の枠は公開ページの形のまま)。 */}
      <div className={`mx-auto mt-8 grid max-w-4xl grid-cols-1 items-center gap-5 p-4 sm:grid-cols-[minmax(0,1fr)_16rem] sm:gap-8 sm:p-8 ${LANDING_CARD}`}>
        <div className="min-w-0">
          {/* 題は文節で折り、行の長さをそろえる (320px 幅で「…あなたらしいペー / ジに」と 2 字だけ次の行に落ちていた)。 */}
          <h3 className="text-balance text-lg font-bold text-slate-900 [word-break:auto-phrase] sm:text-xl">{c.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">{c.hint}</p>
          {/* 選択肢は見えている名前 (テーマ名・色名) をそのまま名前にする (掟 8)。 */}
          <fieldset className="mt-4 min-w-0">
            <legend className="text-xs font-semibold text-slate-500">{c.themeLabel}</legend>
            <div className={CHOICE_ROW}>
              {HANDLE_THEMES.map((value) => (
                <button key={value} type="button" aria-pressed={theme === value} className={chip(theme === value)} onClick={() => pickTheme(value)}>
                  {HANDLE_THEME_NAMES[value]}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-3 min-w-0 sm:mt-4">
            <legend className="text-xs font-semibold text-slate-500">{c.colorLabel}</legend>
            <div className={CHOICE_ROW}>
              {ACCENT_KEYS.map((key) => (
                <button key={key} type="button" aria-pressed={accentKey === key} className={chip(accentKey === key)} onClick={() => pickAccent(key)}>
                  <span aria-hidden className="h-3 w-3 rounded-full ring-1 ring-white/60" style={{ backgroundColor: ACCENTS[key] }} />
                  {c.colorNames[key]}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {/* 見本 (装飾): 読み上げは左の説明と選択肢で足りるので隠す。 */}
        {/* スマホは横長のカード (アイコンの右に名前・ボタンは 2 つ横並び)、sm 以上は公開ページと同じ縦のカード。 */}
        <div
          aria-hidden
          className="relative mx-auto w-full overflow-hidden rounded-[1.75rem] ring-1 ring-slate-200 sm:max-w-[16rem]"
          style={{ background: page.full ? page.background : '#ffffff' }}
        >
          {page.full ? null : <div className="absolute inset-x-0 top-0 h-40" style={{ background: page.background }} />}
          {/* 実在のお店に見えないよう、見本であることをカードの上に出す。 */}
          <span className={`absolute left-3 top-3 rounded-full px-2 py-0.5 text-[10px] font-bold ${page.dark ? 'bg-white/15 text-white' : 'bg-slate-900/80 text-white'}`}>
            {c.sample.tag}
          </span>
          <div className="relative px-4 pb-4 pt-9 sm:px-5 sm:pb-6 sm:pt-8">
            <div className="flex items-center gap-3 text-left sm:flex-col sm:gap-0 sm:text-center">
              <span
                className="grid h-14 w-14 shrink-0 place-items-center rounded-full text-xl font-bold text-white sm:h-16 sm:w-16 sm:text-2xl"
                style={{ backgroundColor: accent, boxShadow: view.avatarRing }}
              >
                {c.sample.initial}
              </span>
              <div className="min-w-0 sm:mt-4">
                <p className="text-base font-bold sm:text-lg" style={{ color: view.inkColor ?? '#0f172a' }}>{c.sample.name}</p>
                <p className="text-xs font-semibold" style={{ color: view.handleColor }}>{c.sample.handle}</p>
                <p className="mt-1 text-xs leading-relaxed sm:mt-2" style={{ color: view.bioColor ?? '#475569' }}>{c.sample.bio}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:mt-4 sm:grid-cols-1">
              <span className="block rounded-xl px-3 py-2 text-sm font-semibold sm:py-2.5" style={view.featuredStyle}>
                {c.sample.featured}
              </span>
              <span className="block rounded-xl px-3 py-2 text-sm font-semibold sm:py-2.5" style={view.linkStyle ?? CLEAN_LINK}>
                {c.sample.link}
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className={`mt-6 ${LANDING_ACTION_ROW}`}>
        <Link href={touched ? withLandingLook(cta.sellHref, theme, accentKey) : cta.sellHref} prefetch={false} className={LANDING_PRIMARY.brand}>
          {cta.sellLabel}
        </Link>
        <Link href={cta.guideHref} prefetch={false} className={LANDING_SECONDARY.brand}>
          {cta.guideLabel}
        </Link>
      </div>
    </>
  );
}
