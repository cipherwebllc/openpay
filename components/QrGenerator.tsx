'use client';

import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { isAddress, getAddress } from 'viem';
import { Field } from './Field';
import { useQrSettings } from '@/hooks/useQrSettings';
import { buildPayUrl, type PayParams, type PayMode } from '@/lib/url';
import { TOKENS, type TokenSymbol } from '@/lib/tokens';
import type { FeeMode } from '@/lib/fee';
import { env } from '@/lib/env';

type Mode = 'amount' | 'static';

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function QrGenerator() {
  const { settings, setSettings, hydrated } = useQrSettings();
  const [mode, setMode] = useState<Mode>('amount');
  const [amount, setAmount] = useState('');
  const [origin, setOrigin] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [accordionOpen, setAccordionOpen] = useState(true);
  const [accordionInitialized, setAccordionInitialized] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  // hydrate 後に 1 度だけ accordion 既定状態を決定する。
  // 受取先が有効なら閉じ (誤変更防止)、無効/未入力なら開く (修正促進)。
  useEffect(() => {
    if (!hydrated || accordionInitialized) return;
    setAccordionOpen(!isAddress(settings.receiver));
    setAccordionInitialized(true);
  }, [hydrated, settings.receiver, accordionInitialized]);

  const receiverValid = isAddress(settings.receiver);
  const amountValid =
    mode === 'static' ||
    (mode === 'amount' && /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0);
  const payMode: PayMode = settings.directTransfer ? 'direct' : 'gasless';

  const payUrl = useMemo(() => {
    if (!hydrated || !receiverValid || !origin || !amountValid) return '';
    const params: PayParams = {
      to: getAddress(settings.receiver),
      token: settings.token,
      fee: settings.fee,
      amount: mode === 'amount' ? amount : undefined,
      mode: payMode,
    };
    return buildPayUrl(origin, params);
  }, [
    hydrated,
    receiverValid,
    origin,
    amountValid,
    settings.receiver,
    settings.token,
    settings.fee,
    mode,
    amount,
    payMode,
  ]);

  const tokenInfo = TOKENS[settings.token];

  async function copyUrl() {
    if (!payUrl) return;
    await navigator.clipboard.writeText(payUrl);
    setCopyState('copied');
    setTimeout(() => setCopyState('idle'), 1500);
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="space-y-5">
        <Field label={`請求金額 (${tokenInfo.displaySymbol})`}>
          <div className="flex flex-col gap-2">
            <div className="inline-flex w-full rounded-lg border border-slate-200 bg-slate-100 p-1">
              {(
                [
                  ['amount', '金額指定'],
                  ['static', '据え置き'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    mode === m
                      ? 'bg-white text-brand-dark shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'amount' ? (
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) =>
                  setAmount(e.target.value.replace(/[^\d.]/g, ''))
                }
                placeholder={settings.token === 'jpyc' ? '1000' : '10.00'}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-2xl font-bold focus:border-brand focus:outline-none"
                autoFocus
              />
            ) : (
              <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-500">
                据え置き QR では金額を顧客が入力します。
              </p>
            )}
          </div>
        </Field>

        <SettingsAccordion
          open={accordionOpen}
          onToggle={() => setAccordionOpen((o) => !o)}
          summary={
            <SettingsSummary
              token={settings.token}
              receiver={settings.receiver}
              fee={settings.fee}
              direct={settings.directTransfer}
            />
          }
        >
          <Field label="通貨 / 受取チェーン">
            <div className="grid grid-cols-2 gap-2">
              {(['usdc', 'jpyc'] as TokenSymbol[]).map((t) => {
                const info = TOKENS[t];
                const active = settings.token === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setSettings((s) => ({ ...s, token: t }))}
                    className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                      active
                        ? 'border-brand bg-brand/5 text-brand-dark'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <div className="font-semibold">{info.displaySymbol}</div>
                    <div className="text-xs text-slate-500">
                      {t === 'usdc' ? 'Base' : 'Polygon'} chain (id: {info.chainId})
                    </div>
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="受取先ウォレットアドレス">
            <input
              type="text"
              value={settings.receiver}
              onChange={(e) =>
                setSettings((s) => ({ ...s, receiver: e.target.value.trim() }))
              }
              placeholder="0x..."
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
            />
            {settings.receiver && !receiverValid && (
              <p className="mt-1 text-xs text-red-600">
                アドレス形式が正しくありません
              </p>
            )}
          </Field>

          {settings.directTransfer ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
              直接送金モード: 手数料 0% (内税/外税の設定は無効)
            </div>
          ) : (
            <Field label="手数料の負担">
              <div className="grid grid-cols-2 gap-2">
                {(['include', 'exclude'] as FeeMode[]).map((f) => {
                  const active = settings.fee === f;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setSettings((s) => ({ ...s, fee: f }))}
                      className={`rounded-lg border px-3 py-3 text-left text-sm transition ${
                        active
                          ? 'border-brand bg-brand/5 text-brand-dark'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <div className="font-semibold">
                        {f === 'include' ? '内税 (店主負担)' : '外税 (客負担)'}
                      </div>
                      <div className="text-xs text-slate-500">
                        {f === 'include'
                          ? '請求額から手数料を差引いて店主受取'
                          : '請求額に手数料を上乗せして顧客請求'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          <AdvancedSection>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={settings.directTransfer}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    directTransfer: e.target.checked,
                  }))
                }
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-slate-700">
                  直接送金 (上級者向け)
                </span>
                <span className="block text-slate-500">
                  顧客が自分でガス代 (MATIC / ETH) を支払う代わりに、運営手数料 1% を取らない純粋な ERC20 transfer になります。
                </span>
              </span>
            </label>
          </AdvancedSection>
        </SettingsAccordion>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">QRコード</h2>
          <p className="text-sm text-slate-500">
            お客様がスキャンすると決済ページが開きます。
          </p>
        </div>
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white p-6">
          {payUrl ? (
            <>
              <QRCodeSVG value={payUrl} size={240} includeMargin level="M" />
              <div className="w-full break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
                {payUrl}
              </div>
              <button
                type="button"
                onClick={copyUrl}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
              >
                {copyState === 'copied' ? 'コピー済み' : 'URLをコピー'}
              </button>
            </>
          ) : (
            <div className="grid h-60 w-60 place-items-center rounded-lg bg-slate-50 text-center text-sm text-slate-400">
              {!receiverValid
                ? '受取先アドレスを入力してください (詳細設定)'
                : !amountValid
                  ? '金額を入力してください'
                  : 'QR を生成中…'}
            </div>
          )}
        </div>
        {!settings.directTransfer && (
          <div className="rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <p className="font-semibold text-slate-700">運営手数料の徴収先</p>
            <p className="mt-1 break-all font-mono">{env.feeReceiver}</p>
            <p className="mt-2 text-slate-500">
              (1.0% / 最低 15 JPYC または 0.1 USDC)
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsAccordion({
  open,
  onToggle,
  summary,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex flex-1 flex-col">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            詳細設定
          </span>
          {!open && (
            <span className="mt-0.5 text-xs text-slate-600">{summary}</span>
          )}
        </div>
        <span className="text-slate-400" aria-hidden>
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-200 px-4 py-4">
          {children}
        </div>
      )}
    </div>
  );
}

function SettingsSummary({
  token,
  receiver,
  fee,
  direct,
}: {
  token: TokenSymbol;
  receiver: string;
  fee: FeeMode;
  direct: boolean;
}) {
  const tokenLabel = TOKENS[token].displaySymbol;
  const recvLabel = isAddress(receiver) ? shortAddr(receiver) : '未設定';
  const feeLabel = direct
    ? '直送 / 手数料0%'
    : fee === 'include'
      ? '内税'
      : '外税';
  return (
    <span className="font-mono">
      {tokenLabel} · {recvLabel} · {feeLabel}
    </span>
  );
}

function AdvancedSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-dashed border-slate-200 pt-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        おまけ機能
      </p>
      {children}
    </div>
  );
}

