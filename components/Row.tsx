import type { ReactNode } from 'react';

export function Row({
  label,
  value,
  strong,
  labelExtra,
}: {
  label: string;
  value: string;
  strong?: boolean;
  labelExtra?: ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt
        className={`inline-flex items-center gap-1 ${strong ? 'text-slate-700' : 'text-slate-500'}`}
      >
        {label}
        {labelExtra}
      </dt>
      <dd
        className={`text-right font-mono ${strong ? 'font-semibold text-slate-900' : 'text-slate-700'}`}
      >
        {value}
      </dd>
    </div>
  );
}
