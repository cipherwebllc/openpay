'use client';

// 買い手向けの「試す」導線: 1 JPYC の first-party demo (curl / buyer script) と、買い手 MCP の設定 JSON。
// コピー済み表示は useDiscoveryDisplay の共有状態を使う (カタログの URL コピーと同じ 1 つの表示)。

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Boxes, Check, ChevronDown, Code2, Copy } from 'lucide-react';
import type { DiscoveryDisplay } from './discoveryDisplay';

const DEMO_RESOURCE_URL = 'https://open-pay.jp/api/paid/demo';
const BUYER_SCRIPT_URL =
  'https://raw.githubusercontent.com/cipherwebllc/openpay/main/scripts/x402-buyer-example.mjs';
const DEMO_CURL = `curl -i ${DEMO_RESOURCE_URL}`;
// 設定に鍵は入れない (`0x...` のプレースホルダ鍵は MCP が起動時に拒否する)。鍵は wallet_init が
// 利用者のマシン上で作る。版固定は lib/agentSetup.ts の AGENT_MCP_SPEC と同値 — client bundle に
// 引き込まないため直書きし、一致は tests/components/X402DiscoveryView.test.tsx が検査する。
const MCP_CONFIG_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      'openpay-x402': {
        command: 'npx',
        args: ['-y', 'openpay-x402-mcp@0.19'],
        env: { SIGNER_MODE: 'keystore' },
      },
    },
  },
  null,
  2,
);

const BUYER_SCRIPT_COMMAND = [
  'npm install openpay-x402-sdk viem',
  `curl -fsSL ${BUYER_SCRIPT_URL} -o x402-buyer-example.mjs`,
  '# Enter the key at the prompt so it stays out of shell history (use a dedicated low-balance wallet)',
  'read -s BUYER_PRIVATE_KEY && export BUYER_PRIVATE_KEY',
  `RESOURCE_URL=${DEMO_RESOURCE_URL} node x402-buyer-example.mjs`,
].join('\n');

export function DiscoveryExamples({ display }: { display: DiscoveryDisplay }) {
  const t = useTranslations('Facilitator');
  const locale = useLocale();
  const { copiedKey, copyText } = display;
  const [mcpSdkNotePrefix, mcpSdkPackageName, mcpSdkNoteSuffix] = t(
    'mcpSdkNote',
  ).split(/(openpay-x402-sdk)/);

  const copyCodeBtn = (k: string, text: string) => (
    <button
      type="button"
      onClick={() => copyText(k, text)}
      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-slate-700"
    >
      {copiedKey === k ? (
        <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      <span>{copiedKey === k ? t('copied') : t('copy')}</span>
    </button>
  );

  return (
    <>
      {/* 1 JPYC の first-party demo。長い buyer script は raw を参照し、ページには最小コマンドだけ載せる。 */}
      <section>
        <details className="group overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-4 transition hover:bg-slate-50">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <Code2 className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold text-slate-900">
                {t('tryTitle')}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-slate-500">
                {t('trySubtitle')}
              </span>
            </span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-slate-500 transition group-open:rotate-180"
              aria-hidden
            />
          </summary>

          <div className="space-y-4 border-t border-slate-100 p-4">
            <p className="text-sm leading-relaxed text-slate-600">{t('tryIntro')}</p>
            <ol className="space-y-3">
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                  1
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800">{t('tryStep1')}</p>
                  <div className="mt-2 rounded-xl bg-slate-950 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-slate-400">
                        {t('tryCurlLabel')}
                      </span>
                      {copyCodeBtn('try-curl', DEMO_CURL)}
                    </div>
                    <pre className="overflow-x-auto text-xs leading-relaxed text-slate-100">
                      {DEMO_CURL}
                    </pre>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                  2
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800">{t('tryStep2')}</p>
                  <div className="mt-2 rounded-xl bg-slate-950 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <a
                        href={BUYER_SCRIPT_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 truncate text-xs font-medium text-sky-300 hover:text-sky-200"
                      >
                        {t('tryRawLink')}
                      </a>
                      {copyCodeBtn('try-script', BUYER_SCRIPT_COMMAND)}
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-100">
                      {BUYER_SCRIPT_COMMAND}
                    </pre>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                  3
                </span>
                <p className="min-w-0 text-sm font-semibold leading-relaxed text-slate-800">
                  {t('tryStep3')}
                </p>
              </li>
            </ol>
          </div>
        </details>
      </section>

      {/* エージェント導線: npm 公開済みの買い手 MCP (openpay-x402-mcp)。設定 JSON を貼るだけ。 */}
      <section>
        <details className="group overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-4 transition hover:bg-slate-50">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <Boxes className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold text-slate-900">
                {t('mcpTitle')}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-slate-500">
                {t('mcpSubtitle')}
              </span>
            </span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-slate-500 transition group-open:rotate-180"
              aria-hidden
            />
          </summary>

          <div className="space-y-3 border-t border-slate-100 p-4">
            <div className="rounded-xl bg-slate-950 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <a
                  href="https://www.npmjs.com/package/openpay-x402-mcp"
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-xs font-medium text-sky-300 hover:text-sky-200"
                >
                  openpay-x402-mcp
                </a>
                {copyCodeBtn('mcp-config', MCP_CONFIG_SNIPPET)}
              </div>
              <pre className="overflow-x-auto text-xs leading-relaxed text-slate-100">
                {MCP_CONFIG_SNIPPET}
              </pre>
            </div>
            <p className="text-xs leading-relaxed text-slate-600">
              {t('mcpWalletInit')}
            </p>
            <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-slate-600">
              <li>{t('mcpGuardPerCall')}</li>
              <li>{t('mcpGuardCumulative')}</li>
              <li>{t('mcpGuardDestinations')}</li>
            </ul>
            <a
              href="https://www.npmjs.com/package/openpay-x402-mcp"
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs font-medium text-brand hover:text-brand-dark hover:underline"
            >
              {t('mcpMore')}
            </a>
            <p className="text-xs leading-relaxed text-slate-600">
              {mcpSdkNotePrefix}
              <a
                href="https://www.npmjs.com/package/openpay-x402-sdk"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand hover:text-brand-dark hover:underline"
              >
                {mcpSdkPackageName}
              </a>
              {mcpSdkNoteSuffix}
            </p>
            {/* 初回セットアップ (ウォレット/Steward/ガード) の全手順は /guide/ai-pay へ。 */}
            <Link
              href={`/${locale}/guide/ai-pay`}
              prefetch={false}
              className="inline-flex text-xs font-medium text-brand underline-offset-2 hover:text-brand-dark hover:underline"
            >
              {t('aiPayGuideCta')}
            </Link>
          </div>
        </details>
      </section>
    </>
  );
}
