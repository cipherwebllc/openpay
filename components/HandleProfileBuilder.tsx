'use client';

// 「プロフ」タブ: @handle の link-in-bio ページを組み立てるビルダー。受取先 + 受取方法
// (JPYC Polygon / JPYC Kaia) + 見た目 (名前/色/金額プリセット) + プロフィール
// (bio/avatar/SNSアイコン/links) を編集し、SIWE で取得/更新 (HandleClaimPanel)。
// USDC (cross-chain) は着金チェーンを選べず Base 固定になるためビルダーから提供終了 —
// 必要ならチップタブで個別に作成しリンク集へ追加する。既存レコードの usdc method は
// 公開ページでは引き続き描画されるが、ビルダーで更新すると外れる (編集時に明示)。
// レイアウトは他タブ (チップ/レジ) と同じ 2 カラム: 左=編集・右=ライブプレビュー+公開
// (lg で sticky 追従)。下書きは useHandleProfileDraft (localStorage・チップタブとは分離)。
// flag OFF で何も描画しない。

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { AddressInput } from '@/components/AddressInput';
import { HandleClaimPanel } from '@/components/HandleClaimPanel';
import { HandleProfileView } from '@/components/HandleProfile';
import { SocialIcon } from '@/components/SocialIconLinks';
import { methodLabel } from '@/components/ReceiveMethodPicker';
import {
  useHandleProfileDraft,
  DEFAULT_PROFILE_DRAFT,
} from '@/hooks/useHandleProfileDraft';
import { displaySymbolFor } from '@/lib/tokens';
import { COLOR_PATTERN, DECIMAL_PATTERN, TIP_PRESET_MAX } from '@/lib/url';
import {
  MAX_BIO_LEN,
  MAX_PROFILE_LINKS,
  MAX_SOCIAL_LINKS,
  type HandleReceiveMethod,
  type HandleTipConfig,
  type HandleProfile,
} from '@/lib/handle';

function isHttpsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none';

