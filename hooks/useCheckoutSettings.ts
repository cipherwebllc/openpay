'use client';

// items は draft 状態 (空欄含む文字列ペア) で保存し、URL 生成時に parseCheckoutItemDrafts
// で CheckoutItem[] へ昇格させる (all-or-nothing、parseSplitDrafts と同型)。

import { useEffect, useState } from 'react';
import { safeGet, safeSet } from '@/lib/storage';
import type { ChainSlug } from '@/lib/chains';
import type { GasMode } from '@/lib/fee';
import type { TokenSymbol } from '@/lib/tokens';
import { CHECKOUT_MAX_ITEMS, type CheckoutItemDraft } from '@/lib/url';
import { normalizeChainForToken } from './useQrSettings';

export type CheckoutSettings = {
  receiver: string;
  token: TokenSymbol;
  chain: ChainSlug;
  gasMode: GasMode;
  items: CheckoutItemDraft[];
  orderId: string;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  webhook: string;
};

const STORAGE_KEY = 'openpay:checkout-settings:v1';

const DEFAULT_SETTINGS: CheckoutSettings = {
  receiver: '',
  token: 'usdc',
  chain: 'base',
  gasMode: 'customer',
  items: [{ name: '', qty: '', price: '' }],
  orderId: '',
  description: '',
  customerEmail: '',
  successUrl: '',
  cancelUrl: '',
  webhook: '',
};

function sanitizeItems(loaded: unknown): CheckoutItemDraft[] {
  if (!Array.isArray(loaded)) return DEFAULT_SETTINGS.items;
  const items = loaded
    .filter(
      (e): e is CheckoutItemDraft =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as CheckoutItemDraft).name === 'string' &&
        typeof (e as CheckoutItemDraft).qty === 'string' &&
        typeof (e as CheckoutItemDraft).price === 'string',
    )
    .slice(0, CHECKOUT_MAX_ITEMS);
  return items.length > 0 ? items : DEFAULT_SETTINGS.items;
}

function sanitizeOptionalString(
  value: unknown,
  fallback: string,
  maxLen?: number,
): string {
  if (typeof value !== 'string') return fallback;
  return maxLen !== undefined && value.length > maxLen
    ? value.slice(0, maxLen)
    : value;
}

function sanitize(loaded: Partial<CheckoutSettings>): CheckoutSettings {
  const token: TokenSymbol =
    loaded.token === 'jpyc' || loaded.token === 'usdc'
      ? loaded.token
      : DEFAULT_SETTINGS.token;
  return {
    receiver: sanitizeOptionalString(loaded.receiver, DEFAULT_SETTINGS.receiver),
    token,
    chain: normalizeChainForToken(token, loaded.chain),
    gasMode:
      loaded.gasMode === 'customer' || loaded.gasMode === 'merchant'
        ? loaded.gasMode
        : DEFAULT_SETTINGS.gasMode,
    items: sanitizeItems(loaded.items),
    orderId: sanitizeOptionalString(loaded.orderId, '', 64),
    description: sanitizeOptionalString(loaded.description, '', 200),
    customerEmail: sanitizeOptionalString(loaded.customerEmail, '', 240),
    successUrl: sanitizeOptionalString(loaded.successUrl, ''),
    cancelUrl: sanitizeOptionalString(loaded.cancelUrl, ''),
    webhook: sanitizeOptionalString(loaded.webhook, ''),
  };
}

export function useCheckoutSettings() {
  const [settings, setSettings] = useState<CheckoutSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const loaded = safeGet<Partial<CheckoutSettings>>(STORAGE_KEY, {});
    setSettings(sanitize(loaded));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    safeSet(STORAGE_KEY, settings);
  }, [settings, hydrated]);

  return { settings, setSettings, hydrated };
}
