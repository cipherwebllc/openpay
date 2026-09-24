'use client';

import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { QrCode as QrCodeIcon } from 'lucide-react';
import { StepCard } from '../StepCard';
import type { QrSettings } from '@/hooks/useQrSettings';
import type { TokenDeployment } from '@/lib/tokens';
import type { Mode } from './QrAmountSection';

// ③ QR (右列): 表示ボタン / 生成中 / 空状態。モーダルの開閉状態・payUrl の導出・
// モーダル本体 (qrRef・保存・印刷・前回 QR の保存) は QrGenerator に残す。
export function QrPreviewSection({
  payUrl,
  receiverValid,
  amountValid,
  settings,
  setAmount,
  setQrModalOpen,
}: {
  payUrl: string;
  receiverValid: boolean;
  amountValid: boolean;
  settings: QrSettings;
  setAmount: Dispatch<SetStateAction<string>>;
  setQrModalOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <div className="space-y-4 print:hidden lg:sticky lg:top-20">
      <StepCard
        step={3}
        icon={QrCodeIcon}
        title={t('steps.qr')}
        variant="qr-prominent"
      >
        <p className="-mt-2 mb-3 text-xs text-slate-500">
          {t('qrDescription')}
        </p>
        <div className="flex flex-col items-center gap-4">
          {payUrl ? (
            // 即時表示せず、目立つボタン → 全画面モーダルで提示 (店員が金額を確認
            // してからお客様に画面を見せる対面フロー)。
            // ボタンは lg (右サイドバー) のみ表示。モバイルは下部固定バーが担うので
            // ここでは出さず、「QRコードを表示する」が2つ並ぶのを防ぐ (誘導文だけ出す)。
            <>
              <button
                type="button"
                onClick={() => setQrModalOpen(true)}
                className="hidden w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-4 text-base font-bold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 lg:inline-flex"
              >
                <QrCodeIcon className="h-5 w-5" aria-hidden />
                {t('showQr')}
              </button>
              <p className="text-center text-sm text-slate-500 lg:hidden">
                {t('qrMobileBarHint')}
              </p>
            </>
          ) : receiverValid && amountValid ? (
            // receiver + amount valid だが payUrl 未確定の遷移状態 (origin 空 = SSR /
            // hydrate 直後の数フレーム間)。「生成中」で混乱を回避する。
            <p className="rounded-lg bg-slate-50 px-4 py-6 text-sm text-slate-500">
              {t('qrPlaceholderGenerating')}
            </p>
          ) : (
            <QrEmptyState
              title={t('qrEmptyState.title')}
              needLabel={t('qrEmptyState.needLabel')}
              items={[
                {
                  label: t('qrEmptyState.needAmount'),
                  done: amountValid,
                },
                {
                  label: t('qrEmptyState.needAddress'),
                  done: receiverValid,
                },
              ]}
              // 受取先は済だが金額が空のとき、サンプル金額ワンタップで
              // 最初の QR を出して操作感を掴ませる導線。
              sample={
                receiverValid && !amountValid
                  ? {
                      label: t('qrEmptyState.trySample', {
                        amount: settings.token === 'usdc' ? '5' : '1000',
                      }),
                      onUse: () =>
                        setAmount(settings.token === 'usdc' ? '5' : '1000'),
                    }
                  : undefined
              }
            />
          )}
        </div>
      </StepCard>
    </div>
  );
}

// モバイル下部固定 会計バー。payUrl が無い間は null。URL の内容だけの変更では
// 再描画を促さず、バーの出現と表示金額 / モード / 通貨記号の変更に追従する。
export function QrMobileBar({
  payUrl,
  amount,
  mode,
  deployment,
  amountLabelText,
  fiatHint,
  setQrModalOpen,
}: {
  payUrl: string;
  amount: string;
  mode: Mode;
  deployment: TokenDeployment;
  amountLabelText: string;
  fiatHint: string | null;
  setQrModalOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const t = useTranslations('QrGenerator');
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const visible = Boolean(payUrl);
  // WebKit (モバイル Safari・SNS アプリ内ブラウザ) では position:sticky な下部バーの子テキストを
  // JS で書き換えても合成レイヤーが再ラスタライズされず古い表示が残ることがある (RegisterMode
  // と同根)。バーの出現時と表示金額/通貨/モードが変わるたび transform を 1 フレーム
  // 入れて再描画を強制する (金額を先に入力し、後から受取先が確定する場合も含む)。
  useEffect(() => {
    const el = bottomBarRef.current;
    if (!el) return;
    el.style.transform = 'translateZ(0)';
    const id = requestAnimationFrame(() => {
      if (el) el.style.transform = '';
    });
    return () => cancelAnimationFrame(id);
  }, [visible, amount, mode, deployment.displaySymbol]);
  if (!visible) return null;
  return (
    <div
      ref={bottomBarRef}
      className="sticky bottom-14 z-20 -mx-4 flex items-center gap-3 border-t border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_-6px_20px_-6px_rgba(15,23,42,0.14)] backdrop-blur md:bottom-0 lg:hidden print:hidden"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-slate-500">
          {t('bottomAmountLabel')}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="truncate font-mono text-lg font-bold text-slate-900">
            {amountLabelText}
          </span>
          {fiatHint && (
            <span className="shrink-0 text-xs font-medium text-slate-500">
              {fiatHint}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setQrModalOpen(true)}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-base font-bold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0"
      >
        <QrCodeIcon className="h-5 w-5" aria-hidden />
        {t('showQr')}
      </button>
    </div>
  );
}

// 必要な項目を checkmark 付きで明示する empty state。初見店主が「何を
// 入れれば QR が出るか」を一目で理解できるようにする (review #2 + #8)。
function QrEmptyState({
  title,
  needLabel,
  items,
  sample,
}: {
  title: string;
  needLabel: string;
  items: { label: string; done: boolean }[];
  // 受取先は済だが金額未入力のとき、サンプル金額ワンタップで最初の QR を出す導線。
  sample?: { label: string; onUse: () => void };
}) {
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-lg bg-slate-50 px-4 py-6 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <div className="w-full">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {needLabel}
        </p>
        <ul className="space-y-1.5 text-left">
          {items.map((item) => (
            <li
              key={item.label}
              className="flex items-center gap-2 text-sm"
            >
              <span
                aria-hidden
                className={`inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
                  item.done
                    ? 'bg-emerald-500 text-white'
                    : 'border border-slate-300 bg-white text-slate-500'
                }`}
              >
                {item.done ? '✓' : ''}
              </span>
              <span className={item.done ? 'text-slate-500 line-through' : 'text-slate-700'}>
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {sample && (
        <button
          type="button"
          onClick={sample.onUse}
          className="rounded-lg border border-brand/40 bg-brand/5 px-3 py-1.5 text-xs font-semibold text-brand-dark hover:border-brand"
        >
          {sample.label}
        </button>
      )}
    </div>
  );
}
