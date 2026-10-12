// ガイドの「よくある質問」(plans/guide-ux-polish.md フェーズ 3)。質問は常に見せ、答えはたたむ
// (気になる質問だけ開いて読む)。たためるカードは GuideDisclosure と同じ見た目。
// aria-label は使わない (名前は summary の可視の文字・掟 8)。

import { GuideDisclosure } from '@/components/guide/GuideDisclosure';

export function GuideFaq({ items }: { items: readonly { readonly q: string; readonly a: string }[] }) {
  return (
    <div className="mt-4 space-y-3">
      {items.map((item) => (
        <GuideDisclosure
          key={item.q}
          summary={<h3 className="text-sm font-semibold leading-snug text-slate-900 sm:text-base">{item.q}</h3>}
        >
          <p className="text-sm leading-relaxed text-slate-700">{item.a}</p>
        </GuideDisclosure>
      ))}
    </div>
  );
}
