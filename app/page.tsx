import Link from 'next/link';
import { QrGenerator } from '@/components/QrGenerator';
import { env } from '@/lib/env';

export default function HomePage() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            OpenPay
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            ウォレットアドレス 1 つで始める、ガスレス決済 QR ジェネレーター
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

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <QrGenerator />
      </div>

      <footer className="mt-8 text-center text-xs text-slate-400">
        Powered by ERC-4337 · Pimlico · permissionless.js · ERC-7702
      </footer>
    </main>
  );
}
