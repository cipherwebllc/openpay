// OpenPay はノンカストディ設計 (売上は店舗ウォレットに直送、サーバに残高 DB を持たない)。
// 店舗オペレーターに「公式 source of truth はブロックチェーンであり、画面上の履歴は補助
// 表示にすぎない」ことを明示するための定型 notice。short variant は SuccessOverlay や
// QrGenerator など 1 行で済む箇所、full variant は将来追加する /history ページ用。

import { useTranslations } from 'next-intl';

type Variant = 'short' | 'full';

export function NonCustodialNotice({
  variant,
  className,
}: {
  variant: Variant;
  className?: string;
}) {
  const t = useTranslations('NonCustodialNotice');
  const title = variant === 'short' ? t('shortTitle') : t('fullTitle');
  const body = variant === 'short' ? t('shortBody') : t('fullBody');

  if (variant === 'short') {
    return (
      <p
        role="note"
        className={[
          'flex items-start gap-2 rounded-lg bg-white/10 px-3 py-2 text-[11px] leading-snug',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span aria-hidden className="select-none">ⓘ</span>
        <span>
          <strong className="font-semibold">{title}</strong>
          <span className="ml-1 opacity-90">{body}</span>
        </span>
      </p>
    );
  }

  return (
    <aside
      role="note"
      className={[
        'rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700 ring-1 ring-slate-200/70',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <h2 className="mb-1 text-sm font-semibold text-slate-900">{title}</h2>
      <p>{body}</p>
    </aside>
  );
}
