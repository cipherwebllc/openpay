// Creator Store の購入済みライブラリ。client flag OFF では page 自体を 404 にし、
// ON のときだけ SIWE client component を描画する。

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { CreatorStoreLibrary } from '@/components/CreatorStoreLibrary';
import { env } from '@/lib/env';
import { searchParamsFromNext, type RouteSearch } from '@/lib/url';

export const metadata: Metadata = {
  title: 'Digital product library · OpenPay',
  robots: { index: false, follow: false },
};

export default async function CreatorStoreLibraryPage({ searchParams }: { searchParams?: Promise<RouteSearch> }) {
  if (!env.enableCreatorStoreUi) notFound();
  const source = env.enableLicenseNftUi && searchParamsFromNext((await searchParams) ?? {}).get('source') === 'holders'
    ? 'holders' : 'purchases';

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl px-4 py-6">
        <CreatorStoreLibrary source={source} />
      </div>
    </AppShell>
  );
}
