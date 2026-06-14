// Phase 0 (EIP-3009 JPYC ガスレス計画) の読み取り専用オンチェーン検証。
//
// JPYC v3 が Polygon / Kaia (mainnet) で EIP-3009 (transferWithAuthorization) ガスレスの
// 前提を満たすかを実機 RPC で確認する。**eth_call のみ・状態変更なし**。
//
// 検証項目 (全部走らせて pass/fail 一覧):
//   (1) bytecode 存在
//   (2) authorizationState(address,bytes32) view が callable (EIP-3009 view interface 在)
//   (3) EIP-712 domain:
//       - eip712Domain() (ERC-5267) があれば name/version/chainId/verifyingContract を直接取得
//       - 無ければ DOMAIN_SEPARATOR() を name="JPY Coin"/version="1" で計算した期待値と照合
//   (4) **署名 dry-run (決定的)**: 捨て鍵 (残高 0) で有効な EIP-712 transferWithAuthorization
//       署名を作り eth_call。revert 理由が
//         - "balance" 系   → 署名/domain は受理された = EIP-3009 + domain 正しい ✓
//         - "signature" 系 → domain 不一致 (name/version 仮定が誤り) ✗
//         - data 無し       → EIP-3009 未実装の可能性 (要精査)
//
// 使い方:
//   node scripts/verify-jpyc-eip3009.mjs
//   NEXT_PUBLIC_POLYGON_RPC_URL=... NEXT_PUBLIC_KAIA_RPC_URL=... node scripts/verify-jpyc-eip3009.mjs
//
// 本番投入の必要条件であり十分条件ではない (実 relay tx は別途)。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  toHex,
  encodeAbiParameters,
  getAddress,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy, kaia, avalanche, avalancheFuji } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnvFile(join(__dirname, '..', '.env.local'));

// JPYC v3 は全 chain 同一 address (memory:reference_jpyc_contract)。
const JPYC_V3 = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
// 仮定する EIP-712 domain (lib/x402/types.ts と一致)。
const ASSUMED_NAME = 'JPY Coin';
const ASSUMED_VERSION = '1';

const TARGETS = [
  {
    name: 'Polygon',
    chain: polygon,
    rpc: process.env.NEXT_PUBLIC_POLYGON_RPC_URL,
    address: process.env.NEXT_PUBLIC_JPYC_POLYGON_ADDRESS ?? JPYC_V3,
  },
  {
    name: 'Polygon Amoy',
    chain: polygonAmoy,
    rpc: process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL,
    address: process.env.NEXT_PUBLIC_JPYC_POLYGON_AMOY_ADDRESS ?? JPYC_V3,
  },
  {
    name: 'Kaia',
    chain: kaia,
    rpc: process.env.NEXT_PUBLIC_KAIA_RPC_URL,
    address: process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS ?? JPYC_V3,
  },
  {
    name: 'Avalanche',
    chain: avalanche,
    rpc: process.env.NEXT_PUBLIC_AVALANCHE_RPC_URL,
    address: process.env.NEXT_PUBLIC_JPYC_AVALANCHE_ADDRESS ?? JPYC_V3,
  },
  {
    name: 'Avalanche Fuji',
    chain: avalancheFuji,
    rpc: process.env.NEXT_PUBLIC_AVALANCHE_FUJI_RPC_URL,
    address: process.env.NEXT_PUBLIC_JPYC_AVALANCHE_FUJI_ADDRESS ?? JPYC_V3,
  },
];

const abi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);

const DOMAIN_TYPEHASH = keccak256(
  toHex(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  ),
);

function computeDomainSeparator(name, version, chainId, verifyingContract) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(toHex(name)),
        keccak256(toHex(version)),
        BigInt(chainId),
        getAddress(verifyingContract),
      ],
    ),
  );
}

// 捨て鍵 (Anvil #0、Polygon/Kaia で JPYC 残高 0 のはず)。
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const testAccount = privateKeyToAccount(TEST_PK);
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

function classifyRevert(message) {
  const m = (message ?? '').toLowerCase();
  if (/balance|exceeds|insufficient|funds/.test(m)) return 'sig-accepted';
  if (/signature|invalid|authoriz|recover|signer/.test(m)) return 'sig-rejected';
  return 'inconclusive';
}

