// スポンサー・広告掲載のご案内 (/sponsors) の部品。page.tsx に規定外の export を作らないため部品に分ける (掟 3)。
// hook / next-intl を使わない同期の server 部品 (jsdom で描画テストできる)。
//
// - 問い合わせのボタンは LINE・Discord・X だけ (新しい外部フォーム・メールアドレスは出さない)。URL は lib/officialLinks.ts の
//   定数 (フッターと同じ値)・rel もフッターと同じ。ボタンの名前は見えている文字 (アイコンは aria-hidden・aria-label なし・掟 8)。
// - 掲載イメージは「サンプル」と明記した枠と文字だけで描く (画像・実在の企業名やロゴは使わない)。バナーの枠の縦横比と
//   協賛企業の枠の数は lib/sponsorPlans.ts の定数から作る (第 2 段の掲載の欄と同じ値)。
// - 第 1 段では掲載の欄・設定ファイル・ランダム表示を作らない (2026-11-18 user 裁定)。
// - 短い行 (料金の期間と社数・入稿仕様・流れ) は、数字と単位を離さず (px・KB の前も)、ja は文節の区切りで折る
//   (phrased: iPhone の Safari でも「…説明の / 文）」のように 1〜2 字だけが次の行に落ちない)。

import type { ReactNode } from 'react';
import { LANDING_PRIMARY, LANDING_SECONDARY } from '@/components/LandingControls';
import { phrased } from '@/components/Phrased';
import { STEP_BADGE } from '@/components/guide/PosGuidePieces';
import { keepNumbersTogether } from '@/lib/guideText';
import { OPENPAY_DISCORD_URL, OPENPAY_LINE_URL, OPENPAY_X_URL } from '@/lib/officialLinks';
import { DISCORD_ICON_PATH, LINE_ICON_PATH, X_ICON_PATH } from '@/lib/socialIconPaths';
import { SPONSOR_BANNER_SPEC, SPONSOR_PLANS } from '@/lib/sponsorPlans';
import type { SponsorsAnnualCard, SponsorsPlanCard, SponsorsSpecItem } from '@/lib/sponsors';

