'use client';

// ▸ 明細 (任意): 商品名・メモ・税・管理番号。会計ごとに変わるので設定には畳まず、金額の下の 1 行に。
// QR は manual variant (未入力なら URL 不変)。状態は持たない — 設定 (商品名・メモ・税) と管理番号 (トランザクション
// 固有なので保存しない local state) は親の QrGenerator が持ち、ここは欄の値と更新を中継するだけ。

import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { AccountingSection } from '@/components/AccountingSection';
import type { QrSettings } from '@/hooks/useQrSettings';

export function ManualAccountingSection({
  settings,
  setSettings,
  receiptNo,
  onReceiptNoChange,
}: {
  settings: QrSettings;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
  receiptNo: string;
  onReceiptNoChange: (value: string) => void;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <AccountingSection
      variant="manual"
      productName={settings.productName}
      onProductNameChange={(v) =>
        setSettings((s) => ({ ...s, productName: v }))
      }
      memo={settings.memo}
      onMemoChange={(v) => setSettings((s) => ({ ...s, memo: v }))}
      taxRate={settings.taxRate}
      taxCategory={settings.taxCategory}
      onTaxChange={(next) => setSettings((s) => ({ ...s, ...next }))}
      receiptNo={receiptNo}
      onReceiptNoChange={onReceiptNoChange}
      labels={{
        title: t('accountingFieldsTitle'),
        hint: t('accountingFieldsHint'),
        productName: t('productNameLabel'),
        productNamePlaceholder: t('productNamePlaceholder'),
        memo: t('memoLabel'),
        memoPlaceholder: t('memoPlaceholder'),
        tax: t('taxLabel'),
        taxCustom: t('taxCustomLabel'),
        receiptNo: t('receiptNoLabel'),
        receiptNoPlaceholder: t('receiptNoPlaceholder'),
      }}
    />
  );
}
