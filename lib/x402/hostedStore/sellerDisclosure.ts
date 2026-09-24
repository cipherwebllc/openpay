import 'server-only';

// 出品者の販売者情報 (特商法対応) の保存と読込 (R15a で lib/x402/hostedStore.ts から分割)。
// ⚠️ 外からは '@/lib/x402/hostedStore' (facade) 経由で import する (vi.mock の対象を 1 つに保つ)。

import { isAddress } from 'viem';
import { kvGet, kvSet } from '@/lib/kv';
import { UNSAFE_UNICODE_RE, sanitizeLine } from './model';

// ---------------------------------------------------------------------------
// 出品者の販売者情報 (特商法対応・Terms 第 13 条 (4))
//
// 反復継続の営利販売を行う出品者は特商法上の販売業者になり得る。表示義務は出品者が
// 負うため、OpenPay は「購入画面から参照できる販売者情報」の置き場と、**未登録なら
// 販売開始できない**という enforce の口を提供する (真偽の検証はしない・できない)。
// 保存先: x402:hosted:seller:<wallet>
// ---------------------------------------------------------------------------

export const MAX_SELLER_NAME_LEN = 60;
export const MAX_SELLER_CONTACT_LEN = 200;
export const MAX_SELLER_DISCLOSURE_LEN = 1000;

export type SellerDisclosure = {
  /** 氏名または名称 (必須)。 */
  name: string;
  /** 連絡先 (必須・メールアドレス等)。購入者からの連絡手段 (Terms 13 条 (7) の協力の実体)。 */
  contact: string;
  /**
   * 法定表示の自由記載 (任意)。販売業者に該当する出品者が住所・電話番号等の
   * 特商法上の必要事項を記載する欄。改行可。
   */
  disclosure?: string;
  updatedAt: number;
};

export function sellerDisclosureKey(wallet: string): string {
  return `x402:hosted:seller:${wallet.toLowerCase()}`;
}

export type ParsedSellerDisclosure =
  | { ok: true; value: Omit<SellerDisclosure, 'updatedAt'> }
  | { ok: false; error: string };

export function parseSellerDisclosureInput(input: {
  name: unknown;
  contact: unknown;
  disclosure?: unknown;
}): ParsedSellerDisclosure {
  const name = sanitizeLine(input.name, MAX_SELLER_NAME_LEN);
  if (!name) return { ok: false, error: 'invalid name' };
  const contact = sanitizeLine(input.contact, MAX_SELLER_CONTACT_LEN);
  if (!contact) return { ok: false, error: 'invalid contact' };
  let disclosure: string | undefined;
  if (input.disclosure !== undefined && input.disclosure !== null) {
    if (typeof input.disclosure !== 'string') {
      return { ok: false, error: 'invalid disclosure' };
    }
    const cleaned = [...input.disclosure.replace(/\r\n?/g, '\n')]
      .filter((ch) => ch === '\n' || !UNSAFE_UNICODE_RE.test(ch))
      .join('')
      .trim();
    const len = [...cleaned].length;
    if (len > MAX_SELLER_DISCLOSURE_LEN) {
      return { ok: false, error: 'disclosure too long' };
    }
    if (len > 0) disclosure = cleaned;
  }
  return { ok: true, value: { name, contact, ...(disclosure ? { disclosure } : {}) } };
}

export async function putSellerDisclosure(
  wallet: string,
  value: Omit<SellerDisclosure, 'updatedAt'>,
  now = Date.now(),
): Promise<boolean> {
  if (!isAddress(wallet)) return false;
  const record: SellerDisclosure = { ...value, updatedAt: now };
  const res = await kvSet(sellerDisclosureKey(wallet), JSON.stringify(record));
  return res.ok;
}

export async function getSellerDisclosure(
  wallet: string,
): Promise<SellerDisclosure | null | 'storage'> {
  if (!isAddress(wallet)) return null;
  const res = await kvGet(sellerDisclosureKey(wallet));
  if (!res.ok) return 'storage';
  if (res.value === null) return null;
  try {
    const raw = JSON.parse(res.value) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const name = sanitizeLine(r.name, MAX_SELLER_NAME_LEN);
    const contact = sanitizeLine(r.contact, MAX_SELLER_CONTACT_LEN);
    if (!name || !contact) return null;
    if (
      typeof r.updatedAt !== 'number' ||
      !Number.isSafeInteger(r.updatedAt)
    ) {
      return null;
    }
    return {
      name,
      contact,
      ...(typeof r.disclosure === 'string' && r.disclosure.trim()
        ? { disclosure: r.disclosure }
        : {}),
      updatedAt: r.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * 販売開始 (saleActive=true) の前提条件。**API 層 (trust boundary) がこれを enforce する**
 * 契約: 未登録 (null) なら販売開始を拒否し、'storage' なら 503 に倒す (黙って許可しない)。
 */
export async function sellerDisclosureComplete(
  wallet: string,
): Promise<boolean | 'storage'> {
  const d = await getSellerDisclosure(wallet);
  if (d === 'storage') return 'storage';
  return d !== null;
}
