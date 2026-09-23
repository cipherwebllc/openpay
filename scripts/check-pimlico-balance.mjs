#!/usr/bin/env node
// EntryPoint 0.7/0.8 の balanceOf(paymaster) を読む。0.7 の既存監視は維持し、
// 0.8 は ALERT_THRESHOLD_<TOKEN>_V08 設定時のみ通知対象にする (未設定は参照のみ)。
// 通知対象の deposit がしきい値未満なら Slack/Discord
// 互換 webhook (POST {text}) に通知する。GitHub Actions cron で 6h 毎実行。
// 必須/任意 env は main() の env 検証で自己文書化されている。
//
// chain 追加手順:
// 1. CHAIN_CONFIGS に entry を追加 (slug, viem chain, env 名、default 値、required)
// 2. .github/workflows/pimlico-balance.yml の `env:` block に secret を追加
// 3. README "Pimlico balance alerts" に新 chain の secret 名を追記
// 4. tests/scripts/check-pimlico-balance.test.ts に当該 chain の case を追加

import {
  createPublicClient,
  http,
  formatEther,
  parseEther,
  getAddress,
} from 'viem';
import { base, kaia, polygon } from 'viem/chains';
import { entryPoint07Address, entryPoint08Address } from 'viem/account-abstraction';

// simpleAccount=0.8、metamask/mav2=0.7。0.8 のアラートは版別しきい値で明示 opt-in。
const ENTRY_POINTS = [
  { version: '0.7', address: entryPoint07Address, envSuffix: '' },
  { version: '0.8', address: entryPoint08Address, envSuffix: '_V08' },
];

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

async function getBalance(chain, rpcUrl, paymasterAddress, entryPointAddress) {
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  const balance = await client.readContract({
    address: entryPointAddress,
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

// chain の選択・必須 env・0.7 のしきい値は既存運用のまま。
// 0.8 は同じ paymaster の deposit も参照する (_V08 でアドレス上書き可)。
// その deposit を使用中とは推定せず、版別しきい値がなければ通知しない。
function resolveTargets(configs) {
  return configs.flatMap((c) => {
    const paymaster = process.env[c.paymasterEnv];
    if (!paymaster) {
      if (c.required) throw new Error(`環境変数 ${c.paymasterEnv} が未設定です`);
      return [];
    }
    const rpcUrl = process.env[c.rpcEnv] || c.rpcDefault;
    return ENTRY_POINTS.map((entryPoint) => {
      const thresholdRaw = process.env[`${c.thresholdEnv}${entryPoint.envSuffix}`];
      // Actions の未設定値は空文字。0.7 の既存 default を維持し、0.8 は通知対象外にする。
      // 未設定の 0.8 deposit を残高枯渇扱いして既存監視へ誤通知を波及させない。
      const threshold = thresholdRaw
        ? parseEther(thresholdRaw)
        : entryPoint.version === '0.7' ? parseEther(c.thresholdDefault) : null;
      return {
        config: c,
        paymasterAddress: process.env[`${c.paymasterEnv}${entryPoint.envSuffix}`] || paymaster,
        entryPoint,
        rpcUrl,
        threshold,
      };
    });
  });
}

export async function runBalanceCheck({
  configs = CHAIN_CONFIGS,
  webhookUrl,
  logger = console,
} = {}) {
  const targets = resolveTargets(configs);
  for (const t of targets) {
    if (t.threshold === null) {
      logger.log(`::warning::${t.config.chain.name} (EntryPoint 0.8): ${t.config.thresholdEnv}_V08 未設定。残高は参照のみ・通知対象外。`);
    }
  }

  // allSettled: 1 chain の RPC 障害が他 chain のアラートを巻き添えにしない
  // (旧 Promise.all は 1 件 reject で全体が throw → 残高枯渇の通知そのものが飛ばなかった)。
  // 通知対象の取得失敗は「取得不能」として通知本文に載せ、参照専用の失敗は warning に留める。
  const settled = await Promise.allSettled(
    targets.map((t) => getBalance(t.config.chain, t.rpcUrl, t.paymasterAddress, t.entryPoint.address)),
  );

  const lines = ['Pimlico EntryPoint deposit 残高:'];
  const alerts = [];
  const failures = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const outcome = settled[i];
    const label = `${t.config.chain.name} (EntryPoint ${t.entryPoint.version})`;
    const limit = t.threshold === null ? '通知対象外' : `しきい値 ${formatEther(t.threshold)} ${t.config.nativeSymbol}`;

    if (outcome.status === 'rejected') {
      const reason =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      if (t.threshold === null) {
        // 参照専用の 0.8 RPC 障害を、従来の 0.7 監視の失敗・通知に波及させない。
        logger.log(`::warning::${label}: 取得不能 (${reason})・通知対象外`);
        lines.push(`- ${label}: 取得不能 (${reason})・通知対象外`);
      } else {
        failures.push(`${label}: ${reason}`);
        lines.push(`- ${label}: 取得不能 (${reason})`);
      }
      continue;
    }

    const balance = outcome.value;
    const display = `${formatEther(balance)} ${t.config.nativeSymbol}`;
    lines.push(`- ${label}: ${display} (${limit})`);

    if (t.threshold !== null && balance < t.threshold) {
      alerts.push(
        `⚠️ ${label} の Pimlico deposit 残高 ${display} が ` +
          `${limit} を下回っています。デポジット必要。`,
      );
    }
  }

  logger.log(lines.join('\n'));

  const failureAlerts = failures.map(
    (f) => `⚠️ ${f} — 残高を取得できませんでした (RPC 障害の可能性・監視の穴)。`,
  );

  if (alerts.length > 0 || failureAlerts.length > 0) {
    const message = [
      '🚨 OpenPay Pimlico 残高アラート',
      ...alerts,
      ...failureAlerts,
      '',
      ...lines,
    ].join('\n');
    await notify(webhookUrl, message);
    logger.error('アラート送信済み');
    return { breached: alerts.length > 0, message, lines, alerts, failures };
  }

  logger.log('✅ 通知対象の deposit は残高割れ・取得不能なし');
  return { breached: false, message: null, lines, alerts, failures };
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
  // 通知対象は残高割れだけでなく「取得不能」でも workflow は赤にする (旧 fail-fast と同じ可視性を
  // 保つ)。通知自体は取得できた chain の分も含めて既に送信済み。
  if (result.breached || result.failures.length > 0) {
    process.exit(1);
  }
}
