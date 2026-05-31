// READ-ONLY cross-chain codehash gate for the Circle Paymaster v0.8 (B1).
//
// 目的: 全 Circle 対応 chain で paymaster の on-chain bytecode を eth_getCode で取得し、
//   keccak256 を deployment class (mainnet-address / testnet-address) ごとに照合する。
//   class 内で全一致したら、その値が lib/circlePermit.ts CIRCLE_PAYMASTER_CODEHASH に
//   登録すべき codehash (= assertCirclePaymasterDeployed が enforce する値)。
//   一致しない class があれば登録しない (誤った codehash を enforce すると fail-closed で
//   Circle が止まるため)。鍵も資金も不要・純 read。
//
// 使い方: node scripts/verify-circle-codehash.mjs
//   (chain ごとに NEXT_PUBLIC_<X>_RPC_URL があれば優先、無ければ下記 public RPC)。

import { createPublicClient, http, keccak256, getAddress } from 'viem';

const MAINNET_PM = getAddress('0x0578cFB241215b77442a541325d6A4E6dFE700Ec');
const TESTNET_PM = getAddress('0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966');

// SoT: lib/circlePaymaster.ts CIRCLE_PAYMASTER_ADDRESSES と一致させること。
const CHAINS = [
  // class: mainnet-address
  { id: 1, name: 'ethereum', cls: 'mainnet', addr: MAINNET_PM, env: 'NEXT_PUBLIC_ETHEREUM_RPC_URL', rpc: 'https://ethereum-rpc.publicnode.com' },
  { id: 8453, name: 'base', cls: 'mainnet', addr: MAINNET_PM, env: 'NEXT_PUBLIC_BASE_RPC_URL', rpc: 'https://mainnet.base.org' },
  { id: 42161, name: 'arbitrum', cls: 'mainnet', addr: MAINNET_PM, env: 'NEXT_PUBLIC_ARBITRUM_RPC_URL', rpc: 'https://arb1.arbitrum.io/rpc' },
  { id: 10, name: 'optimism', cls: 'mainnet', addr: MAINNET_PM, env: 'NEXT_PUBLIC_OPTIMISM_RPC_URL', rpc: 'https://mainnet.optimism.io' },
  { id: 137, name: 'polygon', cls: 'mainnet', addr: MAINNET_PM, env: 'NEXT_PUBLIC_POLYGON_RPC_URL', rpc: 'https://polygon-rpc.com' },
  { id: 43114, name: 'avalanche', cls: 'mainnet', addr: MAINNET_PM, env: 'NEXT_PUBLIC_AVALANCHE_RPC_URL', rpc: 'https://api.avax.network/ext/bc/C/rpc' },
  { id: 130, name: 'unichain', cls: 'mainnet', addr: MAINNET_PM, env: 'NEXT_PUBLIC_UNICHAIN_RPC_URL', rpc: 'https://mainnet.unichain.org' },
  // class: testnet-address
  { id: 11155111, name: 'sepolia', cls: 'testnet', addr: TESTNET_PM, env: 'NEXT_PUBLIC_SEPOLIA_RPC_URL', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  { id: 84532, name: 'base-sepolia', cls: 'testnet', addr: TESTNET_PM, env: 'NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL', rpc: 'https://sepolia.base.org' },
  { id: 421614, name: 'arbitrum-sepolia', cls: 'testnet', addr: TESTNET_PM, env: 'NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  { id: 11155420, name: 'optimism-sepolia', cls: 'testnet', addr: TESTNET_PM, env: 'NEXT_PUBLIC_OPTIMISM_SEPOLIA_RPC_URL', rpc: 'https://sepolia.optimism.io' },
  { id: 80002, name: 'polygon-amoy', cls: 'testnet', addr: TESTNET_PM, env: 'NEXT_PUBLIC_POLYGON_AMOY_RPC_URL', rpc: 'https://rpc-amoy.polygon.technology' },
  { id: 43113, name: 'avalanche-fuji', cls: 'testnet', addr: TESTNET_PM, env: 'NEXT_PUBLIC_AVALANCHE_FUJI_RPC_URL', rpc: 'https://api.avax-test.network/ext/bc/C/rpc' },
  { id: 1301, name: 'unichain-sepolia', cls: 'testnet', addr: TESTNET_PM, env: 'NEXT_PUBLIC_UNICHAIN_SEPOLIA_RPC_URL', rpc: 'https://sepolia.unichain.org' },
];

const log = (...a) => console.log(...a);

async function codehashOf(entry) {
  const rpc = process.env[entry.env] || entry.rpc;
  const client = createPublicClient({ transport: http(rpc) });
  const code = await client.getCode({ address: entry.addr });
  // 非空を assert してから hash (Codex: empty code を hash しない)。
  if (!code || code === '0x' || code.length <= 2) {
    throw new Error(`empty code (EOA/未 deploy) at ${entry.addr}`);
  }
  return keccak256(code);
}

async function main() {
  log('Circle Paymaster v0.8 codehash 照合 (read-only)\n');
  const results = [];
  for (const e of CHAINS) {
    try {
      const hash = await codehashOf(e);
      log(`  ✓ ${e.name.padEnd(18)} (${e.id})  ${e.cls}  ${hash}`);
      results.push({ ...e, hash });
    } catch (err) {
      log(`  ✖ ${e.name.padEnd(18)} (${e.id})  ${e.cls}  取得失敗: ${err.shortMessage || err.message}`);
      results.push({ ...e, hash: null, error: err.shortMessage || err.message });
    }
  }

  log('\n── class 別の一致判定 ──');
  const summary = {};
  for (const cls of ['mainnet', 'testnet']) {
    const got = results.filter((r) => r.cls === cls && r.hash);
    const uniq = [...new Set(got.map((r) => r.hash))];
    const reached = got.map((r) => r.id);
    const missing = results.filter((r) => r.cls === cls && !r.hash).map((r) => r.id);
    const uniform = uniq.length === 1;
    summary[cls] = { uniform, hash: uniform ? uniq[0] : null, reached, missing, distinct: uniq };
    log(
      `  ${cls}: ${uniform ? '✅ 全一致' : '❌ 不一致 or 取得不足'} ` +
        `| reached=[${reached.join(',')}] missing=[${missing.join(',')}]` +
        (uniform ? `\n     codehash = ${uniq[0]}` : `\n     distinct = ${JSON.stringify(uniq)}`),
    );
  }

  log('\n── CIRCLE_PAYMASTER_CODEHASH 登録案 (class が全一致した chain のみ) ──');
  const entries = [];
  for (const r of results.filter((r) => r.hash)) {
    if (summary[r.cls].uniform) entries.push(`  [${r.id}]: '${r.hash}',`);
  }
  if (entries.length) {
    log('export const CIRCLE_PAYMASTER_CODEHASH: Readonly<Record<number, Hex>> = {');
    entries.forEach((l) => log(l));
    log('};');
  } else {
    log('(登録可能な chain なし — 全 class で取得不足 or 不一致。enforce しない。)');
  }

  // mainnet と testnet の codehash が同一かも参考表示 (同一 bytecode なら 1 値で全 chain 可)。
  if (summary.mainnet.hash && summary.testnet.hash) {
    log(
      `\n参考: mainnet と testnet の codehash は ${
        summary.mainnet.hash === summary.testnet.hash ? '同一' : '別'
      }。`,
    );
  }
}

main().catch((e) => {
  console.error('中断:', e.shortMessage || e.message);
  process.exitCode = 1;
});
