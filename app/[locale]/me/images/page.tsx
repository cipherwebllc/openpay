// /me/images: マイページの「アップロードした画像」(画像のアップロードの PR 3A)。一覧と削除は client (components/ImageLibrary)
// が SIWE のセッションで GET /api/images・POST /api/images/delete を呼ぶ。出すかは /api/auth/siwe/me の imageUpload で決める
// (段階 IMAGE_UPLOAD_MODE は server だけの env なので、page は静的なまま・段階 off では短い文だけ)。
// 掟 3: このファイルは default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { ImageLibrary } from '@/components/ImageLibrary';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'ImageLibrary' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    // 本人だけの画面 (検索に出さない)。
    robots: { index: false, follow: false },
  };
}

export default async function MeImagesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <AppShell>
      <ImageLibrary />
    </AppShell>
  );
}
