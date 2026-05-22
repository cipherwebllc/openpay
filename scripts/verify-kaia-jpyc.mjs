// Kaia mainnet / Kairos testnet 上の JPYC contract が OpenPay の前提を満たすか実機検証。
//
// 検証項目 (順に bail-out しない、全部走らせて pass/fail 一覧で報告):
//   (1) bytecode が存在する (EOA / 削除済 contract でない)
//   (2) ERC-20 標準 7 関数が呼び出せる:
//       totalSupply / balanceOf / transfer / transferFrom / approve / allowance / decimals
//   (3) ERC-20 metadata: name() / symbol() / decimals() の値が JPYC v3 と一致
//       (name="JPY Coin", symbol="JPYC", decimals=18)
//   (4) EIP-2612 permit 必須インタフェース:
//       DOMAIN_SEPARATOR() / nonces(address) / permit(...) が implements されている
//   (5) JPYC v3 cross-chain consistency 確認 (memory:reference_jpyc_contract):
//       既知の Polygon mainnet address 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 と
//       Kaia 側 address が一致するかを report
//
// 使い方:
//   node scripts/verify-kaia-jpyc.mjs                                          # default: env から address + RPC
//   NEXT_PUBLIC_JPYC_KAIA_ADDRESS=0x... node scripts/verify-kaia-jpyc.mjs      # env override
//   node scripts/verify-kaia-jpyc.mjs --testnet                                # Kairos testnet 側を検証
//   node scripts/verify-kaia-jpyc.mjs --address 0x... --rpc https://...        # CLI 引数で明示
//
// 失敗 (exit code 非 0) は以下のいずれか:
//   - bytecode が空
//   - 必須 selector の eth_call が revert / 不正 ABI
//   - metadata 値が JPYC v3 spec と異なる
//
// このスクリプトの結果は本番投入の必要条件であり、十分条件ではない。
// 実 transaction (gasless UserOp 等) の動作確認は別 SOP (DEPLOY_CHECKLIST §7.3) で実施。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, http, encodeFunctionData, parseAbi, getAddress } from 'viem';
import { kaia, kairos } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      // 明示的に空文字列が set されている場合 (= test や CI で意図的に unset)
      // は override しない。`!process.env[name]` は空文字列も falsy 扱いに
      // なるため、`=== undefined` で正確に判定する。
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnvFile(join(__dirname, '..', '.env.local'));

// --- CLI args --------------------------------------------------------------
const args = process.argv.slice(2);
const flags = new Set();
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--testnet' || a === '--mainnet') flags.add(a);
  else if (a === '--address' || a === '--rpc') {
    opts[a.slice(2)] = args[++i];
  } else {
    console.error(`unknown arg: ${a}`);
    process.exit(2);
  }
}
const isTestnet = flags.has('--testnet');
const targetChain = isTestnet ? kairos : kaia;
const envAddress = isTestnet
  ? process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS
  : process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS;
const address = opts.address ?? envAddress;
if (!address) {
  console.error(
    `JPYC ${isTestnet ? 'Kairos' : 'Kaia'} address が未設定 — ` +
      `--address 0x... か NEXT_PUBLIC_JPYC_${isTestnet ? 'KAIROS' : 'KAIA'}_ADDRESS を設定`,
  );
  process.exit(2);
}
const rpcEnv = isTestnet ? process.env.NEXT_PUBLIC_KAIROS_RPC_URL : process.env.NEXT_PUBLIC_KAIA_RPC_URL;
const rpcUrl = opts.rpc ?? rpcEnv ?? targetChain.rpcUrls.default.http[0];

console.log('# JPYC contract verification');
console.log(`chain:    ${targetChain.name} (${targetChain.id})`);
console.log(`address:  ${address}`);
console.log(`rpc:      ${rpcUrl}`);
console.log();

// --- viem client -----------------------------------------------------------
const client = createPublicClient({
  chain: targetChain,
  transport: http(rpcUrl),
});

// 既知の JPYC v3 contract address (memory:reference_jpyc_contract、
// 2026-04-30 時点で Polygon/Sepolia/Avalanche Fuji で実測確認済)。
const JPYC_V3_KNOWN_ADDRESS = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';

const erc20Abi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
  'function transferFrom(address, address, uint256) returns (bool)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]);

const permitAbi = parseAbi([
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function nonces(address) view returns (uint256)',
  // permit signature の存在のみを selector で確認 (実 sign は別 SOP)
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

// --- check helpers ---------------------------------------------------------
const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// (1) bytecode 存在
const code = await client.getCode({ address });
if (!code || code === '0x' || code.length < 4) {
  record('(1) bytecode 存在', false, 'EOA or no code at this address');
  console.log('\n以降の検証は意味を成さないため打切り。');
  process.exit(1);
}
record('(1) bytecode 存在', true, `${(code.length - 2) / 2} bytes`);

// (2)(3) ERC-20 metadata + read functions
let metadataPassed = true;
try {
  const [totalSupply, decimals, name, symbol] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'name' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
  ]);
  record('(2) totalSupply()', true, `${totalSupply.toString()}`);
  record('(3a) decimals()', decimals === 18, `${decimals} (expected 18)`);
  record('(3b) name()', name === 'JPY Coin', `"${name}" (expected "JPY Coin")`);
  record('(3c) symbol()', symbol === 'JPYC', `"${symbol}" (expected "JPYC")`);
  if (decimals !== 18 || name !== 'JPY Coin' || symbol !== 'JPYC') metadataPassed = false;
} catch (e) {
  record('(2)(3) ERC-20 read functions', false, e?.shortMessage ?? e?.message ?? String(e));
  metadataPassed = false;
}

