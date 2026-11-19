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
// 認証状態が変わったら freee/entitlement/pro/csvpass/tip-messages のキャッシュも破棄する。
// これらは wallet 固有なので別 wallet へのログイン/ログアウト後に旧 wallet の
// status/mapping/inbox を再利用させない。
const AUTH_DEPENDENT_KEYS = [
  ['siwe', 'me'],
  ['freee'],
  ['entitlement'],
  ['pro'],
  ['csvpass'],
  ['tip-messages'],
] as const;

type MeResponse = { ok: boolean; address: Address | null; imageUpload?: boolean; imageUploadSignIn?: boolean };

/** /me の cache の値。画像の 2 つは server が true のときだけ送る (欠けていれば false)。 */
type MeData = { address: Address | null; imageUpload: boolean; imageUploadSignIn: boolean };

async function fetchMe(): Promise<MeData> {
  const res = await fetch('/api/auth/siwe/me', { cache: 'no-store' });
  if (!res.ok) throw new Error(`siwe_me_http_${res.status}`);
  const json = (await res.json()) as MeResponse;
  return {
    address: json.address ?? null,
    imageUpload: json.imageUpload === true,
    imageUploadSignIn: json.imageUploadSignIn === true,
  };
}

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
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
      const res = await postJson('/api/auth/siwe/logout');
      // 失効の失敗を成功扱いにして、セッションが残った端末を安全だと誤認させない。
      if (!res.ok) throw new Error(`siwe_logout_http_${res.status}`);
    },
    onSuccess: invalidateAuthScoped,
  });

  const sessionAddress = me.data?.address ?? null;
  const sameAddress =
    !!sessionAddress &&
    !!address &&
    sessionAddress.toLowerCase() === address.toLowerCase();

  return {
    sessionAddress,
    /** セッションが現在接続中の wallet と一致してログイン済か。 */
    isSignedIn: sameAddress,
    /**
     * サインイン済みの本人が画像のアップロード・一覧・削除を使えるか (/me の imageUpload)。今の取得が成功していて、
     * セッションが接続中の wallet と一致しているときだけ true (取り直しの失敗中・別の wallet に切り替えた後は、前の true を使わない)。
     */
    imageUpload: sameAddress && me.isSuccess && me.data.imageUpload,
    /** サインインすると画像の機能を使えるかもしれない (/me の imageUploadSignIn・ヘッダのサインインの導線 = 掟 7)。 */
    imageUploadSignIn: me.isSuccess && me.data.imageUploadSignIn,
    /**
     * /me を取り直す (画面の API が 401 session_mismatch・403 などで「本人が替わった・権限が無くなった」と分かったとき)。
     * 結果は sessionAddress・isSignedIn・imageUpload に反映される。
     */
    refreshSession: () => qc.invalidateQueries({ queryKey: ME_KEY }),
    /** セッションは在るが接続中 wallet と別アドレス (要再ログイン)。 */
    mismatch: !!sessionAddress && !!address && !sameAddress,
    isLoading: me.isLoading,
    signIn: (statement: string) => signIn.mutateAsync(statement),
    isSigningIn: signIn.isPending,
    signInError: signIn.error as Error | null,
    signOut: () => signOut.mutateAsync(),
    isSigningOut: signOut.isPending,
    signOutError: signOut.error as Error | null,
  };
}
