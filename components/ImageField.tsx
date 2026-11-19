'use client';

// 共通の画像の欄: 今の画像のプレビュー・[画像を選ぶ]・[外す]・小さな「URL で指定する ›」(押したときだけ URL の欄が開く)。
// 選んだ画像はブラウザで描き直して POST /api/images/upload に送り、返った公開の URL を onChange で親へ渡す。値の形は
// 今の URL の欄と同じ (https の URL の文字列・外したら空)。
// - アップロード中は「画像を選ぶ」を止め (二重送信の防ぎ)、busy を親へ知らせる (親はその間の保存を止める)。
// - やめる・外す・URL の書き換え・unmount の後に届いた古い応答は捨てる (hooks/useImageUpload)。
// - 同じ値をほかの部品も書き換えるとき (商品の表紙: AI の「この画像を表紙に使う」・元に戻す) は、操作の番号 (operation) を
//   共有して「最後の操作だけが反映される」ようにする。この欄の操作 (選ぶ・外す・URL の手入力) も同じ番号を進める。
// - 失敗しても元の画像は変えない (短い文を出すだけ)。
// この欄を出すかは親が決める (出品者の GET の imageUpload が true のときだけ・false なら親は今の URL の欄を出す)。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalImage } from '@/components/ExternalImage';
import { nextImageOperation, useImageUpload, type ImageOperationCounter } from '@/hooks/useImageUpload';
import { IMAGE_FIELD_ACCEPT, IMAGE_OWNER_MAX_IMAGES, type ImagePurpose } from '@/lib/images/purpose';
import type { ImageUploadFailure } from '@/lib/images/uploadClient';

/** 失敗の code ごとの文 (ImageField.errors の key)。code を足すと typecheck が落ちる (文のない code を出さない)。 */
const ERROR_KEYS: Record<ImageUploadFailure, string> = {
  not_found: 'notAvailable',
  forbidden: 'notAvailable',
  not_configured: 'notAvailable',
  cross_site_request: 'notAvailable',
  unauthenticated: 'unauthenticated',
  rate_limited: 'rateLimited',
  image_limit: 'imageLimit',
  payload_too_large: 'tooLarge',
  too_large: 'tooLarge',
  invalid_image: 'invalidImage',
  unsupported_media_type: 'invalidImage',
  decode_failed: 'invalidImage',
  unsupported: 'unsupported',
  session_storage_unavailable: 'unavailable',
  storage_unavailable: 'unavailable',
  upload_failed: 'unavailable',
  network: 'network',
  invalid_purpose: 'unknown',
  invalid_body: 'unknown',
  unknown: 'unknown',
};

export function imageUploadErrorKey(error: ImageUploadFailure): string {
  return `errors.${ERROR_KEYS[error]}`;
}

export const imageButtonClass =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400';

const urlToggleClass =
  'inline-flex min-h-11 items-center text-xs font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900';

const urlInputClass =
  'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 sm:text-sm';

/** アップロード中の表示 (やめる) と失敗の文。画像の欄と Store の「画像を追加」が使う。 */
export function ImageUploadStatus({
  busy,
  error,
  onCancel,
}: {
  busy: boolean;
  error: ImageUploadFailure | null;
  onCancel: () => void;
}) {
  const t = useTranslations('ImageField');
  return (
    <>
      {busy ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-xs text-slate-600">
            {t('uploading')}
          </p>
          <button type="button" onClick={onCancel} className={imageButtonClass}>
            {t('cancel')}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs leading-relaxed text-red-700">
          {t(imageUploadErrorKey(error), { max: IMAGE_OWNER_MAX_IMAGES })} {t('keepOriginal')}
        </p>
      ) : null}
    </>
  );
}

/** 画像の小さなプレビュー。読めない画像は同じ大きさの枠と短い文に置き換える (壊れ画像 icon を出さない)。 */
export function ImagePreview({ url, className }: { url: string; className: string }) {
  const t = useTranslations('ImageField');
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) {
    return (
      <span className={`flex items-center justify-center bg-slate-100 p-2 text-center text-xs text-slate-500 ${className}`}>
        {t('previewFailed')}
      </span>
    );
  }
  return (
    // 任意の第三者 https 画像 (URL で指定した画像) も描くので、Referer を渡さない。
    <ExternalImage
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      className={`object-cover ${className}`}
      onError={() => setFailedUrl(url)}
    />
  );
}

