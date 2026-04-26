'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

// React レンダリングエラーを Sentry に送信する Next.js App Router の境界。
// DSN 未設定時は Sentry.captureException が no-op になる。
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ja">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
