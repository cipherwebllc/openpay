#!/usr/bin/env node
// Pimlico Sponsorship Paymaster の残高監視。EntryPoint v0.7 の balanceOf
// で各チェーンの paymaster deposit を読み、しきい値以下なら Slack/Discord
// 互換 webhook (POST {text}) に通知する。GitHub Actions cron で 6h 毎実行。
// 必須/任意 env は main() の requireEnv() / fallback で自己文書化されている。

import { createPublicClient, http, formatEther, parseEther, getAddress } from 'viem';
import { base, polygon } from 'viem/chains';

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
    throw new Error(
      `webhook POST 失敗: ${res.status} ${res.statusText}`,
    );
  }
}

async function main() {
  // 全 required env を script 先頭で検証 (fail-fast)。
  // 残高が breach した時に webhook URL が無いと alert が黙って失敗する
  // 設計を防ぐため、breach 検出ロジックの前に必ず resolve する。
  const polygonPaymaster = requireEnv('PIMLICO_PAYMASTER_POLYGON');
  const basePaymaster = requireEnv('PIMLICO_PAYMASTER_BASE');
  const webhookUrl = requireEnv('ALERT_WEBHOOK_URL');
  const polygonRpc = process.env.POLYGON_RPC_URL ?? 'https://polygon-rpc.com';
  const baseRpc = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
  const polThreshold = parseEther(process.env.ALERT_THRESHOLD_POL ?? '5');
  const ethThreshold = parseEther(process.env.ALERT_THRESHOLD_ETH ?? '0.01');

  const [polygonBalance, baseBalance] = await Promise.all([
    getBalance(polygon, polygonRpc, polygonPaymaster),
    getBalance(base, baseRpc, basePaymaster),
  ]);

  const lines = [];
  lines.push('Pimlico Sponsorship Paymaster 残高:');
  lines.push(`- Polygon: ${formatEther(polygonBalance)} POL (しきい値 ${formatEther(polThreshold)})`);
  lines.push(`- Base:    ${formatEther(baseBalance)} ETH (しきい値 ${formatEther(ethThreshold)})`);

  console.log(lines.join('\n'));

  const alerts = [];
  if (polygonBalance < polThreshold) {
    alerts.push(
      `⚠️ Polygon の Pimlico 残高 ${formatEther(polygonBalance)} POL が ` +
        `しきい値 ${formatEther(polThreshold)} POL を下回っています。デポジット必要。`,
    );
  }
  if (baseBalance < ethThreshold) {
    alerts.push(
      `⚠️ Base の Pimlico 残高 ${formatEther(baseBalance)} ETH が ` +
        `しきい値 ${formatEther(ethThreshold)} ETH を下回っています。デポジット必要。`,
    );
  }

  if (alerts.length > 0) {
    const message = ['🚨 OpenPay Pimlico 残高アラート', ...alerts, '', ...lines].join('\n');
    await notify(webhookUrl, message);
    console.error('アラート送信済み');
    process.exit(1);
  }

  console.log('✅ 残高は十分です');
}

main();