type Props = {
  /** 欄の要素の id の頭。 */
  id: string;
  /** 欄の見出し (見える文)。 */
  label: string;
  /** 開いたときの URL の欄の見出し。 */
  urlLabel: string;
  value: string;
  onChange: (url: string) => void;
  purpose: ImagePurpose;
  onBusyChange?: (busy: boolean) => void;
  /**
   * value をほかの部品も書き換えるときに共有する操作の番号 (hooks/useImageUpload)。渡さないと、この欄が送っている間の
   * ほかからの書き換えを、後から届いた画像が上書きする。
   */
  operation?: ImageOperationCounter;
  /** URL の欄の上限 (保存の上限と同じ値)。 */
  urlMaxLength: number;
  /** 欄の下の案内 (任意)。 */
  hint?: ReactNode;
  /** URL の欄を開いたときだけ出す案内 (任意)。 */
  urlHint?: ReactNode;
  /** プレビューの大きさ・形 (class)。 */
  previewClassName?: string;
};

export function ImageField({
  id,
  label,
  urlLabel,
  value,
  onChange,
  purpose,
  onBusyChange,
  operation,
  urlMaxLength,
  hint,
  urlHint,
  previewClassName = 'h-24 w-32 rounded-lg',
}: Props) {
  const t = useTranslations('ImageField');
  const fileInput = useRef<HTMLInputElement>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const { busy, error, cancel, clearError, onFileChange } = useImageUpload({
    purpose,
    onUploaded: onChange,
    onBusyChange,
    operation,
  });
  // 外す・URL の手入力: この欄の送信をやめ、番号を進めてから値を変える (ほかの部品が送っている画像も、届いても入らない)。
  const changeByHand = (next: string) => {
    cancel();
    if (operation) nextImageOperation(operation);
    onChange(next);
  };
  const current = value.trim();
  // 欄の値がほかから変わったら (AI の「この画像を表紙に使う」・元に戻す など)、前の失敗の文は今の画像の話でなくなるので消す。
  useEffect(() => {
    clearError();
  }, [value, clearError]);

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="space-y-2">
      <p id={`${id}-label`} className="text-sm font-medium text-slate-700">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {current ? (
          <ImagePreview url={current} className={`ring-1 ring-slate-200 ${previewClassName}`} />
        ) : (
          <span className={`flex items-center justify-center border border-dashed border-slate-300 p-2 text-center text-xs text-slate-500 ${previewClassName}`}>
            {t('empty')}
          </span>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={imageButtonClass}>
            {t('choose')}
          </button>
          {current && !busy ? (
            <button type="button" onClick={() => changeByHand('')} className={imageButtonClass}>
              {t('remove')}
            </button>
          ) : null}
        </div>
      </div>
      {/* 見えない file の欄 (上の「画像を選ぶ」が開く)。読み上げの対象にもしない (操作は上のボタン)。 */}
      <input
        ref={fileInput}
        type="file"
        accept={IMAGE_FIELD_ACCEPT}
        hidden
        onChange={onFileChange}
      />
      <ImageUploadStatus busy={busy} error={error} onCancel={cancel} />
      {hint}
      <div>
        <button
          type="button"
          aria-expanded={urlOpen}
          aria-controls={urlOpen ? `${id}-url-panel` : undefined}
          onClick={() => setUrlOpen((open) => !open)}
          className={urlToggleClass}
        >
          {t('useUrl')}
        </button>
        {urlOpen ? (
          <div id={`${id}-url-panel`}>
            <label htmlFor={`${id}-url`} className="block text-sm font-medium text-slate-700">
              {urlLabel}
              <input
                id={`${id}-url`}
                type="url"
                maxLength={urlMaxLength}
                placeholder="https://"
                value={value}
                // 手で書いた URL が最後の意思: 送っている途中の画像はやめる (届いても上書きしない)。
                onChange={(event) => changeByHand(event.target.value)}
                className={urlInputClass}
              />
            </label>
            {urlHint}
          </div>
        ) : null}
      </div>
    </div>
  );
}
