#!/usr/bin/env node
// steward-bootstrap — self-host Steward を openpay-x402-mcp の署名バックエンドにするための
// 完全自動セットアップ。tenant 作成 → self-join open → owner の SIWE ログイン → owner 昇格 →
// agent (ウォレット) 作成 → JPYC typed-data ポリシー付与 → owner の TOTP (MFA) 登録 →
// MFA セッションで signer 資格情報を発行、までを 1 コマンドで行い、完成した MCP env
// と owner TOTP をリポ外の専用ファイル (0600) に保存する。
//
// MFA について: Steward は signer 発行を MFA 済みセッションに限定する。本スクリプトは
// 操作者 (owner) の TOTP を登録してシークレットを操作者に引き渡す (認証アプリに登録して
// 以後の管理操作に使う)。MFA を迂回するのではなく、登録を代行して factor を手渡す設計。
// 注意: Steward はロール昇格/MFA 有効化のたびに既存セッションを失効させ、失効境界が
// 秒粒度のため、各段階の間に短い待機を挟む (実測に基づく)。全体で 1 分弱かかる。
//
// 依存: viem のみ。実行:
//   OWNER_PRIVATE_KEY=0x... STEWARD_PLATFORM_KEY=... node steward-bootstrap.mjs [--out /private/path.json]
// 既定: ~/.config/openpay/steward-<random>.json。CI は --allow-ci が必要。
//
// すべての env (既定):
//   STEWARD_URL            http://localhost:3900
//   STEWARD_PLATFORM_KEY   (必須) 起動時の STEWARD_PLATFORM_KEYS の 1 つ
//   OWNER_PRIVATE_KEY      (必須) tenant owner にするウォレットの秘密鍵。
//                          ※このスクリプト内で SIWE 署名にのみ使用し、送信も保存もしない。
//   TENANT_ID              openpay
//   TENANT_NAME            "OpenPay Buyer"
//   AGENT_ID               jpyc-buyer
//   JPYC_ADDRESS           本番 402 の accepts[0].asset を既定に採用 (Polygon JPYC)
//   FORWARDER_ADDRESS      本番 402 の accepts[0].payTo を既定に採用
//   CHAIN_ID               137
//   MAX_SIGN_JPYC          3   (1 署名あたりの value 上限・整数 JPYC)

import { createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openPrivateOutput, PrivateOutputError } from '../src/privateOutput.mjs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { isHex } from 'viem';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// RFC 6238 TOTP (SHA-1 / 30s / 6 桁) — Steward の既定と一致。
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secret, time = Date.now()) {
  const counter = Math.floor(time / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1e6).padStart(6, '0');
}

// TOTP は同一コードの再利用が拒否されるため、直前に使ったコードと別の時間窓を待つ。
async function nextTotpWindow() {
  const msIntoStep = Date.now() % 30_000;
  await sleep(30_000 - msIntoStep + 1_000);
}

const env = process.env;
const URL_BASE = (env.STEWARD_URL || 'http://localhost:3900').replace(/\/+$/, '');
const PLATFORM_KEY = env.STEWARD_PLATFORM_KEY;
const OWNER_KEY = env.OWNER_PRIVATE_KEY;
const TENANT_ID = env.TENANT_ID || 'openpay';
const TENANT_NAME = env.TENANT_NAME || 'OpenPay Buyer';
const AGENT_ID = env.AGENT_ID || 'jpyc-buyer';
const JPYC_ADDRESS = env.JPYC_ADDRESS || '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const FORWARDER_ADDRESS = env.FORWARDER_ADDRESS || '0x0F4560a777415580F0680F8B56a79B0022C6B848';
const CHAIN_ID = Number(env.CHAIN_ID || '137');
const MAX_SIGN_JPYC = String(env.MAX_SIGN_JPYC || '3');

class BootstrapError extends Error {}

