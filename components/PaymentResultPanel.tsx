'use client';

import { CopyableField } from './CopyableField';

export function PaymentResultPanel({
  title,
  rows,
}: {
  title: string;
  // copyable=true の row はクリックで clipboard コピー可能 (tx hash 等の長い文字列向け)
  rows: Array<{ label: string; value: string; copyable?: boolean }>;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
      <p className="font-semibold">{title}</p>
      <dl className="mt-2 space-y-1 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-2">
            <dt className="opacity-70">{row.label}</dt>
            <dd className="min-w-0 flex-1 text-right">
              {row.copyable ? (
                <CopyableField value={row.value} label={row.label} />
              ) : (
                <span className="break-all font-mono">{row.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
