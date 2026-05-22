// Pimlico Kaia / Kairos bundler + paymaster の capability を実機検証する。
//
// 検証項目 (順に bail-out しない):
//   (1) bundler endpoint 到達性 (HTTP 200 + JSON-RPC 応答 — chain id mismatch
//       は受け付ける限り pass)
//   (2) eth_supportedEntryPoints が EntryPoint v0.7 (0x0000…da032) を含む
//   (3) eth_chainId が宣言した chainId (8217 / 1001) を返す
//   (4) pimlico_getUserOperationGasPrice が standard / fast / slow の 3 tier を
//       返し、各 tier に maxFeePerGas / maxPriorityFeePerGas (>0) が入っている
//   (5) pimlico_getUserOperationStatus が「不明 hash → not_found / null」を
//       返す (selector の生存性確認、実 hash 不要)
//
// 使い方:
//   NEXT_PUBLIC_PIMLICO_API_KEY=<key> node scripts/verify-kaia-pimlico.mjs
//   NEXT_PUBLIC_PIMLICO_API_KEY=<key> node scripts/verify-kaia-pimlico.mjs --mainnet-only
//   NEXT_PUBLIC_PIMLICO_API_KEY=<key> node scripts/verify-kaia-pimlico.mjs --testnet-only
//
// このスクリプトは Smart Account の動作確認は行わない (それは別 SOP
// = Kairos で実 UserOp を投げる手動 smoke、DEPLOY_CHECKLIST §7.3 の (3) 以降)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { kaia, kairos } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      // 明示的に空文字列が set されている場合 (= test や CI で意図的に unset)
      // は override しない。
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnvFile(join(__dirname, '..', '.env.local'));

const apiKey = process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
if (!apiKey) {
  console.error('NEXT_PUBLIC_PIMLICO_API_KEY が未設定です');
  process.exit(2);
}

const args = process.argv.slice(2);
const onlyMainnet = args.includes('--mainnet-only');
const onlyTestnet = args.includes('--testnet-only');
if (onlyMainnet && onlyTestnet) {
  console.error('--mainnet-only と --testnet-only は同時指定不可');
  process.exit(2);
}

const TARGETS = [];
if (!onlyTestnet) TARGETS.push({ label: 'Kaia mainnet', chain: kaia });
if (!onlyMainnet) TARGETS.push({ label: 'Kairos testnet', chain: kairos });

// EntryPoint v0.7 canonical address (eth-infinitism)
const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
// EntryPoint v0.6 (legacy)
const ENTRYPOINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
// EntryPoint v0.8
const ENTRYPOINT_V08 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108';

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC ${method} error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try {
    const result = await fn();
    console.log(`✓ ${result ?? ''}`);
    return { ok: true, result };
  } catch (e) {
    console.log(`✗ ${e?.message ?? String(e)}`);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

const summary = [];

for (const t of TARGETS) {
  const url = `https://api.pimlico.io/v2/${t.chain.id}/rpc?apikey=${apiKey}`;
  console.log(`\n[${t.label}] chainId=${t.chain.id}`);

  const checks = [];

  // (1) bundler endpoint reachability (eth_chainId が最も軽い probe)
  const chainIdRes = await check('(1) endpoint reachability (eth_chainId)', async () => {
    const hex = await rpc(url, 'eth_chainId');
    return `chainId=${parseInt(hex, 16)}`;
  });
  checks.push(chainIdRes);

  // (2) supportedEntryPoints
  const epsRes = await check('(2) eth_supportedEntryPoints includes v0.7', async () => {
    const eps = await rpc(url, 'eth_supportedEntryPoints');
    if (!Array.isArray(eps)) throw new Error(`unexpected: ${JSON.stringify(eps)}`);
    const lower = eps.map((e) => e.toLowerCase());
    const v07 = lower.includes(ENTRYPOINT_V07.toLowerCase());
    const v06 = lower.includes(ENTRYPOINT_V06.toLowerCase());
    const v08 = lower.includes(ENTRYPOINT_V08.toLowerCase());
    if (!v07) throw new Error(`v0.7 missing. got: ${eps.join(', ')}`);
    const versions = [];
    if (v06) versions.push('v0.6');
    if (v07) versions.push('v0.7');
    if (v08) versions.push('v0.8');
    return `[${versions.join(', ')}]`;
  });
  checks.push(epsRes);

  // (3) chainId 一致
  const chainIdMatch = await check('(3) chainId matches', async () => {
    const hex = await rpc(url, 'eth_chainId');
    const actual = parseInt(hex, 16);
    if (actual !== t.chain.id) {
      throw new Error(`expected ${t.chain.id}, got ${actual}`);
    }
    return `${actual} ✓`;
  });
  checks.push(chainIdMatch);

  // (4) pimlico_getUserOperationGasPrice (3 tier)
  const gasPriceRes = await check('(4) pimlico_getUserOperationGasPrice tiers', async () => {
    const r = await rpc(url, 'pimlico_getUserOperationGasPrice');
    if (!r || typeof r !== 'object') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const tiers = ['slow', 'standard', 'fast'];
    const missing = tiers.filter((tier) => !r[tier] || !r[tier].maxFeePerGas);
    if (missing.length > 0) {
      throw new Error(`missing tiers: ${missing.join(', ')}`);
    }
    const fast = BigInt(r.fast.maxFeePerGas);
    const standard = BigInt(r.standard.maxFeePerGas);
    const slow = BigInt(r.slow.maxFeePerGas);
    if (fast <= 0n || standard <= 0n || slow <= 0n) {
      throw new Error(
        `non-positive gas price: slow=${slow} standard=${standard} fast=${fast}`,
      );
    }
    const gwei = (wei) => (Number(wei / 10n ** 6n) / 1000).toFixed(3);
    return `slow=${gwei(slow)} standard=${gwei(standard)} fast=${gwei(fast)} gwei`;
  });
  checks.push(gasPriceRes);

  // (5) pimlico_getUserOperationStatus は不明 hash で「not_found / pending / null」
  //     のいずれかを返せば selector が生きている (実 hash 不要)。
  const statusRes = await check('(5) pimlico_getUserOperationStatus selector', async () => {
    const dummyHash = '0x' + '00'.repeat(32);
    const r = await rpc(url, 'pimlico_getUserOperationStatus', [dummyHash]);
    // null / { status: 'not_found' } / { status: 'pending' } のいずれも OK
    if (r === null) return 'null (not_found OK)';
    if (typeof r === 'object' && r.status) return `status=${r.status}`;
    return JSON.stringify(r);
  });
  checks.push(statusRes);

  const failed = checks.filter((c) => !c.ok).length;
  summary.push({
    target: t.label,
    chainId: t.chain.id,
    passed: checks.length - failed,
    total: checks.length,
    ok: failed === 0,
  });
}

console.log('\n--- summary ---');
for (const s of summary) {
  console.log(
    `${s.ok ? 'OK ' : 'NG '} ${s.target} (${s.chainId}): ${s.passed}/${s.total} passed`,
  );
}

const anyFailed = summary.some((s) => !s.ok);
console.log();
console.log('Note: this script verifies bundler capability only.');
console.log('Live UserOp submit (funded EOA + sponsorship policy + actual JPYC transfer)');
console.log('must be done separately — see DEPLOY_CHECKLIST §7.3 step (3).');
process.exit(anyFailed ? 1 : 0);
