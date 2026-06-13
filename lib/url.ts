// URL builder/parser の barrel。実装は lib/url/ 配下の 4 モジュールに分割:
//   shared   — {pay, tip, checkout} の 2 つ以上で共有する基盤ヘルパ
//   pay      — /pay (決済 QR) + split
//   tip      — /tip/[address] (ERC20 / native の応援)
//   checkout — /checkout (line items + 注文 metadata)
// 公開 API は分割前と完全に同一 (`@/lib/url` からの import は全て不変)。
export * from './url/shared';
export * from './url/pay';
export * from './url/tip';
export * from './url/checkout';
