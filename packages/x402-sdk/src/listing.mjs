// コード出品クライアント: 出品フォームを開かずに、SIWE サインイン込みで AI ストアの
// 出品を登録・一覧・更新・無効化する (POST/GET/PATCH/DELETE /api/facilitator/resources)。
//
// 法的に重要: register には **attested: true の明示が必須** (自動付与しない)。これは
// 「登録するリソースを提供・課金する正当な権利を有し、支払い (HTTP 402 等) でゲートして
// いる」という出品者本人の表明であり、SDK が代わりに宣言してよいものではない。
//
// セッション: 初回操作時に SIWE (EIP-4361) でサインインし cookie を保持・再利用する。
// 鍵はメモリ内でのみ使用し、どこにも送信しない (署名のみ)。

import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const DEFAULT_OPENPAY_ORIGIN = 'https://open-pay.jp';
const SIWE_MESSAGE_TTL_MS = 5 * 60_000;
const DEFAULT_SIWE_CHAIN_ID = 137; // Polygon (OpenPay の常時サポートチェーン)
const DEFAULT_STATEMENT = 'Sign in to OpenPay to manage your x402 listings.';

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createListingClient({
  privateKey,
  openpayOrigin = DEFAULT_OPENPAY_ORIGIN,
  fetchImpl = globalThis.fetch,
  chainId = DEFAULT_SIWE_CHAIN_ID,
  statement = DEFAULT_STATEMENT,
  now = Date.now,
}) {
  if (typeof privateKey !== 'string' || !privateKey.startsWith('0x')) {
    throw new Error('privateKey (0x...) is required');
  }
  const account = privateKeyToAccount(privateKey);
  const origin = openpayOrigin.replace(/\/+$/, '');
  let cookie = null;

  async function signIn() {
    const nonceResponse = await fetchImpl(`${origin}/api/auth/siwe/nonce`, {
      method: 'POST',
    });
    const nonceBody = await readJson(nonceResponse);
    if (!nonceResponse.ok || typeof nonceBody?.nonce !== 'string') {
      throw new Error(`siwe nonce failed: HTTP ${nonceResponse.status}`);
    }
    const issuedAt = new Date(now());
    const message = createSiweMessage({
      domain: new URL(origin).host,
      address: account.address,
      statement,
      uri: origin,
      version: '1',
      chainId,
      nonce: nonceBody.nonce,
      issuedAt,
      expirationTime: new Date(issuedAt.getTime() + SIWE_MESSAGE_TTL_MS),
    });
    const signature = await account.signMessage({ message });
    const verifyResponse = await fetchImpl(`${origin}/api/auth/siwe/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    });
    if (!verifyResponse.ok) {
      const body = await readJson(verifyResponse);
      throw new Error(`siwe verify failed: ${body?.error ?? `HTTP ${verifyResponse.status}`}`);
    }
    const setCookie = verifyResponse.headers.get('set-cookie') ?? '';
    const sessionCookie = setCookie.split(';')[0];
    if (!sessionCookie.includes('=')) {
      throw new Error('siwe verify returned no session cookie');
    }
    cookie = sessionCookie;
  }

  async function authedFetch(path, init = {}, retried = false) {
    if (cookie === null) await signIn();
    const response = await fetchImpl(`${origin}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), cookie },
    });
    // セッション失効 (401) は一度だけサインインし直して再試行する。
    if (response.status === 401 && !retried) {
      cookie = null;
      return authedFetch(path, init, true);
    }
    return response;
  }

  function buildBody(input) {
    const { url, description, priceJpyc, category, docsUrl, license, payTo, usdc } = input;
    return {
      url,
      description,
      priceJpyc,
      category,
      ...(docsUrl ? { docsUrl } : {}),
      ...(license ? { license } : {}),
      ...(payTo ? { payTo } : {}),
      ...(usdc ? { usdc } : {}),
    };
  }

  async function expectOk(response, okStatus) {
    const body = await readJson(response);
    if (response.status !== okStatus) {
      throw new Error(
        `openpay listing API failed: HTTP ${response.status} ${body?.error ?? ''}`.trim(),
      );
    }
    return body;
  }

  return {
    /** SIWE でサインインする出品者アドレス (checksum)。 */
    address: account.address,

    /**
     * 出品を登録する。attested: true の明示が必須 —
     * 「このリソースを提供・課金する正当な権利があり、402 等の支払いゲートを実装している」
     * という出品者本人の表明で、SDK は代行しない。
     * 戻り値: { resource, paywallSnippet } (usdc 面つきなら dual-rail スニペット)。
     */
    async register(input) {
      if (input?.attested !== true) {
        throw new Error(
          'attested: true is required — you must personally affirm that you have the right ' +
            'to provide and charge for this resource and that it is payment-gated (HTTP 402).',
        );
      }
      const response = await authedFetch('/api/facilitator/resources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...buildBody(input), attested: true }),
      });
      return expectOk(response, 201);
    },

    /** 自分の出品一覧 (paywallSnippet つき)。 */
    async list() {
      const response = await authedFetch('/api/facilitator/resources');
      const body = await expectOk(response, 200);
      return body.resources ?? [];
    },

    /** 出品を編集する (usdc を省略すると USDC 面は外れる — 現状維持は前回の値を渡す)。 */
    async update(id, input) {
      const response = await authedFetch(
        `/api/facilitator/resources/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildBody(input)),
        },
      );
      return expectOk(response, 200);
    },

    /** 出品を無効化する (公開カタログから外す・履歴は残る)。 */
    async deactivate(id) {
      const response = await authedFetch(
        `/api/facilitator/resources/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      await expectOk(response, 200);
      return true;
    },
  };
}
