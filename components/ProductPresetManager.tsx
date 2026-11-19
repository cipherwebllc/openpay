'use client';

// 商品プリセットの管理 UI (レジモード内に統合)。状態は親 (RegisterMode) が持つ
// useProductPresets を props で受け取り、単一 store インスタンスを共有する
// (同一タブ内で 2 つ hook を持つと storage event が飛ばず state が乖離するため)。
//
// 商品の画像 (アップロード): /api/auth/siwe/me の imageUpload (サインイン済みで、セッションが接続中の wallet と一致し、今の
// 取得が成功しているときだけ) が true で、商品の一覧を読み込んだ後だけ、画像の URL の欄を画像の欄 (components/ImageField・
// 用途 preset・長辺 800) にする。サインインしていなくて imageUploadOpen (段階 all) が true なら「サインインすると画像を
// アップロードできます」の 1 行と今の URL の欄。それ以外 (段階 off・設定が無い・取得の失敗) は今の画面のまま。保存の形は今と
// 同じ (この端末の localStorage の https URL の文字列)・レジと会計と URL の入力はいつも使える。
// - 欄ごと (商品の id・追加のフォーム) に操作の番号 (hooks/useImageUpload)。送り始め・URL の手入力 (今の URL の欄でも)・外す・
//   行の削除・追加の後の片づけで進め、送り始めの番号のままのときだけ結果を入れる。本人・段階が替わったら (layout effect)・
//   シートを閉じたら、全部の欄の番号を進める。
// - 結果は updatePreset で、最新の一覧の同じ id の行の image だけを変える (描画のときの一覧を書き戻さない・行が消えていたら
//   入らない)。別のタブの変更は、送っている間は取り込まず (親が holdImport)、書くときに最新の一覧に画像だけを重ねる
//   (hooks/useProductPresets の rebase)。
// - 追加のフォームの画像を送っている間は「追加」を止める (届く前の行を作らない)。

import { useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { ExternalImage } from './ExternalImage';
import { Field } from './Field';
import { ImageField } from './ImageField';
import { ProductOptionEditor } from './ProductOptionEditor';
import { env } from '@/lib/env';
import { PRESET_IMAGE_MAX, type ProductPreset } from '@/hooks/useProductPresets';
import {
  IMAGE_UPLOAD_OFF,
  imageUploadScopeOf,
  useImageBusyKeys,
  useImageFieldOperations,
} from '@/hooks/useImageUpload';
import { useSiweSession } from '@/hooks/useSiweSession';
import { IMAGE_MAX_EDGE } from '@/lib/images/purpose';
import type { ShopLiveState } from '@/lib/shopLive';
import { TAX_OPTIONS, defaultRateForCategory, type TaxCategory } from '@/lib/tax';
import { TOKEN_SYMBOLS, defaultDeploymentForSymbol, type TokenSymbol } from '@/lib/tokens';

type Props = {
  presets: ProductPreset[];
  addPreset: (input: Omit<ProductPreset, 'id' | 'sortOrder'>) => void;
  updatePreset: (
    id: string,
    patch: Partial<Omit<ProductPreset, 'id' | 'sortOrder'>>,
  ) => void;
  removePreset: (id: string) => void;
  movePreset: (id: string, dir: 'up' | 'down') => void;
  shopLive?: {
    state: ShopLiveState;
    toggleSoldOut: (itemId: string, value: boolean) => void;
    isPending: boolean;
  };
  /** 商品の一覧を読み込んだ後か (読み込みで一覧が入れ替わるので、それまでは画像の欄を出さない = アップロードを始めない)。 */
  hydrated?: boolean;
  /**
   * 画像をアップロード中の欄を親へ知らせる (送り始めのイベントの中で同期に・親は別のタブの商品の取り込みを保留する)。key は
   * 欄を作り直すたびに変わる (作り直す前の欄の後片づけが、作り直した欄の印を消さない)。
   */
  onImageBusyChange?: (key: string, busy: boolean) => void;
};

/**
 * 画像の欄の key (操作の番号と、親へ知らせる busy の両方に使う)。既存の行は `row:<商品の id>`、追加のフォームは `new`。商品の
 * id はどんな文字列もありうる (公開中のメニューから読み込んだ id も入る) ので、id をそのまま key にせず、必ず接頭辞を付ける
 * (追加のフォームの key とぶつかると、片方の結果が捨てられ、送っている間の取り込みの保留も外れる)。
 */
const NEW_ROW = 'new';
const rowKey = (id: string) => `row:${id}`;
// この部品を作るたびの通し番号 (シートを開き直したときの欄の印を、前に開いていたときの欄の印と分ける)。
let managerSeq = 0;

const EMPTY_DRAFT = {
  name: '',
  unitPrice: '',
  token: 'jpyc' as TokenSymbol,
  taxCategory: 'taxable_10' as TaxCategory,
  image: '',
  category: '',
};

// 商品画像 (任意の第三者 URL) の小さなプレビュー。Referer (OpenPay の origin) を画像ホストへ
// 渡さない。読込失敗は壊れ画像 icon ではなく同寸の装飾枠で置き換える (枠ごと消すと入力中の途中 URL
// が失敗するたびに横の入力欄が左右に跳ねるため)。失敗した URL だけを記録するので、URL を直せば
// 新しい画像を再試行する。
function PresetThumbnail({ url }: { url: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) {
    return <span aria-hidden className="h-8 w-8 shrink-0 rounded bg-slate-100" />;
  }
  return (
    <ExternalImage
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      className="h-8 w-8 shrink-0 rounded object-cover"
      onError={() => setFailedUrl(url)}
    />
  );
}

export function ProductPresetManager({
  presets,
  addPreset,
  updatePreset,
  removePreset,
  movePreset,
  shopLive,
  hydrated = false,
  onImageBusyChange,
}: Props) {
  const t = useTranslations('ProductPresetManager');
  const tImage = useTranslations('ImageField');
  const locale = useLocale();
  const tTax = useTranslations('Tax');
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  // 追加フォームの欄を見出しと結ぶ id (読み上げで欄の名前が placeholder だけにならないように)。
  const formId = useId();
  // 画像の欄を出すか (/me の imageUpload)。一覧を読み込むまでは出さない。
  const session = useSiweSession();
  const imageScope = hydrated ? imageUploadScopeOf(session) : IMAGE_UPLOAD_OFF;
  const imageFields = imageScope.access === 'upload';
  const images = useImageFieldOperations(imageScope.key);
  const [instance] = useState(() => ++managerSeq);
  const busyKey = (field: string) => `preset#${instance}:${imageScope.key}:${field}`;
  // 追加のフォームの画像を送っている (「追加」を止める)。state は無効の表示、ref は押したときの判定 (表示の確定を待たない)。
  const newRowBusy = useImageBusyKeys();
  const newRowBusyRef = useRef(new Set<string>());
  const onNewRowBusyChange = (busy: boolean) => {
    const key = busyKey(NEW_ROW);
    if (busy) newRowBusyRef.current.add(key);
    else newRowBusyRef.current.delete(key);
    newRowBusy.setBusy(key, busy);
    onImageBusyChange?.(key, busy);
  };

  const canAdd = draft.name.trim().length > 0 && /^\d+(\.\d+)?$/.test(draft.unitPrice);

  function handleAdd() {
    if (!canAdd || newRowBusyRef.current.size > 0) return;
    addPreset({
      name: draft.name.trim(),
      unitPrice: draft.unitPrice,
      token: draft.token,
      taxRate: defaultRateForCategory(draft.taxCategory),
      taxCategory: draft.taxCategory,
      memo: null,
      enabled: true,
      image: draft.image.trim() || undefined,
      category: draft.category.trim() || undefined,
    });
    // 追加のフォームを空にする前に番号を進める (前に始まって届いていない画像を、空にしたフォームに入れない)。
    images.advance(NEW_ROW);
    setDraft(EMPTY_DRAFT);
  }

  return (
    <div className="space-y-4">
      {/* 既存プリセット一覧 */}
      {presets.length === 0 ? (
        <p className="text-xs text-slate-500">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {presets.map((p, i) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2"
            >
              <input
                type="text"
                value={p.name}
                aria-label={t('nameLabel')}
                onChange={(e) => updatePreset(p.id, { name: e.target.value })}
                // 商品名は 1 行に取る (編集シートは PC でも幅が狭く、価格・税区分と並べると商品名が数文字まで潰れるため)。
                className="h-11 w-full min-w-0 flex-none rounded-md border border-slate-200 px-2 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm"
                maxLength={80}
              />
              <input
                type="text"
                inputMode="decimal"
                value={p.unitPrice}
                aria-label={t('priceLabel')}
                onChange={(e) =>
                  updatePreset(p.id, {
                    unitPrice: e.target.value.replace(/[^\d.]/g, ''),
                  })
                }
                className="h-11 w-20 rounded-md border border-slate-200 px-2 text-right font-mono text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm"
              />
              <span className="text-xs text-slate-500">
                {defaultDeploymentForSymbol(p.token).displaySymbol}
              </span>
              <select
                value={p.taxCategory ?? ''}
                aria-label={t('taxLabel')}
                onChange={(e) => {
                  const v = e.target.value;
                  const cat = v === '' ? null : (v as TaxCategory);
                  updatePreset(p.id, {
                    taxCategory: cat,
                    taxRate: cat ? defaultRateForCategory(cat) : null,
                  });
                }}
                className="h-11 rounded-md border border-slate-200 px-1 text-base focus:border-brand focus:outline-none sm:text-sm"
              >
                <option value="">{tTax('none')}</option>
                {TAX_OPTIONS.map((o) => (
                  <option key={o.category} value={o.category}>
                    {tTax(o.i18nKey)}
                  </option>
                ))}
              </select>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => movePreset(p.id, 'up')}
                  disabled={i === 0}
                  aria-label={t('moveUp')}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronUp className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => movePreset(p.id, 'down')}
                  disabled={i === presets.length - 1}
                  aria-label={t('moveDown')}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(t('removeConfirm', { name: p.name }))) {
                      // 消した行に向けて送っている画像は、届いても入れない (同じ id の行がまたできても)。
                      images.advance(rowKey(p.id));
                      removePreset(p.id);
                    }
                  }}
                  aria-label={t('remove')}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {/* 専用の全幅行へ (商品名欄を潰さない)。画像 URL は短めにし、その横へ 表示/おすすめ
                  チェックボックスを移動 (主行は商品名を広く取る)。カテゴリーは別グループに分離。 */}
              <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
                {/* 画像 URL は幅が足りないとき縮み切らずに次の行へ回す (表示/おすすめ/カテゴリーに押されて幅 0 にならないように)。 */}
                {imageFields ? (
                  // 画像の欄 (アップロード)。本人・段階が替わったら作り直す (前に始まった送信をやめる)。結果は最新の一覧の
                  // 同じ id の行の image だけに入る (updatePreset・行が消えていたら入らない)。
                  <div className="w-full">
                    <ImageField
                      key={`${imageScope.key}:${rowKey(p.id)}`}
                      id={`${formId}-image-${i}`}
                      label={t('imageUploadLabel')}
                      urlLabel={t('imageLabel')}
                      value={p.image ?? ''}
                      onChange={(url) => updatePreset(p.id, { image: url.trim() || undefined })}
                      purpose="preset"
                      onBusyChange={(busy) => onImageBusyChange?.(busyKey(rowKey(p.id)), busy)}
                      operation={images.operation(rowKey(p.id))}
                      urlMaxLength={PRESET_IMAGE_MAX}
                      previewClassName="h-16 w-16 rounded-lg"
                    />
                  </div>
                ) : (
                <div className="flex min-w-[10rem] flex-1 items-center gap-2">
                  {p.image && <PresetThumbnail url={p.image} />}
                  <input
                    type="url"
                    value={p.image ?? ''}
                    aria-label={t('imageLabel')}
                    placeholder={t('imagePlaceholder')}
                    onChange={(e) => {
                      // 手で書いた URL が最後の操作 (画像の欄から切り替わる前に始まった送信の結果で上書きしない)。
                      images.advance(rowKey(p.id));
                      updatePreset(p.id, { image: e.target.value.trim() || undefined });
                    }}
                    className="h-11 min-w-0 flex-1 rounded-md border border-slate-200 px-2 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm"
                  />
                </div>
                )}
                {/* 表示 (有効) + おすすめ (主行から移動・商品名を広く取るため)。 */}
                <label className="flex min-h-11 shrink-0 items-center gap-1.5 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={p.enabled}
                    onChange={(e) => updatePreset(p.id, { enabled: e.target.checked })}
                  />
                  {t('enabledLabel')}
                </label>
                {env.enableShopLive && (
                  <label className="flex min-h-11 shrink-0 items-center gap-1.5 text-xs text-slate-500">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={p.recommended ?? false}
                      onChange={(e) =>
                        updatePreset(p.id, { recommended: e.target.checked || undefined })
                      }
                    />
                    {t('recommendedLabel')}
                  </label>
                )}
                {shopLive && (
                  <label className="flex min-h-11 shrink-0 items-center gap-1.5 text-xs text-slate-500">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={shopLive.state.soldOut.includes(p.id)}
                      disabled={shopLive.isPending}
                      onChange={(e) => shopLive.toggleSoldOut(p.id, e.target.checked)}
                    />
                    {t('soldOutToggle')}
                  </label>
                )}
                <label className="flex min-h-11 shrink-0 items-center gap-1.5 text-xs text-slate-500">
                  {t('categoryLabel')}
                  <input
                    type="text"
                    value={p.category ?? ''}
                    placeholder={t('categoryPlaceholder')}
                    maxLength={24}
                    onChange={(e) => updatePreset(p.id, { category: e.target.value || undefined })}
                    className="h-11 w-28 rounded-md border border-slate-200 px-2 text-base text-slate-700 placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm"
                  />
                </label>
              </div>
              {/* オプション (サイズ/トッピング)・flag 裏。空でも折りたたみで提示。 */}
              {env.enableMenuOptions && (
                <details className="w-full rounded-lg border border-slate-100 bg-white px-2">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center text-xs font-medium text-slate-500">
                    {t('optionsTitle')}
                    {p.options && p.options.length > 0 ? ` (${p.options.length})` : ''}
                  </summary>
                  <div className="pb-2">
                    <ProductOptionEditor
                      options={p.options}
                      onChange={(opts) => updatePreset(p.id, { options: opts })}
                    />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 追加フォーム */}
      <div className="rounded-lg border border-dashed border-slate-300 p-3">
        <p className="mb-2 text-xs font-semibold text-slate-600">{t('addTitle')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('nameLabel')} htmlFor={`${formId}-name`}>
            <input
              id={`${formId}-name`}
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder={t('namePlaceholder')}
              className="h-11 w-36 rounded-md border border-slate-300 px-2 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm"
              maxLength={80}
            />
          </Field>
          <Field label={t('priceLabel')} htmlFor={`${formId}-price`}>
            <input
              id={`${formId}-price`}
              type="text"
              inputMode="decimal"
              value={draft.unitPrice}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  unitPrice: e.target.value.replace(/[^\d.]/g, ''),
                }))
              }
              placeholder={t('pricePlaceholder')}
              className="h-11 w-24 rounded-md border border-slate-300 px-2 text-right font-mono text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm"
            />
          </Field>
          <Field label={t('tokenLabel')} htmlFor={`${formId}-token`}>
            <select
              id={`${formId}-token`}
              value={draft.token}
              onChange={(e) =>
                setDraft((d) => ({ ...d, token: e.target.value as TokenSymbol }))
              }
              className="h-11 rounded-md border border-slate-300 px-2 text-base focus:border-brand focus:outline-none sm:text-sm"
            >
              {TOKEN_SYMBOLS.map((sym) => (
                <option key={sym} value={sym}>
                  {defaultDeploymentForSymbol(sym).displaySymbol}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('taxLabel')} htmlFor={`${formId}-tax`}>
            <select
              id={`${formId}-tax`}
              value={draft.taxCategory}
              onChange={(e) =>
                setDraft((d) => ({ ...d, taxCategory: e.target.value as TaxCategory }))
              }
              className="h-11 rounded-md border border-slate-300 px-2 text-base focus:border-brand focus:outline-none sm:text-sm"
            >
              {TAX_OPTIONS.map((o) => (
                <option key={o.category} value={o.category}>
                  {tTax(o.i18nKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('categoryLabel')} htmlFor={`${formId}-category`}>
            <input
              id={`${formId}-category`}
              type="text"
              value={draft.category}
              onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
              placeholder={t('categoryPlaceholder')}
              maxLength={24}
              className="h-11 w-28 rounded-md border border-slate-300 px-2 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm"
            />
          </Field>
          {imageFields ? (
            <div className="w-full">
              <ImageField
                key={`${imageScope.key}:${NEW_ROW}`}
                id={`${formId}-image`}
                label={t('imageUploadLabel')}
                urlLabel={t('imageLabel')}
                value={draft.image}
                onChange={(url) => setDraft((d) => ({ ...d, image: url }))}
                purpose="preset"
                onBusyChange={onNewRowBusyChange}
                operation={images.operation(NEW_ROW)}
                urlMaxLength={PRESET_IMAGE_MAX}
                hint={
                  <p className="text-xs leading-relaxed text-slate-500">
                    {tImage('hint', { max: IMAGE_MAX_EDGE.preset })}
                  </p>
                }
                urlHint={
                  <p className="mt-1 text-xs text-slate-500">
                    {t('imageHint')}{' '}
                    <Link
                      href={`/${locale}/guide/image-url`}
                      prefetch={false}
                      className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
                    >
                      {t('imageGuideLink')}
                    </Link>
                  </p>
                }
                previewClassName="h-16 w-16 rounded-lg"
              />
            </div>
          ) : (
          <Field label={t('imageLabel')} htmlFor={`${formId}-image`}>
            <input
              id={`${formId}-image`}
              type="url"
              value={draft.image}
              onChange={(e) => {
                images.advance(NEW_ROW);
                setDraft((d) => ({ ...d, image: e.target.value }));
              }}
              placeholder={t('imagePlaceholder')}
              className="h-11 w-40 rounded-md border border-slate-300 px-2 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm"
            />
          </Field>
          )}
          <button
            type="button"
            onClick={handleAdd}
            disabled={!canAdd || newRowBusy.busy}
            className="h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('addButton')}
          </button>
        </div>
        {/* 画像の欄のときは、この案内を追加のフォームの「URL で指定する ›」の中に出す。 */}
        {imageFields ? null : (
        <p className="mt-2 text-xs text-slate-500">
          {t('imageHint')}{' '}
          <Link
            href={`/${locale}/guide/image-url`}
            prefetch={false}
            className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
          >
            {t('imageGuideLink')}
          </Link>
        </p>
        )}
        {imageScope.access === 'signIn' ? (
          <p className="mt-1 text-xs text-slate-600">{tImage('signInToUpload')}</p>
        ) : null}
      </div>
    </div>
  );
}
