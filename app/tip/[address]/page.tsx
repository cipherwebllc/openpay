import type { Metadata } from 'next';
import { TipForm } from '@/components/TipForm';
import { parseTipParams } from '@/lib/url';

export const metadata: Metadata = {
  title: 'OpenPay Tip',
  description: 'OpenPay の Tip widget — JPYC / USDC で即時チップ送金',
};

type RawSearch = Record<string, string | string[] | undefined>;

function searchParamsAdapter(raw: RawSearch) {
  return {
    get(name: string): string | null {
      const v = raw[name];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    },
  };
}

export default async function TipPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams: Promise<RawSearch>;
}) {
  const { address } = await params;
  const raw = await searchParams;
  const parsed = parseTipParams(address, searchParamsAdapter(raw));

  return (
    <main className="mx-auto w-full max-w-md px-3 py-4">
      {parsed.ok ? (
        <TipForm params={parsed.params} />
      ) : (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          <p className="font-semibold">Tip URL が不正です</p>
          <p className="mt-2">{parsed.error}</p>
          <p className="mt-3 text-xs text-red-600/80">
            正しい URL の例:{' '}
            <code className="font-mono">
              /tip/0x...?token=jpyc&amp;name=...
            </code>
          </p>
        </div>
      )}
    </main>
  );
}
