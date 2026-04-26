import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import type { Locale } from '../../i18n';
import messages from '../../messages/ja.json';

// 全テストは ja messages で動かす (UI コピーの実体を見て assertion したい)。
// localized assertion (英語向け) が必要な場合は locale='en' を渡す。
export function renderWithIntl(
  ui: ReactElement,
  opts?: { locale?: Locale } & Omit<RenderOptions, 'wrapper'>,
) {
  const { locale = 'ja', ...rest } = opts ?? {};
  // ja を default で使い、en の場合は import で切替
  const msgs =
    locale === 'en'
      ? // dynamic import を sync 化するため本ヘルパー側で require
        // (vitest は vite 経由で json をモジュールとして解決できる)
        (require('../../messages/en.json') as typeof messages)
      : messages;
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale={locale} messages={msgs}>
        {children}
      </NextIntlClientProvider>
    ),
    ...rest,
  });
}
