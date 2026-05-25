'use client';

// items は draft 状態 (空欄含む文字列ペア) で保存し、URL 生成時に parseCheckoutItemDrafts
// で CheckoutItem[] へ昇格させる (all-or-nothing、parseSplitDrafts と同型)。

import type { ChainSlug } from '@/lib/chains';
import type { GasMode, PayMode } from '@/lib/fee';
import {
  deploymentForSlug,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
import { CHECKOUT_MAX_ITEMS, type CheckoutItemDraft } from '@/lib/url';
import { useLocalStorageSettings } from './useLocalStorageSettings';
import { normalizeChainForToken, sanitizeTokenSymbol } from './useQrSettings';

type CheckoutSettings = {
  receiver: string;
  token: TokenSymbol;
  chain: ChainSlug;
  gasMode: GasMode;
  // 決済モード (QrSettings.payMode と同義)。standard 時は gasMode 無視。
  payMode: PayMode;
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
  token: 'jpyc',
  chain: 'polygon',
  gasMode: 'customer',
  payMode: 'gasless',
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
  const token = sanitizeTokenSymbol(loaded.token, DEFAULT_SETTINGS.token);
  const chain = normalizeChainForToken(token, loaded.chain);
  // gasless 非対応 chain (paymasterMode=unavailable) + payMode=gasless が saved
  // 状態として残っていたら standard に migrate。/checkout URL parser が同組合せを
  // reject するため、UI と URL の意味論を一致させる。
  const rawPayMode: PayMode =
    loaded.payMode === 'gasless' || loaded.payMode === 'standard'
      ? loaded.payMode
      : DEFAULT_SETTINGS.payMode;
  const payMode: PayMode =
    rawPayMode === 'gasless' && !isGaslessSupported(deploymentForSlug(token, chain))
      ? 'standard'
      : rawPayMode;
  return {
    receiver: sanitizeOptionalString(loaded.receiver, DEFAULT_SETTINGS.receiver),
    token,
    chain,
    gasMode:
      loaded.gasMode === 'customer' || loaded.gasMode === 'merchant'
        ? loaded.gasMode
        : DEFAULT_SETTINGS.gasMode,
    payMode,
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
  return useLocalStorageSettings<CheckoutSettings>(
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    sanitize,
  );
}
