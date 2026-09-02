#!/usr/bin/env node
// 自前 JPYC EIP-3009 リレイヤー専用の使い捨て EOA を生成する。
//
// この鍵が持つのはガス (POL) だけ。顧客が署名済みの transferWithAuthorization を中継する
// だけで顧客資金は動かせない (from/to/value は顧客署名済) ため、漏洩時の被害は relayer の
// POL 残高に限定される。それでも鍵は鍵: **stdout には出さず** 0600 のファイルに書き出す。
// 書き出したファイルは .env.local / Vercel 環境変数へ移したら削除すること。
//
// 使い方:  node scripts/relayer-wallet.mjs        (出力先は既定 ./relayer-key.<timestamp>.txt)
//          KEY_OUT=/path/to/key.txt node scripts/relayer-wallet.mjs

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeGeneratedKey } from './lib/write-generated-key.mjs';

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
let path;
try {
  ({ path } = writeGeneratedKey(pk, 'relayer', { ADDRESS: account.address }));
} catch (err) {
  // 書き出しに失敗した鍵は使えない。stack ではなく理由だけ出して止める
  // (フォールバックで stdout に鍵を出すことは絶対にしない)。
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log('');
console.log('  Relayer EOA address :', account.address);
console.log('  秘密鍵の書き出し先  :', path, '(mode 0600・stdout には出しません)');
console.log('');
console.log('  次の手順:');
console.log(
  '   1. 上記ファイルの PRIVATE_KEY を RELAYER_PRIVATE_KEY として .env.local / Vercel 環境変数に設定 (NEXT_PUBLIC_ は付けない)',
);
console.log(
  '   2. 上記 address に POL を送金 (Amoy は faucet で無料 / 本番 Polygon は $1-2 相当で数千件)',
);
console.log(
  '   3. env へ移したら書き出しファイルを削除する (チャット・git に残さないこと)',
);
console.log('');