let anyFail = false;
for (const t of TARGETS) {
  const rpcUrl = t.rpc ?? t.chain.rpcUrls.default.http[0];
  console.log(`\n# ${t.name} (chainId ${t.chain.id})`);
  console.log(`  address: ${t.address}`);
  console.log(`  rpc:     ${rpcUrl}`);
  const client = createPublicClient({ chain: t.chain, transport: http(rpcUrl) });
  const rec = (ok, name, detail) => {
    if (!ok) anyFail = true;
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  // domain view が未公開なのは JPYC v3 の仕様 (両 chain 共通)。署名 dry-run (4) が真の
  // domain 検証なので、(3) の read 不可は WARN 扱い (verdict には影響させない)。
  const warn = (name, detail) =>
    console.log(`  ⚠ ${name}${detail ? ` — ${detail}` : ''}`);

  try {
    // (1) bytecode
    const code = await client.getCode({ address: t.address });
    if (!code || code === '0x') {
      rec(false, '(1) bytecode', 'no code');
      continue;
    }
    rec(true, '(1) bytecode', `${(code.length - 2) / 2} bytes`);

    // (2) authorizationState (EIP-3009 view)
    try {
      const used = await client.readContract({
        address: t.address,
        abi,
        functionName: 'authorizationState',
        args: [testAccount.address, zeroHash],
      });
      rec(true, '(2) authorizationState()', `returns ${used}`);
    } catch (e) {
      rec(false, '(2) authorizationState()', e.shortMessage ?? String(e));
    }

    // (3) EIP-712 domain
    let domainName, domainVersion, domainOk;
    try {
      const d = await client.readContract({
        address: t.address,
        abi,
        functionName: 'eip712Domain',
      });
      domainName = d[1];
      domainVersion = d[2];
      domainOk = domainName === ASSUMED_NAME && domainVersion === ASSUMED_VERSION;
      rec(
        domainOk,
        '(3) eip712Domain() [ERC-5267]',
        `name="${domainName}" version="${domainVersion}" chainId=${d[3]} verifyingContract=${d[4]}`,
      );
    } catch {
      // fallback: DOMAIN_SEPARATOR() を仮定値と照合
      try {
        const onchain = await client.readContract({
          address: t.address,
          abi,
          functionName: 'DOMAIN_SEPARATOR',
        });
        const expected = computeDomainSeparator(
          ASSUMED_NAME,
          ASSUMED_VERSION,
          t.chain.id,
          t.address,
        );
        domainOk = onchain.toLowerCase() === expected.toLowerCase();
        domainName = ASSUMED_NAME;
        domainVersion = ASSUMED_VERSION;
        rec(
          domainOk,
          '(3) DOMAIN_SEPARATOR() vs assumed',
          domainOk
            ? `match (name="${ASSUMED_NAME}" version="${ASSUMED_VERSION}")`
            : `MISMATCH onchain=${onchain} expected=${expected}`,
        );
      } catch {
        // 両 view が revert = domain を公開していないだけ。(4) の署名 dry-run で domain を検証する。
        warn(
          '(3) EIP-712 domain',
          'eip712Domain()/DOMAIN_SEPARATOR() 非公開 (JPYC v3 仕様) → (4) で検証',
        );
      }
    }

    // (4) 署名 dry-run (決定的)
    try {
      const nonce = keccak256(toHex(`openpay-phase0-${t.chain.id}-${Date.now()}`));
      const value = 1n;
      const validAfter = 0n;
      const validBefore = 2n ** 48n - 1n;
      const sig = await testAccount.signTypedData({
        domain: {
          name: domainName ?? ASSUMED_NAME,
          version: domainVersion ?? ASSUMED_VERSION,
          chainId: t.chain.id,
          verifyingContract: getAddress(t.address),
        },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: testAccount.address,
          to: RECIPIENT,
          value,
          validAfter,
          validBefore,
          nonce,
        },
      });
      const r = `0x${sig.slice(2, 66)}`;
      const s = `0x${sig.slice(66, 130)}`;
      const v = parseInt(sig.slice(130, 132), 16);
      try {
        await client.simulateContract({
          address: t.address,
          abi,
          functionName: 'transferWithAuthorization',
          args: [
            testAccount.address,
            RECIPIENT,
            value,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s,
          ],
          account: RECIPIENT, // relayer は誰でも可 (transferWithAuthorization)
        });
        // 残高 0 のはずなので成功は想定外 (= 残高があった)。署名は受理されている。
        rec(true, '(4) 署名 dry-run', 'simulate 成功 (= 署名受理・残高あり)');
      } catch (e) {
        const full = e.shortMessage ?? e.message ?? '';
        const cls = classifyRevert(full);
        // revert reason 行 (FiatToken の "...exceeds balance" 等) を抽出して表示。
        const reasonLine =
          full
            .split('\n')
            .map((l) => l.trim())
            .find((l) => /balance|signature|exceeds|invalid|authoriz/i.test(l)) ??
          full.split('\n')[0];
        rec(
          cls === 'sig-accepted',
          '(4) 署名 dry-run',
          `${cls}: "${reasonLine.slice(0, 160)}"`,
        );
      }
    } catch (e) {
      rec(false, '(4) 署名 dry-run', `sign/encode error: ${e.shortMessage ?? e}`);
    }

    // (5) receiveWithAuthorization 対応 (forwarder の 1署名分割に必須)。
    //   ReceiveWithAuthorization 署名を作り、msg.sender == to (payee) で simulate。
    //     - "balance" 系 revert → 関数あり・sig 受理 = 対応 ✓ (forwarder 採用可)
    //     - "signature" 系     → 関数はあるが domain/typehash 不一致 (要精査)
    //     - data 無し/inconclusive → 未実装の可能性 (forwarder 方式の前提が崩れる)
    //   さらに msg.sender != to で呼び "caller must be the payee" が出れば front-run ガード確認。
    try {
      const nonce = keccak256(toHex(`openpay-recv-${t.chain.id}-${Date.now()}`));
      const value = 1n;
      const validAfter = 0n;
      const validBefore = 2n ** 48n - 1n;
      const sig = await testAccount.signTypedData({
        domain: {
          name: domainName ?? ASSUMED_NAME,
          version: domainVersion ?? ASSUMED_VERSION,
          chainId: t.chain.id,
          verifyingContract: getAddress(t.address),
        },
        types: {
          ReceiveWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'ReceiveWithAuthorization',
        message: {
          from: testAccount.address,
          to: RECIPIENT,
          value,
          validAfter,
          validBefore,
          nonce,
        },
      });
      const r = `0x${sig.slice(2, 66)}`;
      const s = `0x${sig.slice(66, 130)}`;
      const v = parseInt(sig.slice(130, 132), 16);
      const args = [
        testAccount.address,
        RECIPIENT,
        value,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      ];
      // (5a) payee 自身が呼ぶ (msg.sender == to)
      try {
        await client.simulateContract({
          address: t.address,
          abi,
          functionName: 'receiveWithAuthorization',
          args,
          account: RECIPIENT,
        });
        rec(true, '(5) receiveWithAuthorization', 'simulate 成功 (= 対応・sig受理・残高あり)');
      } catch (e) {
        const full = e.shortMessage ?? e.message ?? '';
        const cls = classifyRevert(full);
        const reasonLine =
          full
            .split('\n')
            .map((l) => l.trim())
            .find((l) =>
              /balance|signature|exceeds|invalid|authoriz|payee|caller|not a function|reverted/i.test(
                l,
              ),
            ) ?? full.split('\n')[0];
        rec(
          cls === 'sig-accepted',
          '(5) receiveWithAuthorization',
          `${cls}: "${reasonLine.slice(0, 160)}"`,
        );
      }
      // (5b) payee 以外が呼ぶ → "caller must be the payee" であるべき (front-run ガード)
      try {
        await client.simulateContract({
          address: t.address,
          abi,
          functionName: 'receiveWithAuthorization',
          args,
          account: '0x000000000000000000000000000000000000bEEF',
        });
        warn('(5b) caller!=payee guard', 'revert しなかった (想定外)');
      } catch (e) {
        const full = (e.shortMessage ?? e.message ?? '').toLowerCase();
        const guard = /payee|caller|sender/.test(full);
        warn(
          '(5b) caller!=payee guard',
          guard ? 'payee ガード確認' : `revert: "${full.slice(0, 100)}"`,
        );
      }
    } catch (e) {
      rec(false, '(5) receiveWithAuthorization', `sign/encode error: ${e.shortMessage ?? e}`);
    }
  } catch (e) {
    rec(false, `${t.name} RPC`, e.shortMessage ?? String(e));
  }
}

console.log(`\n${anyFail ? '✗ 一部 FAIL — 上記参照' : '✓ 全 PASS'}`);
process.exit(anyFail ? 1 : 0);
