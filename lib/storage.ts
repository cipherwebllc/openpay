// Safari ITP / プライベートブラウジングでは localStorage 操作が throw するため、
// try/catch で吸収する (SSR の window 不在も同時に処理)。
import { logger } from './logger';

export function safeGet<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.warn('localStorage.get failed', { key, error });
    return fallback;
  }
}

/** 書けたら true (容量超過・private mode 等で書けなかったら false。呼び出し側は無視してもよい)。 */
export function safeSet<T>(key: string, value: T): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    logger.warn('localStorage.set failed', { key, error });
    return false;
  }
}

export function safeRemove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    logger.warn('localStorage.remove failed', { key, error });
  }
}
