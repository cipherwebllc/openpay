export function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className={strong ? 'text-slate-700' : 'text-slate-500'}>{label}</dt>
      <dd
        className={`text-right font-mono ${strong ? 'font-semibold text-slate-900' : 'text-slate-700'}`}
      >
        {value}
      </dd>
    </div>
  );
}
