#!/usr/bin/env node
// steward-bootstrap — self-host Steward を openpay-x402-mcp の署名バックエンドにするための
// 自動セットアップ。tenant 作成 → self-join open → owner の SIWE ログイン → owner 昇格 →
// agent (ウォレット) 作成 → JPYC typed-data ポリシー付与、までを 1 コマンドで行い、
// 最後に MCP 用の env ブロックを出力する。
//
// signer 資格情報の発行 (STEWARD_SIGNER_ID / SECRET) だけは Steward が意図的に
// 「管理者の MFA 付き human セッション」に限定しているため、このスクリプトは
// signer 発行の直前で停止し、続きの正確な手順を表示する (設計を尊重し、人手ゲートを
// スクリプトで無理に迂回しない)。
//
// 依存: viem のみ。実行:
//   OWNER_PRIVATE_KEY=0x... STEWARD_PLATFORM_KEY=... node steward-bootstrap.mjs
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

import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { isHex } from 'viem';

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

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

if (!PLATFORM_KEY) die('STEWARD_PLATFORM_KEY is required (one of the server STEWARD_PLATFORM_KEYS).');
if (!OWNER_KEY || !isHex(OWNER_KEY) || OWNER_KEY.length !== 66) {
  die('OWNER_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string.');
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

async function jsonOrThrow(res, label) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok && body?.ok !== true) {
    throw new Error(`${label} failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
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
  if (!nonce) throw new Error('SIWE nonce missing in response');

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
  if (!token || !userId) throw new Error('SIWE verify returned no token/userId');
  return { token, userId };
}

async function main() {
  const owner = privateKeyToAccount(OWNER_KEY);
  console.log(`→ Steward: ${URL_BASE}`);
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
    console.log(`✓ tenant "${TENANT_ID}" created`);
  } else if (tRes.status === 409 || /exists/i.test(JSON.stringify(tBody))) {
    console.log(`• tenant "${TENANT_ID}" already exists — reusing`);
    console.log('  (tenant API key is shown only at creation. If you lost it, delete and');
    console.log('   recreate the tenant, or rotate it via the platform API.)');
  } else {
    throw new Error(`tenant create failed (${tRes.status}): ${JSON.stringify(tBody).slice(0, 200)}`);
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

  // 5. agent (ウォレット)
  if (!apiKey) {
    console.log('\n⚠ tenant を再利用したため tenant API key が手元にありません。');
    console.log('  以降 (agent 作成・ポリシー・env 出力) には STEWARD_API_KEY が必要です。');
    console.log('  一度 tenant を作り直して apiKey を控えてから再実行してください。');
    process.exit(2);
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
      throw new Error(`agent create failed (${aRes.status}): ${JSON.stringify(aBody).slice(0, 200)}`);
    }
    console.log(`• agent "${AGENT_ID}" already exists — reusing`);
  } else {
    console.log(`✓ agent created: ${agent.id}`);
  }
  const agentAddress = agent.walletAddress ?? agent.walletAddresses?.evm;

  // 6. JPYC typed-data ポリシー (JPYC 宛・forwarder 宛・上限額)
  const maxValueAtomic = (BigInt(MAX_SIGN_JPYC) * 10n ** 18n).toString();
  const policyRes = await fetch(`${URL_BASE}/agents/${agent.id}/policies`, {
    method: 'PUT',
    headers: tenantHeaders({ 'X-Steward-Key': apiKey }),
    body: JSON.stringify([
      {
        id: 'jpyc-receive',
        type: 'typed-data',
        enabled: true,
        config: {
          verifyingContractAllowlist: [JPYC_ADDRESS],
          allowedChainIds: [CHAIN_ID],
          allowedPrimaryTypes: ['ReceiveWithAuthorization'],
          messageConditions: [
            { field: 'to', operator: 'address_in', values: [FORWARDER_ADDRESS] },
            { field: 'value', operator: 'uint_max', value: maxValueAtomic },
          ],
        },
      },
    ]),
  });
  const policyBody = await policyRes.json().catch(() => ({}));
  if (policyRes.ok && policyBody?.ok !== false) {
    console.log(`✓ typed-data policy set (JPYC only, to=forwarder, value ≤ ${MAX_SIGN_JPYC} JPYC)`);
  } else if (/Unknown policy type/i.test(JSON.stringify(policyBody))) {
    console.log('⚠ typed-data policy を登録できませんでした (Steward の既知バグ)。');
    console.log('  Steward-Fi/steward#162 / #163 の修正が入っていない版です。修正を当てるか、');
    console.log('  暫定的に起動 env に次を足してください (宛先/金額ポリシーは効かなくなります。');
    console.log('  MCP 側のガードは有効なままです):');
    console.log('    STEWARD_ALLOW_UNSAFE_TYPED_DATA_SIGNING=true');
    console.log('    STEWARD_ALLOW_VAULT_UNSAFE_TYPED_DATA_SIGNING=true');
  } else {
    throw new Error(`policy set failed (${policyRes.status}): ${JSON.stringify(policyBody).slice(0, 200)}`);
  }

  // 7. env ブロック出力 + signer 発行の残手順
  console.log('\n────────────────────────────────────────────────────────');
  console.log('MCP env (signer 以外は埋まっています):\n');
  console.log(JSON.stringify(
    {
      SIGNER_MODE: 'steward',
      STEWARD_URL: URL_BASE,
      STEWARD_TENANT: TENANT_ID,
      STEWARD_API_KEY: apiKey,
      STEWARD_AGENT_ID: agent.id,
      STEWARD_AGENT_ADDRESS: agentAddress,
      STEWARD_SIGNER_ID: '<下記 8 で発行>',
      STEWARD_SIGNER_SECRET: '<下記 8 で発行>',
    },
    null,
    2,
  ));
  console.log('\n8. signer の発行 (Steward が意図的に human MFA を要求する唯一の手順):');
  console.log('   - steward.fi ホスト版ダッシュボードを使う場合はそこで発行するのが最短です。');
  console.log('   - self-host のみの場合は、owner アカウントで MFA (TOTP/passkey) を有効化した');
  console.log('     セッションで次を実行します:');
  console.log(`       POST ${URL_BASE}/agents/${agent.id}/signers`);
  console.log('       Authorization: Bearer <MFA 済み session token>  X-Steward-Tenant: ' + TENANT_ID);
  console.log('       { "name": "mcp", "permissions": ["sign_typed_data"] }');
  console.log('   発行された signerId / signerSecret を上の env に入れれば MCP 配線完了です。');
  console.log('\n入金: agent ウォレット ' + agentAddress + ' に JPYC を入れてください。');
  console.log('確認: MCP から x402_quote → totalJpyc が返れば配線 OK。\n');
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
