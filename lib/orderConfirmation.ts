// 注文リンクの「確認の署名」: お客様が払ったウォレットで、決まった文 (チェーン・お店・Tx Hash) に署名する
// (personal_sign・お金は動かない)。お店は「入金を確かめる」で同じ文を組み立て、署名した人がその支払いをした
// ウォレットかを確かめる。Tx Hash は誰でも Explorer で見られるので、Tx Hash だけでは払った人の証明にならない
// (他人の支払いの Tx Hash を貼って自分の住所へ送らせる手口を止める・plans/order-link-reusable.md)。
// 署名が示すのは「払ったウォレットの持ち主が、このお店へのこの支払いについて署名した」ことだけ。文は転送できるので、
// 送ってきた人やお届け先が正しいことは示さない (送り先を書き換えたリンクで文を集めて転送する手口は、リンクの書き換え
// 全般と同じく、お店のリンクを公式の場所に置くことで防ぐ・2026-11-03 Codex P1 を限界として受け入れ)。

import {
  compactSignatureToSignature,
  getAddress,
  parseCompactSignature,
  serializeSignature,
  type Address,
  type Hex,
} from 'viem';
import type { ChainSlug } from './chains';

/**
 * 署名する文。言語によらず固定 (お客様とお店で表示の言語が違っても同じ文になる)。
 * 区切りは \n・末尾に改行なし・shop は checksum・tx は小文字 (tests/lib/orderConfirmation.test.ts が固定)。
 */
export function orderConfirmationMessage(input: { chain: ChainSlug; shop: Address; txHash: string }): string {
  return [
    'OpenPay order confirmation',
    `chain: ${input.chain}`,
    `shop: ${getAddress(input.shop)}`,
    `tx: ${input.txHash.toLowerCase()}`,
  ].join('\n');
}

// 64 バイト以上の 16 進 (EOA の署名は 65 バイト・短縮形 (EIP-2098) は 64 バイト・コントラクトのウォレットは長いことが
// ある)。Tx Hash (32 バイト) とは長さで分かれる。前後が 16 進の続きなら取らない。
const SIGNATURE = /(?<![0-9a-fA-Fx])0x(?:[0-9a-fA-F]{2}){64,}(?![0-9a-fA-F])/;

/**
 * ecrecover に渡す形にする。短縮形 (EIP-2098・64 バイト) は 65 バイトに広げる (viem は 64 バイトのままでは読まない)。
 * コントラクトのウォレットの確認 (ERC-1271) には元のバイト列をそのまま渡す。
 */
export function recoverableSignature(signature: Hex): Hex {
  if (signature.length !== 2 + 128) return signature;
  try {
    return serializeSignature(compactSignatureToSignature(parseCompactSignature(signature)));
  } catch {
    return signature;
  }
}

/** 貼られた文から確認の署名を取り出す (無ければ null)。 */
export function extractConfirmationSignature(text: string): Hex | null {
  const match = SIGNATURE.exec(text);
  return match ? (match[0].toLowerCase() as Hex) : null;
}

// お客様の完了画面: 署名をこのタブに残す。ウォレットのアプリへ切り替えて戻ると画面が読み直されることがあり、
// そのたびに署名を求めないため (sessionStorage・タブを閉じれば消える)。大きな完了画面と下の欄で同じ署名を使う。
// 鍵は署名した文と同じ (チェーン・お店・Tx Hash): 別のお店やチェーンの同じ Tx Hash に使い回さない。
const STORAGE_PREFIX = 'openpay:order-confirmation:v2:';
const memory = new Map<string, Hex>();
const listeners = new Set<() => void>();

type SignedPayment = { chain: ChainSlug; shop: Address; txHash: string };

function storageKey(input: SignedPayment): string {
  return `${STORAGE_PREFIX}${input.chain}:${input.shop.toLowerCase()}:${input.txHash.toLowerCase()}`;
}

/** このタブで前に作った確認の署名 (無ければ null)。sessionStorage が使えなくても、このページの間は覚える。 */
export function storedConfirmationSignature(input: SignedPayment): Hex | null {
  const key = storageKey(input);
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw && extractConfirmationSignature(raw) === raw) {
      memory.set(key, raw as Hex);
      return raw as Hex;
    }
  } catch {
    // プライベートモード等で読めない: このページの間の記憶だけで続ける (送る機能そのものは止めない・掟 13)。
  }
  return null;
}

export function storeConfirmationSignature(input: SignedPayment, signature: Hex): void {
  const key = storageKey(input);
  const value = signature.toLowerCase() as Hex;
  memory.set(key, value);
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 満杯・使えない: 読み直したときにもう一度署名を求めるだけ (掟 13)。
  }
  for (const listener of listeners) listener();
}

export function subscribeConfirmationSignatures(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 遠隔の注文の支払いを、この会計 (URL の中身から作る checkoutContextKey) ごとにタブに残す。払った後に画面が読み直されると
// (ウォレットのアプリから戻ったとき等) 支払いの完了の記録は消えるので、その後も「注文を送る」を出せるようにする
// (2026-11-03 Codex P2)。別の会計の Tx Hash を混ぜないよう、鍵は会計の中身そのもの。表示と送る文にだけ使い、
// 履歴や控えは作らない。古い記録 (1 日より前) は使わない。
const PAID_PREFIX = 'openpay:order-paid:v1:';
const PAID_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TX_HASH_ONLY = /^0x[0-9a-f]{64}$/;
const ADDRESS_ONLY = /^0x[0-9a-fA-F]{40}$/;

export type RememberedOrderPayment = { txHash: string; payer?: Address; paidAt: number };

export function rememberOrderPayment(contextKey: string, payment: RememberedOrderPayment): void {
  try {
    window.sessionStorage.setItem(`${PAID_PREFIX}${contextKey}`, JSON.stringify(payment));
  } catch {
    // 使えない: 読み直した後に「注文を送る」を出せないだけ (完了画面の間は送れる・掟 13)。
  }
}

export function rememberedOrderPayment(contextKey: string, now: number): RememberedOrderPayment | null {
  try {
    const raw = window.sessionStorage.getItem(`${PAID_PREFIX}${contextKey}`);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const { txHash, payer, paidAt } = value as Record<string, unknown>;
    if (typeof txHash !== 'string' || !TX_HASH_ONLY.test(txHash)) return null;
    if (typeof paidAt !== 'number' || now - paidAt > PAID_MAX_AGE_MS || paidAt > now) return null;
    return {
      txHash,
      ...(typeof payer === 'string' && ADDRESS_ONLY.test(payer) ? { payer: payer as Address } : {}),
      paidAt,
    };
  } catch {
    // 読めない・壊れた記録: 出さない (会計の画面そのものは止めない・掟 13)。
    return null;
  }
}
