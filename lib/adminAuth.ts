// 運営 (OpenPay 自社) 専用 admin 機能の認可。SIWE で識別した wallet が許可リストに載っているかを判定する。
// 許可リストは env ADMIN_WALLETS (カンマ区切り・小文字/checksum どちらでも可)。**空/未設定 = 全拒否 (fail-closed)**。
// server 専用 (process.env を読む)。client へは露出しない (NEXT_PUBLIC を付けない)。
// 設計: docs/plans/admin-billing-revenue.md。
//
// 運営の API は isAdminSession を使う (2026-11-25 外部レビュー #1): 許可リストのアドレスであることに加え、セッションが
// 鍵の署名 (EOA) で作られたものに限る。スマートウォレットの署名は、署名を確かめたチェーンでしか持ち主と言えず、別の
// チェーンで同じアドレスを別の人が持てる種類があるため。署名の種類の無い古いセッション (この変更の前のもの) も通さない
// = 運営者はサインインし直す。
import type { SessionSigner } from '@/lib/siwe';

function adminWalletSet(): Set<string> {
  const raw = process.env.ADMIN_WALLETS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/** address が admin 許可リストに含まれるか。許可リスト未設定なら false (fail-closed)。 */
export function isAdminWallet(address: string): boolean {
  const set = adminWalletSet();
  if (set.size === 0) return false;
  return set.has(address.toLowerCase());
}

/** 運営の API の認可: 許可リストのアドレスで、かつ鍵の署名 (EOA) で作ったセッションか。 */
export function isAdminSession(session: { address: string; signer?: SessionSigner }): boolean {
  return session.signer === 'eoa' && isAdminWallet(session.address);
}
