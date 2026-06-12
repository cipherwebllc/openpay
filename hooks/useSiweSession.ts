'use client';

// SIWE ログインの client hook。接続中の wallet で nonce を取得 → EIP-4361 message を
// 署名 → /verify でセッション cookie を確立する。現在のセッションは /me を React Query で
// 保持し、サインイン/アウト後に invalidate して再取得する。
//
// wallet 切替検知: セッションのアドレスと現在接続中アドレスが食い違う (mismatch) 場合、
// 呼出側 (WalletBadge) は「再ログイン」を促す。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount, useSignMessage } from 'wagmi';
import { createSiweMessage } from 'viem/siwe';
import type { Address } from 'viem';

const ME_KEY = ['siwe', 'me'] as const;
// nonce TTL (server: 10分) に合わせ message の有効期限も 10 分にする。
const MESSAGE_TTL_MS = 10 * 60_000;
// 認証状態が変わったら freee/entitlement/pro のキャッシュも破棄する。これらは wallet 固有なので
// 別 wallet へのログイン/ログアウト後に旧 wallet の status/mapping を再利用させない。
const AUTH_DEPENDENT_KEYS = [
  ['siwe', 'me'],
  ['freee'],
  ['entitlement'],
  ['pro'],
] as const;

type MeResponse = { ok: boolean; address: Address | null };

async function fetchMe(): Promise<Address | null> {
  const res = await fetch('/api/auth/siwe/me', { cache: 'no-store' });
  if (!res.ok) return null;
  const json = (await res.json()) as MeResponse;
  return json.address ?? null;
}

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function useSiweSession() {
  const { address, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();

  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    staleTime: 60_000,
    retry: 1,
  });

  const invalidateAuthScoped = () => {
    for (const key of AUTH_DEPENDENT_KEYS) {
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const signIn = useMutation({
    // statement は wallet の署名プロンプトに表示される文言 (呼出側で i18n を渡す)。
    mutationFn: async (statement: string) => {
      if (!address || !chainId) throw new Error('wallet_not_connected');
      const nonceRes = await postJson('/api/auth/siwe/nonce');
      if (!nonceRes.ok) throw new Error('nonce_failed');
      const { nonce } = (await nonceRes.json()) as { nonce: string };
      const issuedAt = new Date();
      const message = createSiweMessage({
        domain: window.location.host,
        address,
        statement,
        uri: window.location.origin,
        version: '1',
        chainId,
        nonce,
        issuedAt,
        expirationTime: new Date(issuedAt.getTime() + MESSAGE_TTL_MS),
      });
      const signature = await signMessageAsync({ message });
      const verifyRes = await postJson('/api/auth/siwe/verify', { message, signature });
      if (!verifyRes.ok) {
        const err = (await verifyRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? 'verify_failed');
      }
    },
    onSuccess: invalidateAuthScoped,
  });

  const signOut = useMutation({
    mutationFn: async () => {
      await postJson('/api/auth/siwe/logout');
    },
    onSuccess: invalidateAuthScoped,
  });

  const sessionAddress = me.data ?? null;
  const sameAddress =
    !!sessionAddress &&
    !!address &&
    sessionAddress.toLowerCase() === address.toLowerCase();

  return {
    sessionAddress,
    /** セッションが現在接続中の wallet と一致してログイン済か。 */
    isSignedIn: sameAddress,
    /** セッションは在るが接続中 wallet と別アドレス (要再ログイン)。 */
    mismatch: !!sessionAddress && !!address && !sameAddress,
    isLoading: me.isLoading,
    signIn: (statement: string) => signIn.mutateAsync(statement),
    isSigningIn: signIn.isPending,
    signInError: signIn.error as Error | null,
    signOut: () => signOut.mutateAsync(),
  };
}
