// ガイドの「よくある質問」(plans/guide-ux-polish.md フェーズ 3)。答えは 1〜3 文と短いので、たたまずに
// 質問と答えを並べて見せる (たたむと 5 タップ増えるのに短くならず、閉じた一覧は「心配ごとの一覧」に見えた)。
// 1 枚の面に区切り線で並べる。答えは本文と同じ大きさ (p.text-sm を GuideFrame が 15/16px にする)。

export function GuideFaq({ items }: { items: readonly { readonly q: string; readonly a: string }[] }) {
  return (
    <dl className="mt-4 divide-y divide-slate-100 rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
      {items.map((item) => (
        <div key={item.q} className="px-4 py-4 sm:px-5">
          <dt className="text-sm font-semibold leading-snug text-slate-900 sm:text-base">{item.q}</dt>
          <dd className="mt-1.5">
            <p className="text-sm leading-relaxed text-slate-700">{item.a}</p>
          </dd>
        </div>
      ))}
    </dl>
  );
}
