#!/usr/bin/env node
// 自前 JPYC EIP-3009 リレイヤー専用の使い捨て EOA を生成する。
//
// この鍵が持つのはガス (POL) だけ。顧客が署名済みの transferWithAuthorization を中継する
// だけで顧客資金は動かせない (from/to/value は顧客署名済) ため、漏洩時の被害は relayer の
// POL 残高に限定される。それでも鍵は鍵: 出力した RELAYER_PRIVATE_KEY は .env.local /
// Vercel 環境変数にのみ保存し、チャット・コミット・スクショに残さないこと。
//
// 使い方:  node scripts/relayer-wallet.mjs

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

console.log('');
console.log('  Relayer EOA address :', account.address);
console.log('  RELAYER_PRIVATE_KEY :', pk);
console.log('');
console.log('  次の手順:');
console.log(
  '   1. RELAYER_PRIVATE_KEY を .env.local / Vercel 環境変数に設定 (NEXT_PUBLIC_ は付けない)',
);
console.log(
  '   2. 上記 address に POL を送金 (Amoy は faucet で無料 / 本番 Polygon は $1-2 相当で数千件)',
);
console.log(
  '   3. この秘密鍵はチャット・git に残さないこと (ガス専用・低リスクだが鍵は鍵)',
);
console.log('');