export function HandleProfileBuilder() {
  const t = useTranslations('HandleProfile');
  const tc = useTranslations('HandleClaim');
  const { settings: draft, setSettings, hydrated } = useHandleProfileDraft();
  const { address: connected } = useAccount();
  const [resolved, setResolved] = useState<Address | null>(null);
  // 編集中レコードが旧 USDC (cross-chain) method を持つか。更新で外れることを明示する。
  const [editedHadUsdc, setEditedHadUsdc] = useState(false);
  // どの @handle を編集中か (null = 新規作成)。「編集」でフォームが黙って書き換わるのが
  // 混乱源だったため、ヘッダのバッジ + パネルのバナーで対象を常時明示する。
  const [editingHandle, setEditingHandle] = useState<string | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);

  const colorValid = COLOR_PATTERN.test(draft.color);

  const methods = useMemo<HandleReceiveMethod[]>(() => {
    const m: HandleReceiveMethod[] = [];
    if (draft.jpycPolygon) m.push({ token: 'jpyc', chain: 'polygon' });
    if (draft.jpycKaia) m.push({ token: 'jpyc', chain: 'kaia' });
    return m;
  }, [draft.jpycPolygon, draft.jpycKaia]);

  // 入力中の有効プリセット (strict)。空欄や不正値は URL/保存に出さない。
  const validPresets = (list: string[]) =>
    list
      .map((p) => p.trim())
      .filter((p) => DECIMAL_PATTERN.test(p) && Number(p) > 0)
      .slice(0, TIP_PRESET_MAX);

  // 受取先: 生 0x アドレスは**入力値を最優先**で採用する。AddressInput は ENS 名以外で
  // onResolved を再発火しないため、「接続ウォレットを使う」/編集 prefill で resolved に入った
  // 旧アドレスが、その後に手入力した別アドレスを上書きしてしまう (誤送金) のを防ぐ。
  // ENS 名 (= isAddress 偽) のときだけ AddressInput が解決した resolved を使う。
  const effectiveReceiver = useMemo<Address | null>(() => {
    const raw = draft.to.trim();
    if (isAddress(raw)) return getAddress(raw);
    return resolved;
  }, [draft.to, resolved]);

  const config = useMemo<HandleTipConfig | null>(() => {
    if (!effectiveReceiver || methods.length === 0) return null;
    // builder が管理するのは to/name/color/methods/presets のみ。message/thanks/thanksUrl/
    // webhook (UI 非露出の高度 tip メタ) は **送らない** — 既存レコードのそれらは update 時に
    // サーバ側 (reserveOrUpdateHandle) が保持する。draft に carry すると別 handle へ漏れるため。
    return {
      to: effectiveReceiver,
      name: draft.name.trim() || undefined,
      color: colorValid ? draft.color : undefined,
      methods,
      presets: { jpyc: validPresets(draft.presetsJpyc) },
    };
  }, [
    effectiveReceiver,
    methods,
    draft.name,
    draft.color,
    colorValid,
    draft.presetsJpyc,
  ]);

  // 送信する profile は https / 非空のみ採用 (不正 link/avatar/social は除外 → claim を通す)。
  const trimmedLinks = draft.links
    .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
    .filter((l) => l.label && isHttpsUrl(l.url))
    .slice(0, MAX_PROFILE_LINKS);
  const validSocials = draft.socials
    .map((s) => s.trim())
    .filter((s) => isHttpsUrl(s))
    .slice(0, MAX_SOCIAL_LINKS);
  const avatarValid = !!draft.avatar.trim() && isHttpsUrl(draft.avatar.trim());
  const profile: HandleProfile = {
    bio: draft.bio.trim() || undefined,
    avatar: avatarValid ? draft.avatar.trim() : undefined,
    socials: validSocials.length > 0 ? validSocials : undefined,
    links: trimmedLinks.length > 0 ? trimmedLinks : undefined,
  };
  // 入力に非 https の link/avatar/social があれば注意喚起 (送信からは除外済み)。
  const hasInsecure =
    (!!draft.avatar.trim() && !avatarValid) ||
    draft.socials.some((s) => s.trim() && !isHttpsUrl(s.trim())) ||
    draft.links.some((l) => l.url.trim() && !isHttpsUrl(l.url.trim()));

  if (!env.enableHandles) return null;

  const update = (patch: Partial<typeof draft>) =>
    setSettings((s) => ({ ...s, ...patch }));

  const onUseConnected = () => {
    if (connected && isAddress(connected)) {
      update({ to: connected });
      setResolved(getAddress(connected));
    }
  };

  // 編集をやめて新規作成へ。フォームは既定に戻す (受取先だけは使い回せるので保持)。
  const onStopEditing = () => {
    setEditingHandle(null);
    setEditedHadUsdc(false);
    setSettings((s) => ({ ...DEFAULT_PROFILE_DRAFT, to: s.to }));
  };

  const onEditExisting = (
    handle: string,
    c: HandleTipConfig,
    p?: HandleProfile,
  ) => {
    setEditingHandle(handle);
    // パネル (右カラム/モバイルは下部) から押すとフォームの書き換わりが見えないため、
    // フォーム先頭へスクロールして「いま編集している」ことを視覚的に伝える。
    headingRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    setResolved(isAddress(c.to) ? getAddress(c.to) : null);
    // 旧レコードの USDC method はビルダーで編集できない → 更新で外れることを明示する。
    setEditedHadUsdc(c.methods.some((m) => m.token === 'usdc'));
    // 編集対象レコードに無いフィールドは「前の下書き値」(s.*) ではなく **builder 既定**へ戻す。
    // でないと別プロフィールの色/プリセットが update 時にこの handle へ混入する。
    setSettings((s) => ({
      ...s,
      to: c.to,
      name: c.name ?? '',
      color:
        c.color && COLOR_PATTERN.test(c.color)
          ? c.color
          : DEFAULT_PROFILE_DRAFT.color,
      jpycPolygon: c.methods.some((m) => m.token === 'jpyc' && m.chain === 'polygon'),
      jpycKaia: c.methods.some((m) => m.token === 'jpyc' && m.chain === 'kaia'),
      presetsJpyc: c.presets?.jpyc ?? DEFAULT_PROFILE_DRAFT.presetsJpyc,
      bio: p?.bio ?? '',
      avatar: p?.avatar ?? '',
      socials: p?.socials ?? [],
      links: p?.links ?? [],
    }));
  };

  // プリセット編集 (token 別)。
  const renderPresetEditor = (
    token: 'jpyc',
    list: string[],
    key: 'presetsJpyc',
  ) => (
    <Field label={t('presetsLabel', { token: displaySymbolFor(token) })}>
      <div className="space-y-1.5">
        {list.map((p, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={p}
              onChange={(e) => {
                const next = [...list];
                next[i] = e.target.value;
                update({ [key]: next } as Partial<typeof draft>);
              }}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => update({ [key]: list.filter((_, j) => j !== i) } as Partial<typeof draft>)}
              className="rounded-md border border-slate-200 px-2 text-sm text-slate-400 hover:text-red-600"
              aria-label={t('removePreset')}
            >
              ×
            </button>
          </div>
        ))}
        {list.length < TIP_PRESET_MAX && (
          <button
            type="button"
            onClick={() => update({ [key]: [...list, ''] } as Partial<typeof draft>)}
            className="text-xs font-medium text-brand hover:underline"
          >
            ＋ {t('addPreset')}
          </button>
        )}
      </div>
    </Field>
  );

  // プレビューは受取先が未確定でも常時表示 (config が組めない間は draft から見た目だけ組む)。
  const previewConfig: HandleTipConfig = config ?? {
    to: effectiveReceiver ?? '',
    name: draft.name.trim() || undefined,
    color: colorValid ? draft.color : undefined,
    methods,
  };

  return (
    <div className="space-y-6">
      <div ref={headingRef} className="scroll-mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-800">{t('builderHeading')}</h2>
          {editingHandle && (
            <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
              {tc('editingBanner', { handle: editingHandle })}
              <button
                type="button"
                onClick={onStopEditing}
                className="underline hover:text-amber-950"
              >
                {tc('stopEditing')}
              </button>
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">{t('builderSubheading')}</p>
      </div>

      {/* 2カラム: 左=編集 (page scroll) / 右=プレビュー+公開 (lg で sticky 追従)。 */}
      <div className="lg:grid lg:grid-cols-[1fr_minmax(300px,360px)] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-5">
      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
        {/* 受取先 */}
        <Field label={t('receiverLabel')} hint={t('receiverHint')}>
          <AddressInput
            value={draft.to}
            onChange={(v) => update({ to: v })}
            onResolved={setResolved}
          />
          {connected && (
            <button
              type="button"
              onClick={onUseConnected}
              className="mt-1.5 text-xs font-medium text-brand hover:underline"
            >
              {t('useConnectedWallet')}
            </button>
          )}
        </Field>

        {/* 受取方法 */}
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">{t('methodsLabel')}</legend>
          <div className="mt-1 space-y-1.5">
            {([
              ['jpycPolygon', { token: 'jpyc', chain: 'polygon' } as const],
              ['jpycKaia', { token: 'jpyc', chain: 'kaia' } as const],
            ] as const).map(([key, method]) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={draft[key]}
                  onChange={(e) => update({ [key]: e.target.checked } as Partial<typeof draft>)}
                />
                {methodLabel(method, t('crossChain'))}
              </label>
            ))}
          </div>
          {methods.length === 0 && (
            <p className="mt-1 text-xs text-red-600">{t('atLeastOneMethod')}</p>
          )}
          {editedHadUsdc && (
            <p className="mt-1 text-xs text-amber-700">{t('usdcDiscontinued')}</p>
          )}
        </fieldset>

        {/* 見た目 */}
        <Field label={t('nameLabel')}>
          <input
            type="text"
            value={draft.name}
            maxLength={60}
            onChange={(e) => update({ name: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label={t('colorLabel')}>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={colorValid ? draft.color : '#2563eb'}
              onChange={(e) => update({ color: e.target.value })}
              className="h-9 w-12 rounded border border-slate-300"
            />
            <input
              type="text"
              value={draft.color}
              onChange={(e) => update({ color: e.target.value })}
              placeholder="#2563eb"
              className={inputClass}
            />
          </div>
        </Field>
        {draft.jpycPolygon || draft.jpycKaia
          ? renderPresetEditor('jpyc', draft.presetsJpyc, 'presetsJpyc')
          : null}
      </div>

      {/* プロフィール (link-in-bio) */}
      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">{t('profileSection')}</h3>
        <Field
          label={t('bioLabel')}
          hint={`${draft.bio.trim().length}/${MAX_BIO_LEN}`}
        >
          <textarea
            value={draft.bio}
            maxLength={MAX_BIO_LEN}
            rows={2}
            onChange={(e) => update({ bio: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label={t('avatarLabel')} hint={t('avatarHint')}>
          <input
            type="url"
            value={draft.avatar}
            placeholder="https://"
            onChange={(e) => update({ avatar: e.target.value })}
            className={inputClass}
          />
        </Field>
        {/* SNS アイコンリンク (URL のみ・アイコンはドメイン自動判定) */}
        <Field label={t('socialsLabel')} hint={t('socialsHint')}>
          <div className="space-y-2">
            {draft.socials.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="shrink-0 text-slate-400">
                  <SocialIcon url={s.trim()} className="h-5 w-5" />
                </span>
                <input
                  type="url"
                  value={s}
                  placeholder="https://x.com/yourname"
                  onChange={(e) => {
                    const next = [...draft.socials];
                    next[i] = e.target.value;
                    update({ socials: next });
                  }}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() =>
                    update({ socials: draft.socials.filter((_, j) => j !== i) })
                  }
                  className="rounded-md border border-slate-200 px-2 text-sm text-slate-400 hover:text-red-600"
                  aria-label={t('removeSocial')}
                >
                  ×
                </button>
              </div>
            ))}
            {draft.socials.length < MAX_SOCIAL_LINKS && (
              <button
                type="button"
                onClick={() => update({ socials: [...draft.socials, ''] })}
                className="text-xs font-medium text-brand hover:underline"
              >
                ＋ {t('addSocial')}
              </button>
            )}
          </div>
        </Field>
        <Field label={t('linksLabel')} hint={t('httpsOnlyHint')}>
          <div className="space-y-2">
            {draft.links.map((l, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={l.label}
                  placeholder={t('linkLabelPlaceholder')}
                  maxLength={40}
                  onChange={(e) => {
                    const next = [...draft.links];
                    next[i] = { ...next[i], label: e.target.value };
                    update({ links: next });
                  }}
                  className={`${inputClass} flex-[2]`}
                />
                <input
                  type="url"
                  value={l.url}
                  placeholder="https://"
                  onChange={(e) => {
                    const next = [...draft.links];
                    next[i] = { ...next[i], url: e.target.value };
                    update({ links: next });
                  }}
                  className={`${inputClass} flex-[3]`}
                />
                <button
                  type="button"
                  onClick={() => update({ links: draft.links.filter((_, j) => j !== i) })}
                  className="rounded-md border border-slate-200 px-2 text-sm text-slate-400 hover:text-red-600"
                  aria-label={t('removeLink')}
                >
                  ×
                </button>
              </div>
            ))}
            {draft.links.length < MAX_PROFILE_LINKS && (
              <button
                type="button"
                onClick={() => update({ links: [...draft.links, { label: '', url: '' }] })}
                className="text-xs font-medium text-brand hover:underline"
              >
                ＋ {t('addLink')}
              </button>
            )}
          </div>
        </Field>
        {hasInsecure && (
          <p className="text-xs text-amber-700">{t('insecureDropped')}</p>
        )}
      </div>
        </div>

        {/* 右カラム: ライブプレビュー (常時) + 取得/更新 (SIWE)。desktop は sticky。 */}
        <aside className="mt-6 min-w-0 space-y-4 self-start lg:mt-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          {hydrated && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t('previewHeading')}
              </p>
              <div className="mx-auto max-w-xs rounded-xl bg-white p-4 shadow-sm">
                <HandleProfileView config={previewConfig} profile={profile} />
                {methods.length > 0 && (
                  <div className="mt-4 flex flex-col gap-2">
                    {methods.map((m, i) => (
                      <span
                        key={i}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-center text-sm font-semibold text-slate-600"
                      >
                        {t('supportWith', { label: methodLabel(m, t('crossChain')) })}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <HandleClaimPanel
            config={config}
            profile={profile}
            onEdit={onEditExisting}
            editingHandle={editingHandle}
            onStopEditing={onStopEditing}
            onPublished={(h) => {
              setEditingHandle(h);
              // 公開後のレコードは builder 製 = USDC method を含まないため、旧レコード由来の
              // 「USDC 提供終了」通知は以後 stale (更新で外れる、はもう外れた後)。
              setEditedHadUsdc(false);
            }}
          />
        </aside>
      </div>
    </div>
  );
}
