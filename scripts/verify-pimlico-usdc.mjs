// Phase 1 対応候補チェーンの Pimlico ERC20 Paymaster (USDC) の対応状況を実機検証する。
// 各チェーンで getTokenQuotes が valid な exchangeRate / postOpGas を返すかを確認。
//
// 使い方: NEXT_PUBLIC_PIMLICO_API_KEY=<key> node scripts/verify-pimlico-usdc.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { http } from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
} from 'viem/chains';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { entryPoint07Address } from 'viem/account-abstraction';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnvFile(join(__dirname, '..', '.env.local'));

const apiKey = process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
if (!apiKey) {
  console.error('NEXT_PUBLIC_PIMLICO_API_KEY が未設定です');
  process.exit(1);
}

const TARGETS = [
  { label: 'Base mainnet', chain: base, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { label: 'Arbitrum One', chain: arbitrum, usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  { label: 'Optimism', chain: optimism, usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  { label: 'Polygon PoS', chain: polygon, usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  { label: 'Base Sepolia', chain: baseSepolia, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  { label: 'Arbitrum Sepolia', chain: arbitrumSepolia, usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
  { label: 'Optimism Sepolia', chain: optimismSepolia, usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7' },
  { label: 'Polygon Amoy', chain: polygonAmoy, usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582' },
];

function fmt(v) {
  if (typeof v === 'bigint') return v.toString();
  return JSON.stringify(v);
}

const results = [];
for (const t of TARGETS) {
  const url = `https://api.pimlico.io/v2/${t.chain.id}/rpc?apikey=${apiKey}`;
  const client = createPimlicoClient({
    transport: http(url),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });
  process.stdout.write(`[${t.label}] (chainId=${t.chain.id}) ... `);
  try {
    const quotes = await client.getTokenQuotes({
      tokens: [t.usdc],
      chain: t.chain,
    });
    if (!quotes || quotes.length === 0) {
      console.log('NO QUOTE (paymaster non-supportive)');
      results.push({ ...t, ok: false, reason: 'empty_quotes' });
      continue;
    }
    const q = quotes[0];
    console.log(
      `OK exchangeRate=${fmt(q.exchangeRate)} postOpGas=${fmt(q.postOpGas)} paymaster=${q.paymaster}`,
    );
    results.push({ ...t, ok: true, quote: q });
  } catch (e) {
    console.log(`ERR ${e?.shortMessage ?? e?.message ?? String(e)}`);
    results.push({ ...t, ok: false, reason: e?.shortMessage ?? e?.message ?? 'unknown' });
  }
}

console.log('\n--- summary ---');
for (const r of results) {
  console.log(`${r.ok ? 'OK ' : 'NG '} ${r.label} (${r.chain.id})${r.ok ? '' : ` — ${r.reason}`}`);
}
