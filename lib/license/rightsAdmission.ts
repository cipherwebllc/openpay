// 権利照合 RPC の同時実行枠 (第 7 回レビュー B9) の抽象。KV を持たない純粋 module なので、枠の実体
// (lib/license/rightsBudget.ts) を mock したテストからもそのまま使える。
export type LicenseRightsAdmission = {
  acquire(): Promise<string | null>;
  release(token: string): Promise<void>;
};

/**
 * 1 request (ページ) 1 枠。最初の acquire で実体の枠を 1 回だけ取り、以降の acquire は同じ lease を返す。
 * 項目ごとの release は何もしない (ページ全体で持つ・各項目は直列なので同時 RPC は枠数を超えない) で、
 * close が実体へ返す。最初の取得が失敗 (null) したら、そのページでは取り直さない。
 */
export function pageScopedLicenseRightsAdmission(base: LicenseRightsAdmission): {
  admission: LicenseRightsAdmission;
  close(): Promise<void>;
} {
  let lease: string | null | undefined;
  return {
    admission: {
      acquire: async () => {
        if (lease === undefined) lease = await base.acquire();
        return lease;
      },
      release: async () => {},
    },
    close: async () => {
      if (!lease) return;
      const held = lease;
      lease = null;
      await base.release(held);
    },
  };
}
