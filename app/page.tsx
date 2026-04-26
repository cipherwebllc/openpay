'use client';

import { useState } from 'react';
import Link from 'next/link';
import { QrGenerator } from '@/components/QrGenerator';
import { TipEmbedGenerator } from '@/components/TipEmbedGenerator';
import { env } from '@/lib/env';

type Tab = 'qr' | 'tip';

export default function HomePage() {
  const [tab, setTab] = useState<Tab>('qr');

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            OpenPay
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            ウォレットアドレス 1 つで始める、ガスレス決済 QR / Tip widget ジェネレーター
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="rounded-full bg-slate-200 px-2 py-1 font-mono">
            {env.networkEnv}
          </span>
          <Link
            href="/pay"
            className="text-brand hover:underline"
            prefetch={false}
          >
            /pay (顧客向け)
          </Link>
        </div>
      </header>

      <div className="mb-4 inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1">
        {(
          [
            ['qr', '決済 QR (店舗)'],
            ['tip', 'Tip widget (クリエイター)'],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
              tab === t
                ? 'bg-white text-brand-dark shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        {tab === 'qr' ? (
          <QrGenerator />
        ) : (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-800">
                Tip widget 埋め込みコードを生成
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                ブログ・ポートフォリオ・配信ページに貼り付けてチップを受け取ります。手数料 1%、ガス代は OpenPay が負担。
              </p>
            </div>
            <TipEmbedGenerator />
          </div>
        )}
      </div>

      <footer className="mt-8 text-center text-xs text-slate-400">
        Powered by ERC-4337 · Pimlico · permissionless.js · ERC-7702
      </footer>
    </main>
  );
}
