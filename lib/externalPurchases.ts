// /transparency 「9. 外部からの実購入 (オンチェーン記録)」の単一情報源。
// 出典 = 受取ウォレット宛の ERC-20 着金 (Base: Alchemy asset transfers・2026-09-11 集計)。
// 掟: 自社・関係者ウォレット (FIRST_PARTY_WALLETS) の動作確認決済は載せない (8. 実績の数え方と同じ)。
// 週次更新で末尾に追記する (日付昇順)。金額は表示価格の実払い額。商品名は精算記録 (KV) が要るので載せない。
// 一部はインデクサー (x402scan / x402 List 等) の検証購入の可能性があるが、第三者が実 USDC を払い
// 精算された事実に変わりはないので区別しない (推測を書かない)。

export type ExternalPurchase = {
  readonly chain: 'base';
  /** UTC 日付 (ブロックタイムスタンプ)。 */
  readonly date: string;
  /** 表示価格どおりの実払い額 (USDC)。 */
  readonly amount: string;
  readonly asset: 'USDC';
  /** 買い手ウォレット (checksum)。表示は先頭 6 桁 + 末尾 4 桁に短縮する。 */
  readonly payer: string;
  /** settle tx hash (Basescan で検証可能)。 */
  readonly tx: string;
};

/** 自社・関係者ウォレット (小文字)。ここに載る payer は EXTERNAL_PURCHASES に入れてはいけない (テストで固定)。 */
export const FIRST_PARTY_WALLETS: readonly string[] = [
  '0x9a76ea8fc0b9f34d34b91d453f2940932c9a7fe0', // テスト買い手 / license minter
  '0x8f16ef365676c405c739175fe7a11343e864343b', // 運営者個人 (テスト兼用)
  '0xda33e4cee3f06b19b174e299a36fcd075f0f9674', // テストネット使い捨て (mainnet でも動作確認に使用)
  '0x52d4901142e2b5680027da5eb47c86cb02a3ca81', // 受取ウォレット
  '0x428483fba62edcef1e3a100d3799f6d71759c560', // 手数料受取
];

/** 集計時点 (週次更新で進める)。 */
export const EXTERNAL_PURCHASES_AS_OF = '2026-09-11';

export const EXTERNAL_PURCHASES: readonly ExternalPurchase[] = [
  { chain: 'base', date: '2026-07-19', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0xdea66bfcd77d7c439774b344b64b5750b111b71a3fb23eaee6c24a6947eeed53' },
  { chain: 'base', date: '2026-07-20', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0x5deb902b5a0687731156f8af96589d9d5942d1b90237910c55761b02add50e70' },
  { chain: 'base', date: '2026-07-21', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0x99368e59f491e4e715578a693cefdc2b61235604c506b692bad008e561b17d3e' },
  { chain: 'base', date: '2026-07-22', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0xe19618bd3a4ac7371ffa911276b5459f1bd8adf982dc0ac53ba1c6fa728a74e7' },
  { chain: 'base', date: '2026-07-23', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0xa016f5310bf3d85711ff92de3c9ab68e12f8a9bc1bd902ef301fcb6a5db0d1d6' },
  { chain: 'base', date: '2026-07-25', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0x8205d19b163c45cbad88906eb7fa53175b08934ee181ef0b55d72f355ea53f4c' },
  { chain: 'base', date: '2026-07-26', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0x6c2a958cb690acbe8d26672916d29ca29e433a887cf62a8b2577f11b71523f1d' },
  { chain: 'base', date: '2026-07-29', amount: '0.01', asset: 'USDC', payer: '0xb83e6924ff53d2a7ef33a3e6906617f9f03f3808', tx: '0x4d9591f58899a88c99ae8576344a59d21dcf08d7e3ec52a12165e401656d6e4f' },
  { chain: 'base', date: '2026-07-30', amount: '0.01', asset: 'USDC', payer: '0xcd513d2e063177caa937d70b4d87603a9a4946a9', tx: '0x3fa561d63e65a9b63629a8062b7e201618e5096f783ace8e7e8e2f70768f5245' },
  { chain: 'base', date: '2026-08-02', amount: '0.01', asset: 'USDC', payer: '0x6292da4f70d194e0a857eb3772185ae4feaedef1', tx: '0x9447e1c521744c65a9368972dfaf318deb3687c8d805b79026742e46529e66f0' },
  { chain: 'base', date: '2026-08-03', amount: '0.01', asset: 'USDC', payer: '0x3d09e5b237a82bea77bdc01fbc2a28fec8cb7e00', tx: '0x2ceb989ae5405b26760e6496cb795d2c35d7859fab92c2dea301d6397dffea69' },
  { chain: 'base', date: '2026-08-17', amount: '0.01', asset: 'USDC', payer: '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', tx: '0xe117702d839f278f02c856586f5fa5445d4cb301e63799c2eaee085baaf9d38d' },
  { chain: 'base', date: '2026-08-18', amount: '0.01', asset: 'USDC', payer: '0x843b544bf5f0aa6cbf13e94563874878c98cc4a7', tx: '0x54581417c874f14a52cb8cd15366dd8fe6722c555859e59a38f4da8d5da796d0' },
  { chain: 'base', date: '2026-08-23', amount: '0.01', asset: 'USDC', payer: '0xc59e74ed6386b2a12d892fff2509a6965a0498dc', tx: '0xfd7b1d145d187ea1e9232e057da3d1000ecfa38171f5392c4f9b0c9f40cf68ac' },
  { chain: 'base', date: '2026-08-26', amount: '0.01', asset: 'USDC', payer: '0xc59e74ed6386b2a12d892fff2509a6965a0498dc', tx: '0xb931b201c088ebc7fafaa56b8f4c16d5c203f71e21db183ce5b76c7fa331e001' },
  { chain: 'base', date: '2026-08-26', amount: '0.006', asset: 'USDC', payer: '0xc59e74ed6386b2a12d892fff2509a6965a0498dc', tx: '0x3e1648447a886ff5a9de1cc5069374bc91c31a1d07dfc57e25ecc9eca32c073a' },
  { chain: 'base', date: '2026-08-30', amount: '0.01', asset: 'USDC', payer: '0xc533bf5268a2f64adde58dce380651f70aa92d7a', tx: '0xf479892bf4877038448afaf0230c7fa345fefb04dbe484c29c90d80fc37fefd3' },
  { chain: 'base', date: '2026-09-04', amount: '0.01', asset: 'USDC', payer: '0x6777e11fb0a7917b8110b7dab9188aa3f6d23986', tx: '0x30fd7ea5e743e820bf73fdf32543e2865162e498f78f1460c3ae97d4f189a8ba' },
  { chain: 'base', date: '2026-09-04', amount: '0.006', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0xc99eefefbe9f46fbcb5ebc8ea1bf371675c345cbfc08063110231d4aae92cf34' },
  { chain: 'base', date: '2026-09-08', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0x853992261cdb710da57510f7afe0d391d8f54d9e09c5faab41fbc24bbee0e526' },
];

export function externalPurchaseSummary(rows: readonly ExternalPurchase[] = EXTERNAL_PURCHASES): {
  buyers: number; settlements: number; first: string | null; last: string | null;
} {
  const buyers = new Set(rows.map((r) => r.payer.toLowerCase())).size;
  const dates = rows.map((r) => r.date).sort();
  return { buyers, settlements: rows.length, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null };
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function basescanTxUrl(tx: string): string {
  return `https://basescan.org/tx/${tx}`;
}