const DIAGNOSTIC_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'BaseError', 'InvalidPrivateKeyError',
]);
function errorDiagnostics(err) {
  const diagnostic = {};
  // Error names are writable too. Limit names and codes so useful diagnostics cannot
  // reintroduce credentials, response bodies or multiline payloads into terminal/CI logs.
  if (DIAGNOSTIC_ERROR_NAMES.has(err?.name)) diagnostic.name = err.name;
  for (const [field, value] of [['code', err?.code], ['causeCode', err?.cause?.code]]) {
    // JS $ also matches before a final newline; require the whole value to match.
    if (typeof value === 'string' && /^E[A-Z0-9_]+$/.exec(value)?.[0] === value) diagnostic[field] = value;
  }
  return Object.keys(diagnostic).length ? ` ${JSON.stringify(diagnostic)}` : '';
}

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const platformHeaders = () => ({
  'content-type': 'application/json',
  'X-Steward-Platform-Key': PLATFORM_KEY,
});
const tenantHeaders = (extra = {}) => ({
  'content-type': 'application/json',
  'X-Steward-Tenant': TENANT_ID,
  ...extra,
});

export async function jsonOrThrow(res, label) {
  const body = await res.json().catch(() => ({}));
  // Steward の API は成功時に必ず ok:true を返す。&& だと「HTTP 200 + ok:false」も
  // 「HTTP 5xx + ok:true」も成功扱いになり、失敗した段階 (owner 昇格・MFA・signer 発行) を
  // 素通りして後段が意味不明に壊れる。setAndVerifyJpycPolicy と同じ || 判定に揃える。
  // Authenticated response bodies can echo credentials; keep them out of terminal/CI logs.
  if (!res.ok || body?.ok !== true) {
    throw new BootstrapError(`${label} failed (${res.status}); response body withheld`);
  }
  return body;
}

async function siweLogin(account) {
  // localhost の Origin を許可させるため、サーバ側 SIWE_ALLOWED_DOMAINS に URL_BASE の
  // host を含めておくこと (このスクリプトは Origin ヘッダを URL_BASE で送る)。
  const originUrl = new URL(URL_BASE);
  const nonceRes = await fetch(`${URL_BASE}/auth/nonce?tenantId=${TENANT_ID}`, {
    headers: { Origin: URL_BASE, 'X-Steward-Tenant': TENANT_ID },
  });
  const nonceBody = await jsonOrThrow(nonceRes, 'SIWE nonce');
  const nonce = nonceBody.nonce ?? nonceBody.data?.nonce;
  if (!nonce) throw new BootstrapError('SIWE nonce missing in response');

  const message = createSiweMessage({
    domain: originUrl.host,
    address: account.address,
    statement: 'Sign in to Steward',
    uri: URL_BASE,
    version: '1',
    chainId: 1,
    nonce,
    issuedAt: new Date(),
  });
  const signature = await account.signMessage({ message });
  const verifyRes = await fetch(`${URL_BASE}/auth/verify`, {
    method: 'POST',
    headers: tenantHeaders({ Origin: URL_BASE }),
    body: JSON.stringify({ message, signature }),
  });
  const v = await jsonOrThrow(verifyRes, 'SIWE verify');
  const token = v.token ?? v.data?.token;
  const userId = v.userId ?? v.data?.userId ?? v.data?.user?.id;
  const mfaChallengeId = v.mfa?.challengeId ?? null;
  if (!mfaChallengeId && (!token || !userId)) {
    throw new BootstrapError('SIWE verify returned no token/userId');
  }
  return { token, userId, mfaChallengeId };
}

async function strictJson(res, label) {
  try {
    return await res.json();
  } catch {
    // プロキシの HTML fallback をポリシー登録成功と誤認する波及をここで断つ。
    throw new BootstrapError(`${label} returned non-JSON (${res.status})`);
  }
}

function createJpycPolicy({
  jpycAddress,
  forwarderAddress,
  chainId,
  maxValueAtomic,
}) {
  return {
    id: 'jpyc-receive',
    type: 'typed-data',
    enabled: true,
    config: {
      verifyingContractAllowlist: [jpycAddress],
      allowedChainIds: [chainId],
      allowedPrimaryTypes: ['ReceiveWithAuthorization'],
      messageConditions: [
        { field: 'to', operator: 'address_in', values: [forwarderAddress] },
        { field: 'value', operator: 'uint_max', value: maxValueAtomic },
      ],
    },
  };
}

