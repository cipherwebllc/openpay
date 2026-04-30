'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe `window.location.origin`. マウント前は空文字を返し、
 * `hydrated` パターンと組み合わせて URL 構築の前提として使う。
 */
export function useOrigin(): string {
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}
