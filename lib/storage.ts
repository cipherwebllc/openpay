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

export function safeSet<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    logger.warn('localStorage.set failed', { key, error });
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