function policyFields(policy) {
  return {
    type: policy?.type,
    enabled: policy?.enabled,
    config: policy?.config,
  };
}

export async function setAndVerifyJpycPolicy({
  fetchImpl = fetch,
  urlBase,
  tenantId,
  apiKey,
  agentId,
  jpycAddress,
  forwarderAddress,
  chainId,
  maxValueAtomic,
}) {
  const expectedPolicy = createJpycPolicy({
    jpycAddress,
    forwarderAddress,
    chainId,
    maxValueAtomic,
  });
  const endpoint = `${urlBase}/agents/${agentId}/policies`;
  const headers = {
    'content-type': 'application/json',
    'X-Steward-Tenant': tenantId,
    'X-Steward-Key': apiKey,
  };
  const policyRes = await fetchImpl(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify([expectedPolicy]),
  });
  const policyBody = await strictJson(policyRes, 'policy set');
  if (!policyRes.ok || policyBody?.ok !== true) {
    const detail = JSON.stringify(policyBody).slice(0, 200);
    if (/Unknown policy type/i.test(detail)) {
      throw new BootstrapError(
        `policy set failed (${policyRes.status}): this Steward version does not support typed-data policies; update Steward before issuing signer credentials`,
      );
    }
    throw new BootstrapError(`policy set failed (${policyRes.status}); response body withheld`);
  }

  const readBackRes = await fetchImpl(endpoint, { headers });
  const readBackBody = await strictJson(readBackRes, 'policy read-back');
  if (!readBackRes.ok || readBackBody?.ok !== true || !Array.isArray(readBackBody.data)) {
    throw new BootstrapError(
      `policy read-back failed (${readBackRes.status}); response body withheld`,
    );
  }

  // Steward の置換 API は行 ID を再生成する版があるため、単一ポリシーの実効フィールドを
  // PUT した値へ完全一致させ、保存欠落による無制限署名への波及をここで断つ。
  const readBackMatches =
    readBackBody.data.length === 1 &&
    isDeepStrictEqual(policyFields(readBackBody.data[0]), policyFields(expectedPolicy));
  if (!readBackMatches) {
    throw new BootstrapError(
      'policy read-back mismatch; response body withheld',
    );
  }
}

