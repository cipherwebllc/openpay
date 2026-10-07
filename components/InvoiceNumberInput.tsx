'use client';

// インボイス登録番号の入力欄 (QR・レジの設定とモバイル注文のビルダーで共用)。
// 生入力を保存し、形式 (T + 13 桁) に合わないときだけ注意を出す。URL・公開設定には
// 正規化した値だけが乗る (lib/url の appendTaxReceiptParams・validateStorefrontParts)。
// 文言は呼び出し側の namespace から渡す (ページごとの client namespace の宣言を増やさない)。

import {
  INVOICE_REGISTRATION_INPUT_MAX,
  invoiceLookupUrl,
  normalizeInvoiceRegistrationNumber,
} from '@/lib/invoice';

export function InvoiceNumberInput({
  id,
  value,
  onChange,
  hasStoreName,
  className,
  text,
}: {
  /** 可視の見出し (<label htmlFor>) と結び付けるための id。 */
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** 店名が空だと控えに出ないので、その注意を出すかの判定に使う。 */
  hasStoreName: boolean;
  className: string;
  text: { invalid: string; lookup: string; needsStoreName: string };
}) {
  const trimmed = value.trim();
  const normalized = normalizeInvoiceRegistrationNumber(trimmed);
  return (
    <>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="T1234567890123"
        autoComplete="off"
        spellCheck={false}
        maxLength={INVOICE_REGISTRATION_INPUT_MAX}
        className={className}
      />
      {trimmed && !normalized && (
        <p className="mt-1 text-xs text-amber-700">{text.invalid}</p>
      )}
      {normalized && (
        <p className="mt-1 text-xs text-slate-500">
          {!hasStoreName && <span className="mr-1 text-amber-700">{text.needsStoreName}</span>}
          <a
            href={invoiceLookupUrl(normalized)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand underline underline-offset-2 hover:opacity-80"
          >
            {text.lookup}
          </a>
        </p>
      )}
    </>
  );
}
