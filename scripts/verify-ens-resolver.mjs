#!/usr/bin/env node
// mainnet ENS Universal Resolver の到達可能性と CCIP-Read 経由の Basenames
// 解決が壊れていないことを smoke check する。dependency 更新前後の deploy
// gate に使う。
//
// 実行: node scripts/verify-ens-resolver.mjs [mainnet_rpc_url]
//
// 検証項目:
//   1. mainnet 上に ensUniversalResolver の bytecode が存在 (eth_getCode)
//   2. vitalik.eth (.eth) が address に解決される
//   3. jesse.base.eth (.base.eth) が CCIP-Read 経由で address に解決される
//
// いずれかが失敗したら exit code 1。CI 等で `node scripts/...` を直接
// 呼べる stand-alone script として置く (vitest を経由しない実 RPC 検証)。

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

const RPC = process.argv[2] ?? 'https://ethereum-rpc.publicnode.com';
const UR_ADDRESS = mainnet.contracts?.ensUniversalResolver?.address;

if (!UR_ADDRESS) {
  console.error('FAIL: viem mainnet.contracts.ensUniversalResolver 未定義');
  process.exit(1);
}

const client = createPublicClient({ chain: mainnet, transport: http(RPC) });

console.log(`mainnet ENS Universal Resolver: ${UR_ADDRESS}`);
console.log(`RPC: ${RPC}`);

// 1) bytecode 存在確認
const code = await client.getBytecode({ address: UR_ADDRESS });
const codeBytes = code ? (code.length - 2) / 2 : 0;
console.log(`[1] bytecode: ${codeBytes} bytes`);
if (codeBytes === 0) {
  console.error(`FAIL: ${UR_ADDRESS} に bytecode がありません`);
  process.exit(1);
}

// 2) .eth resolution
const VITALIK_EXPECTED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const vitalikAddr = await client.getEnsAddress({ name: normalize('vitalik.eth') });
console.log(`[2] vitalik.eth -> ${vitalikAddr}`);
if (vitalikAddr?.toLowerCase() !== VITALIK_EXPECTED.toLowerCase()) {
  console.error(`FAIL: vitalik.eth が期待値と一致しません (期待: ${VITALIK_EXPECTED})`);
  process.exit(1);
}

// 3) .base.eth resolution via CCIP-Read
const JESSE_EXPECTED = '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9';
const jesseAddr = await client.getEnsAddress({ name: normalize('jesse.base.eth') });
console.log(`[3] jesse.base.eth -> ${jesseAddr} (CCIP-Read 経由)`);
if (jesseAddr?.toLowerCase() !== JESSE_EXPECTED.toLowerCase()) {
  console.error(`FAIL: jesse.base.eth が期待値と一致しません (期待: ${JESSE_EXPECTED})`);
  console.error('       Basenames CCIP-Read gateway が落ちているか、record が変更された可能性');
  process.exit(1);
}

console.log('\n✓ All checks passed: ENS UR + Basenames CCIP-Read 動作確認');
