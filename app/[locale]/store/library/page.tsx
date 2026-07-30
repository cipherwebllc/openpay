// Creator Store の購入済みライブラリ。client flag OFF では page 自体を 404 にし、
// ON のときだけ SIWE client component を描画する。

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { CreatorStoreLibrary } from '@/components/CreatorStoreLibrary';
import { env } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Digital product library · OpenPay',
  robots: { index: false, follow: false },
};

export default function CreatorStoreLibraryPage() {
  if (!env.enableCreatorStoreUi) notFound();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl px-4 py-6">
        <CreatorStoreLibrary />
      </div>
    </AppShell>
  );
}
