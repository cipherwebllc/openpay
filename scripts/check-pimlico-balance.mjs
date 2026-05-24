#!/usr/bin/env node
// Pimlico Sponsorship Paymaster の残高監視。EntryPoint v0.7 の balanceOf
// で各チェーンの paymaster deposit を読み、しきい値以下なら Slack/Discord
// 互換 webhook (POST {text}) に通知する。GitHub Actions cron で 6h 毎実行。
// 必須/任意 env は main() の env 検証で自己文書化されている。
//
// chain 追加手順:
// 1. CHAIN_CONFIGS に entry を追加 (slug, viem chain, env 名、default 値、required)
// 2. .github/workflows/pimlico-balance.yml の `env:` block に secret を追加
// 3. README "Pimlico 残高アラート設定手順" に新 chain の secret 名を追記
// 4. tests/scripts/check-pimlico-balance.test.ts に当該 chain の case を追加

import {
  createPublicClient,
  http,
  formatEther,
  parseEther,
  getAddress,
} from 'viem';
import { base, kaia, polygon } from 'viem/chains';

// EntryPoint v0.7 (ERC-4337) は全チェーン共通の deterministic アドレス
const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

const ENTRY_POINT_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// chain ごとの設定を data として宣言。新 chain 追加は本 array に entry を足す
// だけ (run-loop 側は触らない)。各 chain の native token と paymaster 用 env
// 名がここで一元管理される。
//
// required:
//   - true:  workflow が secret 未設定で fail (operator が必ず設定すべき chain)
//   - false: secret 未設定で skip (operator が opt-in する chain)
//
// thresholdDefault は本番運用想定の保守的下限:
//   - POL 5    ≈ ¥100 (1000 sponsorship 程度の予備、POL は ¥20/native default rate)
//   - ETH 0.01 ≈ ¥230 (L2 は cheap、~100k sponsorship 分)
//   - KAIA 5   ≈ ¥40  (2026-05-23 実勢 ¥8.21/KAIA、~800 sponsorship 分)
export const CHAIN_CONFIGS = [
  {
    slug: 'polygon',
    chain: polygon,
    rpcEnv: 'POLYGON_RPC_URL',
    // 旧 default polygon-rpc.com は 2026-05 頃から "API key disabled" で
    // public 利用不能化、認証 RPC のみに移行。代替で PublicNode 公式の
    // polygon-bor-rpc.publicnode.com を使う (無認証 / 公開維持の commitment)。
    // operator が Alchemy/Infura 等を持っていれば POLYGON_RPC_URL secret で override 推奨。
    rpcDefault: 'https://polygon-bor-rpc.publicnode.com',
    paymasterEnv: 'PIMLICO_PAYMASTER_POLYGON',
    thresholdEnv: 'ALERT_THRESHOLD_POL',
    thresholdDefault: '5',
    nativeSymbol: 'POL',
    required: true,
  },
  {
    slug: 'base',
    chain: base,
    rpcEnv: 'BASE_RPC_URL',
    rpcDefault: 'https://mainnet.base.org',
    paymasterEnv: 'PIMLICO_PAYMASTER_BASE',
    thresholdEnv: 'ALERT_THRESHOLD_ETH',
    thresholdDefault: '0.01',
    nativeSymbol: 'ETH',
    required: true,
  },
  {
    slug: 'kaia',
    chain: kaia,
    rpcEnv: 'KAIA_RPC_URL',
    rpcDefault: 'https://public-en.node.kaia.io',
    paymasterEnv: 'PIMLICO_PAYMASTER_KAIA',
    thresholdEnv: 'ALERT_THRESHOLD_KAIA',
    thresholdDefault: '5',
    nativeSymbol: 'KAIA',
    // 2026-05-23 Kaia 投入直後、operator が paymaster address を取得 + secret
    // 設定するまで graceful skip。Polygon/Base しか使わない既存 operator の
    // workflow が壊れないよう required=false。
    required: false,
  },
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`環境変数 ${name} が未設定です`);
  }
  return v;
}

async function getBalance(chain, rpcUrl, paymasterAddress) {
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  const balance = await client.readContract({
    address: ENTRY_POINT_V07,
    abi: ENTRY_POINT_ABI,
    functionName: 'balanceOf',
    args: [getAddress(paymasterAddress)],
  });
  return balance;
}

async function notify(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text }),
  });
  if (!res.ok) {
    throw new Error(`webhook POST 失敗: ${res.status} ${res.statusText}`);
  }
}

// 各 chain 設定から実行 plan を組み立てる:
//   - required=true で secret 未設定 → throw (workflow fail)
//   - required=false で secret 未設定 → null (skip)
//   - secret 設定済 → { config, paymasterAddress, rpcUrl, threshold }
function resolveTargets(configs) {
  return configs
    .map((c) => {
      const paymaster = process.env[c.paymasterEnv];
      if (!paymaster || paymaster.length === 0) {
        if (c.required) {
          throw new Error(`環境変数 ${c.paymasterEnv} が未設定です`);
        }
        return null;
      }
      // GH Actions Variables 未設定時は env var が空文字列 '' になり、`??` では
      // 非 nullish と判定されて default に倒れない (= parseEther('') が 0n、
      // しきい値 0 で alert 機能停止)。空文字 / undefined / null 全部を default に
      // 倒すため明示的に length check する。
      const rpcRaw = process.env[c.rpcEnv];
      const rpcUrl = rpcRaw && rpcRaw.length > 0 ? rpcRaw : c.rpcDefault;
      const thresholdRaw = process.env[c.thresholdEnv];
      const thresholdStr =
        thresholdRaw && thresholdRaw.length > 0
          ? thresholdRaw
          : c.thresholdDefault;
      return {
        config: c,
        paymasterAddress: paymaster,
        rpcUrl,
        threshold: parseEther(thresholdStr),
      };
    })
    .filter((t) => t !== null);
}

export async function runBalanceCheck({
  configs = CHAIN_CONFIGS,
  webhookUrl,
  logger = console,
} = {}) {
  const targets = resolveTargets(configs);

  const balances = await Promise.all(
    targets.map((t) => getBalance(t.config.chain, t.rpcUrl, t.paymasterAddress)),
  );

  const lines = ['Pimlico Sponsorship Paymaster 残高:'];
  const alerts = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const balance = balances[i];
    const display = `${formatEther(balance)} ${t.config.nativeSymbol}`;
    const limit = `${formatEther(t.threshold)} ${t.config.nativeSymbol}`;
    lines.push(`- ${t.config.chain.name}: ${display} (しきい値 ${limit})`);

    if (balance < t.threshold) {
      alerts.push(
        `⚠️ ${t.config.chain.name} の Pimlico 残高 ${display} が ` +
          `しきい値 ${limit} を下回っています。デポジット必要。`,
      );
    }
  }

  logger.log(lines.join('\n'));

  if (alerts.length > 0) {
    const message = [
      '🚨 OpenPay Pimlico 残高アラート',
      ...alerts,
      '',
      ...lines,
    ].join('\n');
    await notify(webhookUrl, message);
    logger.error('アラート送信済み');
    return { breached: true, message, lines, alerts };
  }

  logger.log('✅ 残高は十分です');
  return { breached: false, message: null, lines, alerts };
}

// CLI entry — vitest からは import 時に main() が走らないようにガード。
// `import.meta.url === \`file://${process.argv[1]}\`` 比較が node CLI 標準パターン。
const isCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  const webhookUrl = requireEnv('ALERT_WEBHOOK_URL');
  const result = await runBalanceCheck({ webhookUrl });
  if (result.breached) {
    process.exit(1);
  }
}
