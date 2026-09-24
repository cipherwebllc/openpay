'use client';

// 出品者 (owner) の状態: 登録フォームの下書き・編集対象・結果/エラー表示と、自分の登録一覧 (SIWE 時のみ・
// wallet 単位の query key)・登録/編集/削除の mutation。成功時は公開カタログと owned の両方を invalidate する。
// X402DiscoveryView が 1 回だけ呼ぶ: 節の並び替えや wallet 切替で下書き・進行中の mutation を失わない。

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OwnedResource, RegisteredResource } from './discoveryTypes';

const EMPTY_FORM = {
  url: '',
  description: '',
  priceJpyc: '',
  category: '',
  payTo: '',
  title: '',
  trigger: '',
  docsUrl: '',
  license: '',
  // dual-rail USDC 面 (NEXT_PUBLIC_ENABLE_X402_DUAL_RAIL 点灯時のみ UI に出る)。
  usdcEnabled: false,
  usdcPriceUsd: '',
  usdcPayTo: '',
  usdcServiceName: '',
};

export function useDiscoveryOwner(address: string | undefined, isSignedIn: boolean) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState<boolean | null>(null);
  const registrationRef = useRef<HTMLElement>(null);
  const [editId, setEditId] = useState<string | null>(null); // 非 null = 編集中 (PATCH)
  const [created, setCreated] = useState<{
    resource: RegisteredResource;
    paywallSnippet: string;
  } | null>(null);
  const [notice, setNotice] = useState<'updated' | 'deleted' | null>(null);
  // USDC 面つきで登録/更新した直後の「サーバーのゲート貼り替え」リマインダー。
  // 貼り替えるまで実サーバーの 402 は JPYC のみ = USDC では買えない (実運用で発覚した期待違い)。
  const [usdcReminder, setUsdcReminder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSnippet, setErrorSnippet] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // 登録時 1 回きりだったスニペット表示を owner 一覧から再表示するためのトグル。
  const [snippetOpenId, setSnippetOpenId] = useState<string | null>(null);
  // 出品の正当性表明 (新規登録のみ必須・編集では不要)。送信成功でリセット。
  const [attested, setAttested] = useState(false);

  const queryClient = useQueryClient();

  // owner の登録一覧 (SIWE 時のみ・編集/削除の対象)。未サインインは enabled:false で取得せず owned は空。
  const ownedQuery = useQuery({
    queryKey: ['x402', 'owned', address],
    enabled: isSignedIn,
    queryFn: async () => {
      const res = await fetch('/api/facilitator/resources', { cache: 'no-store' });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const body = (await res.json()) as { resources?: OwnedResource[] };
      return body.resources ?? [];
    },
    retry: false,
  });

  const owned = ownedQuery.data ?? [];

  const onEdit = useCallback((r: OwnedResource) => {
    setEditId(r.id);
    setForm({
      url: r.url,
      description: r.description,
      priceJpyc: r.priceJpyc,
      category: r.category,
      payTo: r.payTo,
      title: r.title ?? '',
      trigger: r.trigger ?? '',
      docsUrl: r.docsUrl ?? '',
      license: r.license ?? '',
      usdcEnabled: Boolean(r.usdc),
      usdcPriceUsd: r.usdc?.priceUsd ?? '',
      usdcPayTo: r.usdc?.payTo ?? '',
      usdcServiceName: r.usdc?.serviceName ?? '',
    });
    setCreated(null);
    setNotice(null);
    setError(null);
    setErrorSnippet('');
    setConfirmDeleteId(null);
    setFormOpen(true);
    registrationRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  const onCancelEdit = useCallback(() => {
    setFormOpen(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setErrorSnippet('');
  }, []);

  // 登録 (editId 無し → POST) / 編集 (editId 有り → PATCH) を出し分ける。成功後は catalog / owned を
  // invalidate して再取得する (従来の void loadCatalog(); void loadOwned(); の置換)。fetch/parse の
  // 例外・!ok・resource 欠落はいずれも {ok:false} を返し、従来と同じエラー文言 (error コード) を出す。
  const submitMutation = useMutation({
    mutationFn: async (): Promise<
      | { ok: true; wasEdit: boolean; resource: RegisteredResource; paywallSnippet: string }
      | { ok: false; error: string; paywallSnippet: string }
    > => {
      const payload = {
        url: form.url,
        description: form.description,
        priceJpyc: form.priceJpyc,
        category: form.category,
        ...(form.payTo ? { payTo: form.payTo } : {}),
        ...(form.title ? { title: form.title } : {}),
        ...(form.trigger ? { trigger: form.trigger } : {}),
        ...(form.docsUrl ? { docsUrl: form.docsUrl } : {}),
        ...(form.license ? { license: form.license } : {}),
        // USDC 面は checkbox ON のときだけ送る (OFF = 編集で面を外す)。UI flag ではなく
        // form 状態で判定 — flag OFF 中の編集でも既存の USDC 面 (prefill) を黙って消さない。
        ...(form.usdcEnabled
          ? {
              usdc: {
                priceUsd: form.usdcPriceUsd.trim(),
                ...(form.usdcPayTo.trim() ? { payTo: form.usdcPayTo.trim() } : {}),
                ...(form.usdcServiceName.trim()
                  ? { serviceName: form.usdcServiceName.trim() }
                  : {}),
              },
            }
          : {}),
        // 新規登録のみ正当性表明を送る (サーバは POST でのみ必須・編集では無視)。
        ...(editId ? {} : { attested }),
      };
      try {
        const res = editId
          ? await fetch(`/api/facilitator/resources/${editId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
          : await fetch('/api/facilitator/resources', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
        const body = (await res.json().catch(() => ({}))) as {
          resource?: RegisteredResource;
          paywallSnippet?: string;
          error?: string;
        };
        if (!res.ok || !body.resource) {
          return {
            ok: false,
            error: body.error ?? 'error',
            paywallSnippet: body.paywallSnippet ?? '',
          };
        }
        return {
          ok: true,
          wasEdit: Boolean(editId),
          resource: body.resource,
          paywallSnippet: body.paywallSnippet ?? '',
        };
      } catch {
        return { ok: false, error: 'error', paywallSnippet: '' };
      }
    },
    onMutate: () => {
      setError(null);
      setErrorSnippet('');
      setNotice(null);
      setUsdcReminder(false);
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        setErrorSnippet(result.paywallSnippet);
        return;
      }
      // 送信時点の form 状態で判定 (成功後は form がリセットされるため onSuccess 内で参照しない
      // ように submit 前の値を使う — mutationFn closure の form は submit 時のもの)。
      setUsdcReminder(form.usdcEnabled);
      if (result.wasEdit) {
        setNotice('updated');
        setCreated(null);
      } else {
        setCreated({
          resource: result.resource,
          paywallSnippet: result.paywallSnippet,
        });
      }
      setForm(EMPTY_FORM);
      setEditId(null);
      setAttested(false);
      setFormOpen(null);
      void queryClient.invalidateQueries({ queryKey: ['x402', 'discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['x402', 'owned'] });
    },
  });

  // 無効化 (DELETE)。!ok は {ok:false} を返しエラー文言を出す。fetch 例外は従来どおり握らず
  // (エラー表示なし・確認 UI も維持)。成功後は catalog / owned を invalidate して再取得する。
  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<{ ok: boolean; error?: string }> => {
      const res = await fetch(`/api/facilitator/resources/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: body.error ?? 'error' };
      }
      return { ok: true };
    },
    onMutate: () => {
      setError(null);
      setErrorSnippet('');
      setNotice(null);
    },
    onSuccess: (result, id) => {
      if (!result.ok) {
        setError(result.error ?? 'error');
        return;
      }
      setConfirmDeleteId(null);
      if (editId === id) onCancelEdit(); // 編集中の掲載を消したらフォームも閉じる
      setNotice('deleted');
      void queryClient.invalidateQueries({ queryKey: ['x402', 'discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['x402', 'owned'] });
    },
  });

  return {
    form, setForm, formOpen, setFormOpen, registrationRef, editId, created, notice, setNotice,
    usdcReminder, error, errorSnippet, confirmDeleteId, setConfirmDeleteId, snippetOpenId,
    setSnippetOpenId, attested, setAttested, ownedQuery, owned, onEdit, onCancelEdit,
    submitMutation, deleteMutation,
  };
}

export type DiscoveryOwner = ReturnType<typeof useDiscoveryOwner>;
