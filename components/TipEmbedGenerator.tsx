'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isAddress, getAddress, type Address } from 'viem';
import { AddressInput } from './AddressInput';
import { Field } from './Field';
import { useTipSettings } from '@/hooks/useTipSettings';
import { TOKENS, type TokenSymbol } from '@/lib/tokens';
import { isLikelyName } from '@/lib/nameDetection';
import {
  buildTipUrl,
  DEFAULT_TIP_PRESETS,
  type TipParams,
} from '@/lib/url';

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const IFRAME_WIDTH = 380;
const IFRAME_HEIGHT = 640;

type CopyKey = 'url' | 'iframe';

export function TipEmbedGenerator() {
  const { settings, setSettings, hydrated } = useTipSettings();
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const [resolvedReceiver, setResolvedReceiver] = useState<Address | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  const effectiveReceiver: Address | null = useMemo(() => {
    if (isAddress(settings.receiver)) return getAddress(settings.receiver);
    if (resolvedReceiver) return resolvedReceiver;
    return null;
  }, [settings.receiver, resolvedReceiver]);

  const colorValid = COLOR_PATTERN.test(settings.color);
  const presetsParsed = useMemo(() => {
    return settings.presets
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && DECIMAL_PATTERN.test(s) && Number(s) > 0)
      .slice(0, 6);
  }, [settings.presets]);

  const previewPresets =
    presetsParsed.length > 0
      ? presetsParsed
      : DEFAULT_TIP_PRESETS[settings.token];

  const tipUrl = useMemo(() => {
    if (!hydrated || !effectiveReceiver || !origin) return '';
    const params: TipParams = {
      to: effectiveReceiver,
      token: settings.token,
      name: settings.name || undefined,
      message: settings.message || undefined,
      color: colorValid ? settings.color : undefined,
      presets: presetsParsed.length > 0 ? presetsParsed : undefined,
      thanks: settings.thanks || undefined,
      thanksUrl: settings.thanksUrl || undefined,
      webhook: settings.webhook || undefined,
    };
    return buildTipUrl(origin, params);
  }, [
    hydrated,
    effectiveReceiver,
    origin,
    settings.token,
    settings.name,
    settings.message,
    settings.color,
    colorValid,
    presetsParsed,
    settings.thanks,
    settings.thanksUrl,
    settings.webhook,
  ]);

  const handleResolved = useCallback((addr: Address | null) => {
    setResolvedReceiver(addr);
  }, []);

  const iframeSnippet = useMemo(() => {
    if (!tipUrl) return '';
    return `<iframe
  src="${escapeAttr(tipUrl)}"
  width="${IFRAME_WIDTH}"
  height="${IFRAME_HEIGHT}"
  style="border:0;max-width:100%"
  title="OpenPay Tip"
  loading="lazy"
></iframe>`;
  }, [tipUrl]);

  async function copy(value: string, key: CopyKey) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <Field label="クリエイターウォレットアドレス">
          <AddressInput
            value={settings.receiver}
            onChange={(v) => setSettings((s) => ({ ...s, receiver: v }))}
            onResolved={handleResolved}
          />
          {settings.receiver &&
            !effectiveReceiver &&
            !isLikelyName(settings.receiver) && (
              <p className="mt-1 text-xs text-red-600">
                アドレス形式が正しくありません
              </p>
            )}
        </Field>

        <Field label="通貨 / 受取チェーン">
          <div className="grid grid-cols-2 gap-2">
            {(['jpyc', 'usdc'] as TokenSymbol[]).map((t) => {
              const info = TOKENS[t];
              const active = settings.token === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, token: t }))}
                  className={`rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                    active
                      ? 'border-brand bg-brand/5 text-brand-dark'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <div className="font-semibold">{info.displaySymbol}</div>
                  <div className="text-xs text-slate-500">
                    {t === 'usdc' ? 'Base' : 'Polygon'}
                  </div>
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="表示名 (任意)">
          <input
            type="text"
            value={settings.name}
            onChange={(e) =>
              setSettings((s) => ({ ...s, name: e.target.value }))
            }
            placeholder="例: 山田太郎"
            maxLength={60}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </Field>

        <Field label="メッセージ (任意)">
          <textarea
            value={settings.message}
            onChange={(e) =>
              setSettings((s) => ({ ...s, message: e.target.value }))
            }
            placeholder="例: 応援ありがとうございます！"
            maxLength={200}
            rows={2}
            className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-400">
            {settings.message.length} / 200
          </p>
        </Field>

        <Field label="テーマカラー">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={colorValid ? settings.color : '#2563eb'}
              onChange={(e) =>
                setSettings((s) => ({ ...s, color: e.target.value }))
              }
              className="h-10 w-14 cursor-pointer rounded-md border border-slate-200 bg-white p-0.5"
            />
            <input
              type="text"
              value={settings.color}
              onChange={(e) =>
                setSettings((s) => ({ ...s, color: e.target.value }))
              }
              placeholder="#2563eb"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
            />
          </div>
          {settings.color && !colorValid && (
            <p className="mt-1 text-xs text-red-600">
              色は #rrggbb 形式で指定してください
            </p>
          )}
        </Field>

        <Field
          label={`金額プリセット (任意, カンマ区切り — 既定: ${DEFAULT_TIP_PRESETS[settings.token].join(', ')})`}
        >
          <input
            type="text"
            value={settings.presets}
            onChange={(e) =>
              setSettings((s) => ({ ...s, presets: e.target.value }))
            }
            placeholder={`例: ${DEFAULT_TIP_PRESETS[settings.token].join(',')}`}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
          />
          {settings.presets && presetsParsed.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">
              有効な金額がありません — 既定値が使用されます
            </p>
          )}
          {presetsParsed.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              使用される値: {presetsParsed.join(', ')} {TOKENS[settings.token].displaySymbol}
            </p>
          )}
        </Field>

        <Field label="送信成功後のサンキューメッセージ (任意)">
          <textarea
            value={settings.thanks}
            onChange={(e) =>
              setSettings((s) => ({ ...s, thanks: e.target.value }))
            }
            placeholder="例: ありがとう！限定 Discord に招待します ↓"
            maxLength={200}
            rows={2}
            className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-400">
            {settings.thanks.length} / 200
          </p>
        </Field>

        <Field label="送信成功後のリンク URL (任意)">
          <input
            type="text"
            value={settings.thanksUrl}
            onChange={(e) =>
              setSettings((s) => ({ ...s, thanksUrl: e.target.value }))
            }
            placeholder="https://discord.gg/... または https://patreon.com/..."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            送信成功画面で「リンクを開く」ボタンとして表示。http(s) 以外は無視されます
          </p>
        </Field>

        <Field label="送信成功時の webhook URL (任意)">
          <input
            type="text"
            value={settings.webhook}
            onChange={(e) =>
              setSettings((s) => ({ ...s, webhook: e.target.value }))
            }
            placeholder="https://discord.com/api/webhooks/... など"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            設定すると、tip 受信時に {`{ txHash, amount, token, from, message }`} を JSON で POST します。Discord/Slack/独自バックエンド連携用。CORS 許可が必要
          </p>
        </Field>
      </div>

      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">プレビュー</h3>
          <div
            className="mt-2 rounded-2xl p-4 text-white shadow-sm"
            style={{ backgroundColor: colorValid ? settings.color : '#2563eb' }}
          >
            <p className="text-xs uppercase tracking-wider opacity-80">
              OpenPay Tip
            </p>
            <p className="mt-2 text-lg font-bold">
              {settings.name
                ? `${settings.name} さんへチップを送る`
                : 'クリエイターへチップを送る'}
            </p>
            {settings.message && (
              <p className="mt-2 whitespace-pre-wrap text-sm opacity-90">
                {settings.message}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {previewPresets.map((p) => (
                <span
                  key={p}
                  className="rounded-md bg-white/20 px-2 py-1 text-xs font-mono"
                >
                  {p} {TOKENS[settings.token].displaySymbol}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Tip URL
            </h3>
            <button
              type="button"
              onClick={() => copy(tipUrl, 'url')}
              disabled={!tipUrl}
              className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {copied === 'url' ? 'コピー済み' : 'コピー'}
            </button>
          </div>
          <div className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
            {tipUrl || (
              <span className="text-slate-400">
                受取アドレスを入力すると URL が生成されます
              </span>
            )}
          </div>
          {tipUrl && (
            <a
              href={tipUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs text-brand hover:underline"
            >
              新しいタブで開く →
            </a>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              iframe 埋め込みコード
            </h3>
            <button
              type="button"
              onClick={() => copy(iframeSnippet, 'iframe')}
              disabled={!iframeSnippet}
              className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {copied === 'iframe' ? 'コピー済み' : 'コピー'}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100">
            <code>
              {iframeSnippet || (
                <span className="text-slate-500">
                  受取アドレスを入力するとスニペットが生成されます
                </span>
              )}
            </code>
          </pre>
          <p className="mt-2 text-xs text-slate-500">
            ブログ・ポートフォリオサイト・GitHub README (raw HTML が許可されている場合) などにそのまま貼り付けられます。
          </p>
        </div>
      </div>
    </div>
  );
}

function escapeAttr(value: string): string {
  // iframe src 属性に埋め込むため、ダブルクォートと < > & を実体参照化。
  // URLSearchParams の出力は既に URL エンコード済みなので、追加の HTML エスケープのみ必要。
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
