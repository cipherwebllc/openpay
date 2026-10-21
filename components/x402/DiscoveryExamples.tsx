'use client';

// 買い手向けの「試す」導線: 1 JPYC の first-party demo (curl / buyer script) と、買い手 MCP の設定 JSON。
// コピー済み表示は useDiscoveryDisplay の共有状態を使う (カタログの URL コピーと同じ 1 つの表示)。

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Boxes, Check, CheckCircle2, ChevronDown, Code2, Copy, ShieldCheck } from 'lucide-react';
import { X402_DEMO_PATH } from '@/lib/x402/demoPath';
import { AGENTIC_MARKET_URL, X402_LIST_URL } from '@/lib/x402/usdcCatalog';
import type { DiscoveryDisplay } from './discoveryDisplay';

const DEMO_RESOURCE_URL = `https://open-pay.jp${X402_DEMO_PATH}`;
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
        args: ['-y', 'openpay-x402-mcp@0.20'],
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

export function DiscoveryExamples({
  display,
  showUsdcDiscovery,
}: {
  display: DiscoveryDisplay;
  /** USDC 商品があるとき、発見面に x402 Bazaar / x402-list も並べる。 */
  showUsdcDiscovery: boolean;
}) {
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
    <section id="agent" className="scroll-mt-24 space-y-3">
      <h3 className="text-base font-bold text-slate-900">{t('agentSectionTitle')}</h3>
      {/* 発見面: JPYC は /api/discovery、USDC は CDP Bazaar / agentic.market と x402-list。 */}
      <p className="text-xs leading-relaxed text-slate-500">
        {t('catalogDiscoverPrefix')}
        <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-600">
          /api/discovery
        </code>
        {showUsdcDiscovery && (
          <>
            {t('catalogDiscoverJoin')}
            <a
              href={AGENTIC_MARKET_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-brand underline-offset-2 hover:text-brand-dark hover:underline"
            >
              {t('catalogDiscoverBazaar')}
            </a>
            {' / '}
            {/* OpenPay 自身の USDC データ API の掲載先 (2026-09-15 承認)。第三者出品の自動掲載先ではない。 */}
            <a
              href={X402_LIST_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-brand underline-offset-2 hover:text-brand-dark hover:underline"
            >
              {t('catalogDiscoverX402List')}
            </a>
          </>
        )}
      </p>
      {/* 自律購入の買い手が最初に知りたい「暴走しないか」を常に見える 1 行で答える。中身 (上限・照合・証跡) は
          MCP の節に既定値と並べて置く (実装済みの事実だけを書き、売り手のあらゆる挙動を防ぐ保証とは書かない)。 */}
      <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
        <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
        <span>
          {t('guardsTitle')}: {t('guardsSummary')}
        </span>
      </p>
      {/* エージェント導線: npm 公開済みの買い手 MCP (openpay-x402-mcp)。設定 JSON を貼るだけ。 */}
      <section>
        <details className="group overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-4 transition hover:bg-slate-50">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
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
            {/* 購入ガード: SDK / MCP が強制する事実と、MCP の既定値。 */}
            <div className="rounded-xl bg-emerald-50/60 p-3 ring-1 ring-inset ring-emerald-100">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
                <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
                {t('guardsTitle')}
              </p>
              <ul className="mt-2 space-y-1">
                {[
                  t('guardsLimit'),
                  t('guardsMatch'),
                  t('guardsResource'),
                  t('guardsReceipt'),
                  t('guardsUnlock'),
                ].map((line) => (
                  <li key={line} className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-700">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-slate-600">
                <li>{t('mcpGuardPerCall')}</li>
                <li>{t('mcpGuardCumulative')}</li>
                <li>{t('mcpGuardDestinations')}</li>
              </ul>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{t('guardsNote')}</p>
            </div>
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
      {/* 1 JPYC の first-party demo。長い buyer script は raw を参照し、ページには最小コマンドだけ載せる。 */}
      <section>
        <details className="group overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-4 transition hover:bg-slate-50">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
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

    </section>
  );
}