// balanceOf / allowance は dead address 引数で revert しないことを確認
try {
  const balance = await client.readContract({
    address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: ['0x000000000000000000000000000000000000dEaD'],
  });
  record('(2) balanceOf(0xdEaD)', true, `${balance.toString()}`);
} catch (e) {
  record('(2) balanceOf(0xdEaD)', false, e?.shortMessage ?? e?.message ?? String(e));
}

try {
  const allowance = await client.readContract({
    address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [
      '0x000000000000000000000000000000000000dEaD',
      '0x000000000000000000000000000000000000bEEF',
    ],
  });
  record('(2) allowance(0xdEaD, 0xbEEF)', true, `${allowance.toString()}`);
} catch (e) {
  record('(2) allowance(0xdEaD, 0xbEEF)', false, e?.shortMessage ?? e?.message ?? String(e));
}

// transfer / transferFrom / approve は state-changing なので eth_call の dry-run で
// 「ABI が存在し ABI decode できる」ことだけ確認 (実行は revert しても 良い、
// "function does not exist" の error を区別する)。
async function probeWritable(functionName, args) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName,
    args,
  });
  try {
    // from を dEaD にした eth_call。selector が存在しなければ "execution reverted"
    // ではなく "function selector was not recognized" 系 error になる。
    await client.call({
      account: '0x000000000000000000000000000000000000dEaD',
      to: address,
      data,
    });
    record(`(2) ${functionName}()`, true, 'callable (dry-run no revert)');
  } catch (e) {
    const msg = String(e?.shortMessage ?? e?.message ?? e);
    // revert は OK (selector は存在し、business logic が拒否しているだけ)。
    // "function selector was not recognized" は selector 不在 = ABI 不一致。
    const isMissingSelector =
      msg.includes('does not exist') ||
      msg.includes('selector was not recognized') ||
      msg.includes('Unsupported function');
    record(`(2) ${functionName}()`, !isMissingSelector, isMissingSelector ? 'selector missing' : `callable (reverted: ${msg.slice(0, 80)})`);
  }
}

await probeWritable('transfer', ['0x000000000000000000000000000000000000bEEF', 1n]);
await probeWritable('transferFrom', [
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000bEEF',
  1n,
]);
await probeWritable('approve', ['0x000000000000000000000000000000000000bEEF', 1n]);

// (4) EIP-2612 permit
let permitPassed = true;
try {
  const domain = await client.readContract({
    address,
    abi: permitAbi,
    functionName: 'DOMAIN_SEPARATOR',
  });
  const isZero = !domain || domain === '0x' || /^0x0+$/.test(domain);
  record('(4a) DOMAIN_SEPARATOR()', !isZero, isZero ? '0x0 (permit not implemented)' : domain.slice(0, 18) + '…');
  if (isZero) permitPassed = false;
} catch (e) {
  record('(4a) DOMAIN_SEPARATOR()', false, e?.shortMessage ?? e?.message ?? String(e));
  permitPassed = false;
}

try {
  const nonces = await client.readContract({
    address,
    abi: permitAbi,
    functionName: 'nonces',
    args: ['0x000000000000000000000000000000000000dEaD'],
  });
  record('(4b) nonces(0xdEaD)', true, `${nonces.toString()}`);
} catch (e) {
  record('(4b) nonces(0xdEaD)', false, e?.shortMessage ?? e?.message ?? String(e));
  permitPassed = false;
}

// permit selector の存在のみ確認 (dummy signature で eth_call、revert ok)
{
  const data = encodeFunctionData({
    abi: permitAbi,
    functionName: 'permit',
    args: [
      '0x000000000000000000000000000000000000dEaD',
      '0x000000000000000000000000000000000000bEEF',
      0n,
      0n,
      27,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    ],
  });
  try {
    await client.call({ to: address, data });
    record('(4c) permit(...) selector', true, 'callable (dry-run no revert)');
  } catch (e) {
    const msg = String(e?.shortMessage ?? e?.message ?? e);
    const isMissingSelector =
      msg.includes('does not exist') ||
      msg.includes('selector was not recognized') ||
      msg.includes('Unsupported function');
    if (isMissingSelector) {
      record('(4c) permit(...) selector', false, 'selector missing');
      permitPassed = false;
    } else {
      record('(4c) permit(...) selector', true, `callable (reverted: ${msg.slice(0, 60)})`);
    }
  }
}

// (5) JPYC v3 cross-chain consistency
const lower = address.toLowerCase();
const knownLower = JPYC_V3_KNOWN_ADDRESS.toLowerCase();
record(
  '(5) JPYC v3 cross-chain consistency',
  lower === knownLower,
  lower === knownLower
    ? `${getAddress(address)} matches known Polygon/Sepolia/Avalanche v3 address`
    : `${getAddress(address)} differs from known v3 address ${JPYC_V3_KNOWN_ADDRESS} — bytecode comparison recommended`,
);

// --- summary ---------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log();
console.log(`--- summary: ${checks.length - failed.length}/${checks.length} passed ---`);
if (failed.length > 0) {
  console.log('FAILED checks:');
  for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('All checks passed.');
console.log();
console.log('Note: this script verifies contract-level prerequisites only.');
console.log('Live transaction smoke (gasless UserOp / sponsorship paymaster) must be');
console.log('done separately — see DEPLOY_CHECKLIST §7.3.');
