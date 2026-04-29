import { CopyableField } from './CopyableField';

// 成功 panel 内の <dt>/<dd> ペア。copyable=true で hash 等の長い値を
// クリック 1 タップでコピー可能にする (CheckoutForm / TipForm 共通)。
export function ResultRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="opacity-70">{label}</dt>
      <dd className="min-w-0 flex-1 text-right">
        {copyable ? (
          <CopyableField value={value} label={label} />
        ) : (
          <span className="break-all font-mono">{value}</span>
        )}
      </dd>
    </div>
  );
}