async function main() {
  let outputPath;
  let allowCi = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && !outputPath && args[i + 1] && !args[i + 1].startsWith('--')) outputPath = args[++i];
    else if (args[i] === '--allow-ci' && !allowCi) allowCi = true;
    else throw new BootstrapError('Usage: steward-bootstrap.mjs [--out /private/path.json] [--allow-ci]');
  }
  if (env.CI && !/^(?:false|0)$/i.test(env.CI) && !allowCi) throw new BootstrapError('CI bootstrap requires explicit --allow-ci');
  if (!PLATFORM_KEY) {
    die('STEWARD_PLATFORM_KEY is required (one of the server STEWARD_PLATFORM_KEYS).');
  }
  if (!OWNER_KEY || !isHex(OWNER_KEY) || OWNER_KEY.length !== 66) {
    die('OWNER_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string.');
  }

  const owner = privateKeyToAccount(OWNER_KEY);
  const output = await openPrivateOutput(outputPath ?? join(homedir(), '.config', 'openpay', `steward-${randomBytes(8).toString('hex')}.json`), { createParents: true });
  const credentials = { env: { SIGNER_MODE: 'steward', STEWARD_URL: URL_BASE, STEWARD_TENANT: TENANT_ID } };
  async function checkpoint() {
    const bytes = Buffer.from(JSON.stringify(credentials, null, 2) + '\n');
    await output.handle.write(bytes, 0, bytes.length, 0);
    await output.handle.truncate(bytes.length);
    await output.handle.sync();
  }
  console.log(`Credentials file: ${output.path}`);
  try {
    await checkpoint();
    console.log(`→ Owner wallet: ${owner.address}`);

    // 1. tenant (存在時は 409 を許容)
    const tRes = await fetch(`${URL_BASE}/platform/tenants`, {
      method: 'POST',
      headers: platformHeaders(),
      body: JSON.stringify({ id: TENANT_ID, name: TENANT_NAME }),
    });
    const tBody = await tRes.json().catch(() => ({}));
    let apiKey = tBody?.data?.apiKey;
    if (tRes.ok && apiKey) {
      credentials.env.STEWARD_API_KEY = apiKey;
      await checkpoint();
      console.log(`✓ tenant "${TENANT_ID}" created`);
    } else if (tRes.status === 409 || /exists/i.test(JSON.stringify(tBody))) {
      console.log(`• tenant "${TENANT_ID}" already exists — reusing`);
      console.log('  (tenant API key is shown only at creation. If you lost it, delete and');
      console.log('   recreate the tenant, or rotate it via the platform API.)');
    } else {
      throw new BootstrapError(`tenant create failed (${tRes.status}); response body withheld`);
    }

    // 2. self-join open (owner が SIWE で入れるように)
    await jsonOrThrow(
      await fetch(`${URL_BASE}/platform/tenants/${TENANT_ID}/join-mode`, {
        method: 'PATCH',
        headers: platformHeaders(),
        body: JSON.stringify({ joinMode: 'open' }),
      }),
      'join-mode open',
    );
    console.log('✓ join-mode: open');

    // 3. owner の SIWE ログイン → 4. owner 昇格
    const first = await siweLogin(owner);
    await jsonOrThrow(
      await fetch(`${URL_BASE}/platform/tenants/${TENANT_ID}/members/${first.userId}`, {
        method: 'PATCH',
        headers: platformHeaders(),
        body: JSON.stringify({ role: 'owner' }),
      }),
      'promote owner',
    );
    console.log(`✓ owner promoted (userId ${first.userId})`);
    // 昇格は既存セッションを失効させる (失効境界が秒粒度)。境界を跨いでから次の操作へ。
    await sleep(2_000);

    // 5. agent (ウォレット)
    if (!apiKey) {
      console.log('\n⚠ tenant を再利用したため tenant API key が手元にありません。');
      console.log('  以降 (agent 作成・ポリシー・env 出力) には STEWARD_API_KEY が必要です。');
      console.log('  一度 tenant を作り直して apiKey を控えてから再実行してください。');
      process.exitCode = 2;
      return;
    }
    const aRes = await fetch(`${URL_BASE}/agents`, {
      method: 'POST',
      headers: tenantHeaders({ 'X-Steward-Key': apiKey }),
      body: JSON.stringify({ id: AGENT_ID, name: AGENT_ID }),
    });
    const aBody = await aRes.json().catch(() => ({}));
    let agent = aBody?.data;
    if (!aRes.ok || !agent?.id) {
      // 既存 agent を GET で拾う
      const list = await fetch(`${URL_BASE}/agents`, {
        headers: tenantHeaders({ 'X-Steward-Key': apiKey }),
      }).then((r) => r.json()).catch(() => ({}));
      agent = (list?.data ?? list?.agents ?? []).find((x) => x.id === AGENT_ID) || (list?.data ?? [])[0];
      if (!agent?.id) {
        throw new BootstrapError(`agent create failed (${aRes.status}); response body withheld`);
      }
      console.log(`• agent "${AGENT_ID}" already exists — reusing`);
    } else {
      console.log(`✓ agent created: ${agent.id}`);
    }
    const agentAddress = agent.walletAddress ?? agent.walletAddresses?.evm;
    Object.assign(credentials.env, { STEWARD_AGENT_ID: agent.id, STEWARD_AGENT_ADDRESS: agentAddress });

    // 6. JPYC typed-data ポリシー (JPYC 宛・forwarder 宛・上限額)
    const maxValueAtomic = (BigInt(MAX_SIGN_JPYC) * 10n ** 18n).toString();
    await setAndVerifyJpycPolicy({
      urlBase: URL_BASE,
      tenantId: TENANT_ID,
      apiKey,
      agentId: agent.id,
      jpycAddress: JPYC_ADDRESS,
      forwarderAddress: FORWARDER_ADDRESS,
      chainId: CHAIN_ID,
      maxValueAtomic,
    });
    console.log(`✓ typed-data policy set (JPYC only, to=forwarder, value ≤ ${MAX_SIGN_JPYC} JPYC)`);

    // 7. owner の TOTP (MFA) を登録 — signer 発行の前提。シークレットは操作者に引き渡す。
    let sessionToken = (await siweLogin(owner)).token;
    console.log('→ enrolling TOTP (MFA) for the owner…');
    const enrollBody = await jsonOrThrow(
      await fetch(`${URL_BASE}/auth/mfa/totp/enroll`, {
        method: 'POST',
        headers: tenantHeaders({ Authorization: `Bearer ${sessionToken}` }),
        body: '{}',
      }),
      'TOTP enroll',
    );
    const totpSecret = enrollBody.secret ?? enrollBody.data?.secret;
    if (!totpSecret) throw new BootstrapError('TOTP enroll returned no secret');
    // Persist one-time credentials before later provisioning can fail and lose the MFA factor.
    credentials.ownerTotpSecret = totpSecret;
    await checkpoint();
    await jsonOrThrow(
      await fetch(`${URL_BASE}/auth/mfa/totp/verify`, {
        method: 'POST',
        headers: tenantHeaders({ Authorization: `Bearer ${sessionToken}` }),
        body: JSON.stringify({ code: totpCode(totpSecret) }),
      }),
      'TOTP verify',
    );
    console.log('✓ TOTP enabled for the owner');
    // MFA 有効化も既存セッションを失効させる。境界を跨いで MFA チャレンジ付き再ログイン。
    await sleep(2_000);
    const mfaLogin = await siweLogin(owner);
    if (!mfaLogin.mfaChallengeId) throw new BootstrapError('expected an MFA challenge on re-login');
    // verify で直前の TOTP コードを消費済みのため、次の 30 秒窓まで待つ。
    console.log('→ waiting for the next TOTP window (≤ 31s)…');
    await nextTotpWindow();
    const completeBody = await jsonOrThrow(
      await fetch(`${URL_BASE}/auth/mfa/totp/complete`, {
        method: 'POST',
        headers: tenantHeaders({ Origin: URL_BASE }),
        body: JSON.stringify({ challengeId: mfaLogin.mfaChallengeId, code: totpCode(totpSecret) }),
      }),
      'TOTP complete',
    );
    const mfaToken = completeBody.token ?? completeBody.data?.token;
    if (!mfaToken) throw new BootstrapError('TOTP complete returned no session token');
    console.log('✓ MFA session established');

    // 8. signer 資格情報を発行 (secret はサーバー生成・この 1 回だけ返る)
    const signerBody = await jsonOrThrow(
      await fetch(`${URL_BASE}/agents/${agent.id}/signers`, {
        method: 'POST',
        headers: tenantHeaders({ Authorization: `Bearer ${mfaToken}` }),
        body: JSON.stringify({
          name: 'openpay-x402-mcp',
          signerType: 'service',
          subjectType: 'api_key',
          subjectId: 'openpay-x402-mcp',
          permissions: ['sign_typed_data'],
          issueCredential: true,
        }),
      }),
      'signer issuance',
    );
    const signerId = signerBody.data?.id;
    const signerSecret = signerBody.data?.credentialSecret ?? signerBody.data?.secret;
    if (!signerId || !signerSecret) throw new BootstrapError('signer issuance returned no id/secret');
    console.log('✓ signer issued (permissions: sign_typed_data)');

    // Persist signer credentials before any success output; secrets never enter stdout.
    Object.assign(credentials.env, { STEWARD_SIGNER_ID: signerId, STEWARD_SIGNER_SECRET: signerSecret });
    await checkpoint();
    console.log(`✓ credentials saved: ${output.path}`);
    console.log(`✓ agent: ${agent.id}; signer: ${signerId}`);
    console.log('入金: agent ウォレット ' + agentAddress + ' に JPYC を入れてください。');
    console.log('確認: MCP から x402_quote → totalJpyc が返れば配線 OK。');
  } finally { await output.handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Third-party signing/transport/I/O errors may contain keys or authenticated payloads.
  // Only our closed local messages and filtered diagnostics may cross into terminal/CI output.
  main().catch((err) => die((err instanceof BootstrapError || err instanceof PrivateOutputError
    ? err.message : 'Bootstrap failed (raw signing, transport or I/O error withheld)') + errorDiagnostics(err)));
}
