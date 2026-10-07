export function Field({
  label,
  children,
  htmlFor,
}: {
  label: string;
  children: React.ReactNode;
  /** 指定時は見出しを入力欄の可視ラベル (<label htmlFor>) として結び付ける。 */
  htmlFor?: string;
}) {
  const labelClass =
    'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500';
  return (
    <div className="block">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <span className={labelClass}>{label}</span>
      )}
      {children}
    </div>
  );
}