/** 節 (h2 + 本文)。id は固定 (第 2 段の掲載の欄から #plans などで飛べるように・題名を変えても変わらない)。 */
export function SponsorsSection({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-12 sm:mt-14">
      <h2 id={id} className="text-xl font-bold tracking-tight text-slate-900 [word-break:auto-phrase] sm:text-2xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * 数字と単位 (和文の単位・px・KB) の間で折らない (改行しない空白にする)。形式の並び (PNG / JPG / WebP) も 1 つにまとめ、
 * en の区切りの「·」は前の語に付けて、行の頭に「·」や「/」だけが来ないようにする。
 */
function keepUnits(text: string): string {
  return keepNumbersTogether(text)
    .replace(/(?<=\d) (?=(?:px|KB)\b)/g, '\u00a0')
    .replace(/(?<=[A-Za-z]) \/ (?=[A-Za-z])/g, '\u00a0/\u00a0')
    .replace(/ · /g, '\u00a0· ');
}

/** 短い行の文: 数字と単位を離さず、ja は文節の区切りで折る。 */
function shortLine(text: string, locale: string): ReactNode {
  return phrased(keepUnits(text), locale);
}

/** 本文の段落。数字と単位を離さない (keepNumbersTogether)。 */
export function SponsorsParagraph({ children, className }: { children: string; className?: string }) {
  return <p className={`text-sm leading-relaxed text-slate-700 sm:text-base ${className ?? 'mt-3'}`}>{keepNumbersTogether(children)}</p>;
}

function BrandIcon({ path }: { path: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
      <path d={path} />
    </svg>
  );
}

/** Discord (主) と X (従) の問い合わせボタン。スマホは縦に積んで 2 つの幅をそろえる (広い方の中身の幅・全幅にしない)。 */
export function SponsorsContactActions({
  lineLabel,
  discordLabel,
  xLabel,
  className,
}: {
  lineLabel: string;
  discordLabel: string;
  xLabel: string;
  className?: string;
}) {
  return (
    <div className={`flex w-fit max-w-full flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap ${className ?? 'mt-6'}`}>
      {/* LINE を先頭 (主) に置く: 日本の企業・お店の担当者がいちばん使い慣れた窓口 (2026-11-25 user 裁定)。 */}
      <a href={OPENPAY_LINE_URL} target="_blank" rel="noopener noreferrer" className={LANDING_PRIMARY.brand}>
        <BrandIcon path={LINE_ICON_PATH} />
        {lineLabel}
      </a>
      <a href={OPENPAY_DISCORD_URL} target="_blank" rel="noopener noreferrer" className={LANDING_SECONDARY.brand}>
        <BrandIcon path={DISCORD_ICON_PATH} />
        {discordLabel}
      </a>
      <a href={OPENPAY_X_URL} target="_blank" rel="noopener noreferrer" className={LANDING_SECONDARY.brand}>
        <BrandIcon path={X_ICON_PATH} />
        {xLabel}
      </a>
    </div>
  );
}

/** 料金のカード (法人スポンサー・バナー広告)。料金の数字は lib/sponsorPlans.ts の定数から作った文。 */
export function SponsorsPlanCards({ plans, locale }: { plans: readonly SponsorsPlanCard[]; locale: string }) {
  return (
    // base の grid-cols-1 は必須 (スマホで横にはみ出さない)。
    <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
      {plans.map((plan) => (
        <li key={plan.id} className="flex flex-col rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
          <h3 className="text-base font-bold text-slate-900">{plan.name}</h3>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <span className="whitespace-nowrap text-3xl font-extrabold leading-none tracking-tight tabular-nums text-slate-900">
              {plan.focal}
            </span>
            <span className="text-sm font-semibold text-slate-600">{shortLine(plan.focalSub, locale)}</span>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{keepNumbersTogether(plan.body)}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * 年間プランのカード (法人スポンサーだけ)。2 つの料金のカードの下に、横いっぱいで 1 枚。
 * 30 日のカードと同じ形 (名前・大きい数字 + 期間・本文) で、同じ料金の表の一部と分かるようにする。
 */
export function SponsorsAnnualPlanCard({ plan, locale }: { plan: SponsorsAnnualCard; locale: string }) {
  return (
    <div className="mt-3 flex flex-col rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:mt-4">
      <h3 className="text-base font-bold text-slate-900">{plan.name}</h3>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span className="whitespace-nowrap text-3xl font-extrabold leading-none tracking-tight tabular-nums text-slate-900">
          {plan.focal}
        </span>
        <span className="text-sm font-semibold text-slate-600">{shortLine(plan.focalSub, locale)}</span>
      </p>
      <p className="mt-3 text-sm leading-relaxed text-slate-700">{keepNumbersTogether(plan.body)}</p>
    </div>
  );
}

// 見本の枠 (点線の枠・淡い地)。実際の掲載と見分けがつくよう「サンプル」の札を必ず付ける。
const SAMPLE_FRAME =
  'flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-2 text-center';
const SAMPLE_BADGE = 'rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold leading-4 text-amber-900 ring-1 ring-inset ring-amber-200';

function SampleBadge({ label }: { label: string }) {
  return <span className={SAMPLE_BADGE}>{label}</span>;
}

/**
 * 掲載イメージ。法人スポンサー = 同じ大きさの枠を最大の社数だけ並べる (掲載中の全社のロゴを同じ大きさで並べる)。
 * バナー広告 = 横 4：縦 1 の枠 1 つ (共有の枠から 1 件を出す)。
 */
export function SponsorsSamples({
  sponsorTitle,
  bannerTitle,
  sampleLabel,
  logoLabel,
  companyLabel,
  bannerSize,
}: {
  sponsorTitle: string;
  bannerTitle: string;
  sampleLabel: string;
  logoLabel: string;
  companyLabel: string;
  bannerSize: string;
}) {
  const slots = Array.from({ length: SPONSOR_PLANS.sponsor.maxCompanies }, (_, i) => i);
  return (
    <div className="mt-5 space-y-6">
      <div>
        <h3 className="text-sm font-bold text-slate-900 sm:text-base">{sponsorTitle}</h3>
        {/* 枠は同じ大きさで横に並べる (幅は minmax(0, 1fr) なのでスマホでもはみ出さない)。 */}
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:gap-4">
          {slots.map((slot) => (
            <li key={slot} data-sample="sponsor" className={`${SAMPLE_FRAME} min-h-24 sm:min-h-28`}>
              <SampleBadge label={sampleLabel} />
              <span className="text-sm font-semibold text-slate-500">{logoLabel}</span>
              <span className="text-xs text-slate-500">{companyLabel}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-bold text-slate-900 sm:text-base">{bannerTitle}</h3>
        <div
          data-sample="banner"
          className={`mt-3 w-full ${SAMPLE_FRAME}`}
          style={{ aspectRatio: `${SPONSOR_BANNER_SPEC.width} / ${SPONSOR_BANNER_SPEC.height}` }}
        >
          <SampleBadge label={sampleLabel} />
          <span className="text-sm font-semibold text-slate-500">{keepUnits(bannerSize)}</span>
        </div>
      </div>
    </div>
  );
}

/** 入稿仕様。名前は太字、続けて決まり (名前だけの行はリンク先の URL)。 */
export function SponsorsSpecList({ items, locale }: { items: readonly SponsorsSpecItem[]; locale: string }) {
  return (
    <ul className="mt-4 space-y-2.5 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
      {items.map((item) => (
        <li key={item.label} className="flex items-start gap-2 text-sm leading-relaxed text-slate-700">
          <span aria-hidden className="mt-0.5 text-slate-400">
            •
          </span>
          <span className="min-w-0">
            <span className="font-semibold text-slate-900">{item.label}</span>
            {item.body ? <>: {shortLine(item.body, locale)}</> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** お申し込みの流れ (番号のバッジ + 1 行ずつ)。 */
export function SponsorsFlow({ steps, locale }: { steps: readonly string[]; locale: string }) {
  return (
    <ol className="mt-4 space-y-3">
      {steps.map((step, i) => (
        <li key={step} className="flex items-start gap-3 text-sm leading-relaxed text-slate-700 sm:text-base">
          <span className={STEP_BADGE}>{i + 1}</span>
          <span className="min-w-0 pt-0.5">{shortLine(step, locale)}</span>
        </li>
      ))}
    </ol>
  );
}
