'use client';

// AI 出品アシスタントの本体 (Google Gemini で出品文の案を作る・運営者だけの試し・server のフラグは既定 OFF)。
// ProductEditorSection の入口を押したときだけ next/dynamic (ssr: false) で読み込む (押す前は chunk を読まない)。
// 画像・メモ・案はこの部品の state だけに持ち、保存しない。親 (SignedInSellerPanel) の sessionAddress の key の内側に
// あるので、アカウントを切り替えると一緒に消える。フォームは「〜に入れる」を押した欄だけ updateProduct で変え、
// 生成・再生成・失敗ではフォームを変えない。Google に送る欄は lib/store/listingAssistant の許可リスト
// (listingAssistantFactsOf) が決める — この部品はフォームから欄を選ばない。
// 画像のアップロード (出品者の GET の imageUpload) が使えるときだけ「この画像を表紙に使う」を出す。押したときだけ元の file を
// 商品の大きさに描き直して POST /api/images/upload に送り、表紙 (imageUrl) に入れる (元に戻せる)。解析・案の採用だけでは
// 画像を公開しない。

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Undo2 } from 'lucide-react';
import { MAX_HOSTED_TAGS, MAX_HOSTED_TAG_LEN, parseHostedTags } from '@/lib/x402/storeMeta';
import {
  LISTING_ASSISTANT_CHECKS_MAX,
  LISTING_ASSISTANT_CHECK_MAX,
  LISTING_ASSISTANT_EN_MAX,
  LISTING_ASSISTANT_FACT_KEYS,
  LISTING_ASSISTANT_IMAGE_MIME_TYPE,
  LISTING_ASSISTANT_MEMO_MAX,
  LISTING_ASSISTANT_X_MAX,
  listingAssistantFactsOf,
  type ListingAssistantDraft,
  type ListingAssistantErrorCode,
  type ListingAssistantFactKey,
  type ListingAssistantRequest,
} from '@/lib/store/listingAssistant';
import { ImageUploadStatus } from '@/components/ImageField';
import { useImageUpload } from '@/hooks/useImageUpload';
import { LISTING_IMAGE_MAX_EDGE, prepareListingImage, type ListingImageError, type PreparedListingImage } from './listingAssistantImage';
import { copyText } from './ProductShareButton';
import { inputClass, type ProductForm } from './shared';

export const LISTING_ASSISTANT_ENDPOINT = '/api/store/seller/listing-assistant';
/** フォームの maxLength と保存の上限 (lib/x402/hostedStore の MAX_HOSTED_TITLE_LEN・MAX_HOSTED_DESC_LEN は server-only) と同じ。 */
export const ASSISTANT_TITLE_MAX = 60;
export const ASSISTANT_DESC_MAX = 200;
export const GEMINI_TERMS_URL = 'https://ai.google.dev/gemini-api/terms';

type ApplyField = 'title' | 'desc' | 'tags';
type TextField = ApplyField | 'en' | 'x';
type AssistantErrorCode = ListingAssistantErrorCode | 'network';
export type AssistantError =
  | { code: AssistantErrorCode; retryAfterSec?: number }
  | { code: 'unknown'; raw: string };

// 失敗の code ごとの文 (どれも errorKeep を添える)。code を足すと typecheck が落ちる (文のない code を出さない)。
const ERROR_MESSAGE_KEYS: Record<AssistantErrorCode, string> = {
  not_found: 'errors.notFound',
  cross_site_request: 'errors.forbidden',
  forbidden: 'errors.forbidden',
  unauthenticated: 'errors.unauthenticated',
  session_storage_unavailable: 'errors.unavailable',
  unsupported_media_type: 'errors.invalidRequest',
  invalid_json: 'errors.invalidRequest',
  invalid_body: 'errors.invalidRequest',
  payload_too_large: 'errors.tooLarge',
  image_too_large: 'errors.tooLarge',
  invalid_memo: 'errors.invalidMemo',
  invalid_image: 'errors.invalidImage',
  invalid_facts: 'errors.invalidFacts',
  memo_or_image_required: 'errors.memoOrImageRequired',
  rate_limited: 'errors.rateLimited',
  quota_exceeded: 'errors.quotaExceeded',
  blocked: 'errors.blocked',
  bad_response: 'errors.badResponse',
  truncated: 'errors.truncated',
  not_configured: 'errors.notConfigured',
  unavailable: 'errors.unavailable',
  timeout: 'errors.timeout',
  network: 'errors.network',
};

// 本文が JSON でない応答 (Vercel の 413・504 など) は HTTP status から code を決める。
const STATUS_ERROR_CODES: Partial<Record<number, ListingAssistantErrorCode>> = {
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  502: 'bad_response',
  503: 'unavailable',
  504: 'timeout',
};

const FACT_NAME_KEYS: Record<ListingAssistantFactKey, string> = {
  title: 'factNames.title',
  desc: 'factNames.desc',
  details: 'factNames.details',
  specs: 'factNames.specs',
  category: 'factNames.category',
  tags: 'factNames.tags',
  usageCommercial: 'factNames.usageCommercial',
  usageModify: 'factNames.usageModify',
  usageRedistribute: 'factNames.usageRedistribute',
  usageNote: 'factNames.usageNote',
};

const isErrorCode = (value: unknown): value is ListingAssistantErrorCode =>
  typeof value === 'string' && Object.hasOwn(ERROR_MESSAGE_KEYS, value) && value !== 'network';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(value: unknown): value is { value: string; fits: boolean } {
  const field = record(value);
  return !!field && typeof field.value === 'string' && typeof field.fits === 'boolean';
}

function listField(value: unknown): value is { value: string[]; fits: boolean } {
  const field = record(value);
  return !!field && Array.isArray(field.value) && field.value.every((item) => typeof item === 'string') && typeof field.fits === 'boolean';
}

/** 応答の案の形を確かめる (崩れた応答で画面を落とさない・bad_response として案内する)。 */
export function draftOf(body: unknown): ListingAssistantDraft | null {
  const draft = record(record(body)?.draft);
  if (!draft) return null;
  const { title, desc, tags, en, x, checks } = draft;
  return textField(title) && textField(desc) && listField(tags) && textField(en) && textField(x) && listField(checks)
    ? { title, desc, tags, en, x, checks }
    : null;
}

type DraftResult = { ok: true; draft: ListingAssistantDraft } | { ok: false; error: AssistantError };

/** 案を頼む。例外を投げない (通信の失敗も code にして、画面の入力と直前の案を保つ)。 */
export async function requestListingDraft(body: ListingAssistantRequest): Promise<DraftResult> {
  let response: Response;
  try {
    response = await fetch(LISTING_ASSISTANT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: { code: 'network' } };
  }
  // 本文が JSON でない障害の応答でも HTTP status から案内できるよう、読み取りの失敗は null にする。
  const json = record(await response.json().catch(() => null));
  if (response.ok && json?.ok === true) {
    const draft = draftOf(json);
    return draft ? { ok: true, draft } : { ok: false, error: { code: 'bad_response' } };
  }
  const retryAfterSec =
    typeof json?.retryAfterSec === 'number' && Number.isFinite(json.retryAfterSec) && json.retryAfterSec > 0
      ? Math.ceil(json.retryAfterSec)
      : undefined;
  const code = isErrorCode(json?.error) ? json.error : STATUS_ERROR_CODES[response.status];
  if (!code) {
    return { ok: false, error: { code: 'unknown', raw: typeof json?.error === 'string' ? json.error : `http_${response.status}` } };
  }
  return { ok: false, error: { code, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) } };
}

type Translate = ReturnType<typeof useTranslations>;

function waitText(t: Translate, sec: number): string {
  if (sec < 60) return t('wait.seconds', { count: sec });
  if (sec < 3600) return t('wait.minutes', { count: Math.ceil(sec / 60) });
  return t('wait.hours', { count: Math.max(1, Math.round(sec / 3600)) });
}

function errorMessage(t: Translate, error: AssistantError): string {
  if (error.code === 'unknown') return t('errors.unknown', { code: error.raw });
  if (error.retryAfterSec !== undefined && (error.code === 'rate_limited' || error.code === 'quota_exceeded')) {
    const key = error.code === 'rate_limited' ? 'errors.rateLimitedWait' : 'errors.quotaExceededWait';
    return t(key, { wait: waitText(t, error.retryAfterSec) });
  }
  if (error.code === 'invalid_memo') return t('errors.invalidMemo', { max: LISTING_ASSISTANT_MEMO_MAX });
  return t(ERROR_MESSAGE_KEYS[error.code]);
}

// clipped = server が fits:false とした欄 (長すぎた案を上限の中に切った見本・lib/store/listingAssistantServer の lineField・
// tagsField)。見本はそのままでは入れない — 欄で直した文 (見本と違う文) だけを画面の数え方で判定する。
type FitIssue =
  | { kind: 'empty' }
  | { kind: 'tooLong'; max: number; count: number }
  | { kind: 'tags' }
  | { kind: 'clipped'; max: number }
  | { kind: 'tagsClipped' };

/** 1 行の欄: 保存の sanitizeLine と同じく改行を空白にして前後を除き、UTF-16 の長さで数える。 */
const lineOf = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
// タグはフォームと同じく 、と , で区切る (案の欄は textarea なので改行も区切りにする)。
const splitTags = (value: string) => value.split(/[,、\r\n]/).map((tag) => tag.trim()).filter(Boolean);

/**
 * 欄の値を、実際に使う形にする (フォームに入れる値・X の本文)。1 行の欄は lineOf、タグは保存と同じ parseHostedTags で
 * 重なりを除いた並び (検証を通らなければ null = 使えない)。入れる値と「直したか」の比べの両方がこの 1 つの関数を通る。
 */
function usableOf(field: TextField, value: string): string | null {
  if (field !== 'tags') return lineOf(value);
  const parsed = parseHostedTags(splitTags(value));
  return parsed.ok ? (parsed.tags ?? []).join(', ') : null;
}

// 「案を直したか」の比べ: 使う形 (usableOf) にしてから、さらに寄せる: NFKC・見えない文字 (保存の sanitizeLine が落とす制御・
// 書式に加え Default_Ignorable) を除く・空白の並びを 1 つに。見本に空白・改行・見えない文字を足しただけ・タグの区切りや重なりを
// 変えただけでは、保存される値は見本と変わらないので「直した」にしない (見本のまま入れない)。
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
const comparableLine = (value: string) =>
  value.normalize('NFKC').replace(INVISIBLE_RE, '').replace(/\s+/gu, ' ').trim();
const comparableOf = (field: TextField, usable: string) =>
  field === 'tags' ? [...new Set(splitTags(usable).map(comparableLine).filter(Boolean))].join(',') : comparableLine(usable);

function lineIssue(value: string, max: number): FitIssue | null {
  const line = lineOf(value);
  if (!line) return { kind: 'empty' };
  return line.length > max ? { kind: 'tooLong', max, count: line.length } : null;
}

function tagsIssue(value: string): FitIssue | null {
  const items = splitTags(value);
  if (items.length === 0) return { kind: 'empty' };
  const parsed = parseHostedTags(items);
  if (!parsed.ok) return { kind: 'tags' };
  // 制御文字だけのタグは parseHostedTags が黙って落とすので、解析の後に 0 件なら空欄と同じに止める
  // (「タグに入れる」で既存のタグを空で上書きするのを断つ・Codex のレビュー)。
  return parsed.tags && parsed.tags.length > 0 ? null : { kind: 'empty' };
}

const FIELD_MAX: Record<Exclude<TextField, 'tags'>, number> = {
  title: ASSISTANT_TITLE_MAX,
  desc: ASSISTANT_DESC_MAX,
  en: LISTING_ASSISTANT_EN_MAX,
  x: LISTING_ASSISTANT_X_MAX,
};

const FIELD_ROWS: Record<TextField, number> = { title: 2, desc: 4, tags: 2, en: 4, x: 3 };

const patchOf = (field: ApplyField, value: string): Partial<ProductForm> =>
  field === 'title' ? { title: value } : field === 'desc' ? { desc: value } : { tags: value };

const APPLY_LABEL_KEYS: Record<ApplyField, string> = { title: 'applyTitle', desc: 'applyDesc', tags: 'applyTags' };
const UNDO_LABEL_KEYS: Record<ApplyField, string> = { title: 'undoTitle', desc: 'undoDesc', tags: 'undoTags' };
const FIELD_LABEL_KEYS: Record<TextField, string> = {
  title: 'fieldTitle',
  desc: 'fieldDesc',
  tags: 'fieldTags',
  en: 'fieldEn',
  x: 'fieldX',
};

const buttonClass =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400';

type Props = {
  productForm: ProductForm;
  updateProduct: (patch: Partial<ProductForm>) => void;
  /** 出品者の GET の imageUpload。true のときだけ「この画像を表紙に使う」を出す。 */
  imageUpload?: boolean;
  /** 表紙のアップロード中か (親はその間の保存を止める)。 */
  onImageBusyChange?: (busy: boolean) => void;
};

export function ListingAssistant({ productForm, updateProduct, imageUpload = false, onImageBusyChange }: Props) {
  const t = useTranslations('CreatorStoreSeller.assistant');
  const [memo, setMemo] = useState('');
  const [image, setImage] = useState<PreparedListingImage | null>(null);
  // 表紙に使うときは、AI に送る JPEG (白を敷いた・base64) ではなく、選んだ元の file から商品の大きさに描き直す (透過を保つ)。
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [coverApplied, setCoverApplied] = useState<{ before: string; after: string } | null>(null);
  const cover = useImageUpload({
    purpose: 'product',
    onUploaded: (url) => {
      // 届いたときの表紙を「元に戻す」の先にする。
      setCoverApplied({ before: productForm.imageUrl, after: url });
      updateProduct({ imageUrl: url });
    },
    onBusyChange: onImageBusyChange,
  });
  const [imageError, setImageError] = useState<ListingImageError | null>(null);
  const [imagePreparing, setImagePreparing] = useState(false);
  const imageRequest = useRef(0);
  // 二重送信の防止: state の反映 (ボタンの無効化) より先に、同じ tick の 2 回目の押下を止める。
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AssistantError | null>(null);
  const [draft, setDraft] = useState<ListingAssistantDraft | null>(null);
  const [edited, setEdited] = useState<Partial<Record<TextField, string>>>({});
  const [applied, setApplied] = useState<Partial<Record<ApplyField, { before: string; after: string }>>>({});
  const [copied, setCopied] = useState<TextField | null>(null);
  const [copyFailed, setCopyFailed] = useState<TextField | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const facts = listingAssistantFactsOf(productForm);
  const sentKeys = LISTING_ASSISTANT_FACT_KEYS.filter((key) => facts[key].trim() !== '');
  // メモは server と同じく code point で数える (UTF-16 の maxLength だと絵文字は 250 字で止まる)。
  const memoLength = [...memo].length;
  const memoOver = memoLength > LISTING_ASSISTANT_MEMO_MAX;
  const canSend = (memo.trim() !== '' || image !== null) && !imagePreparing && !memoOver;

  const onImageChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 同じ file を選び直しても change が来るように空にする (file は上で取り出し済み)。
    event.target.value = '';
    if (!file) return;
    const requestId = ++imageRequest.current;
    // 前の画像の表紙のアップロードはやめる (届いても表紙に入れない)。
    cover.cancel();
    setImagePreparing(true);
    setImageError(null);
    const result = await prepareListingImage(file);
    // 準備中に別の画像を選んだ・外したときは、古い結果で上書きしない。
    if (requestId !== imageRequest.current) return;
    setImagePreparing(false);
    if (result.ok) {
      setImage(result.image);
      setImageFile(file);
    } else {
      setImage(null);
      setImageFile(null);
      setImageError(result.error);
    }
  };

  const removeImage = () => {
    imageRequest.current += 1;
    cover.cancel();
    setImagePreparing(false);
    setImage(null);
    setImageFile(null);
    setImageError(null);
  };

  const undoCover = () => {
    if (!coverApplied) return;
    updateProduct({ imageUrl: coverApplied.before });
    setCoverApplied(null);
  };
  const showCoverApplied = coverApplied !== null && productForm.imageUrl === coverApplied.after;

  const generate = async () => {
    if (inFlight.current || !canSend) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const trimmedMemo = memo.trim();
    const body: ListingAssistantRequest = {
      ...(trimmedMemo ? { memo: trimmedMemo } : {}),
      ...(image ? { image: { mimeType: LISTING_ASSISTANT_IMAGE_MIME_TYPE, data: image.data } } : {}),
      // 押した時点のフォームから、許可リストの欄だけ。
      facts: listingAssistantFactsOf(productForm),
    };
    try {
      const result = await requestListingDraft(body);
      if (result.ok) {
        setDraft(result.draft);
        setEdited({});
      } else {
        // 直前の案は残す (失敗で消さない)。
        setError(result.error);
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const draftValueOf = (current: ListingAssistantDraft, field: TextField): string =>
    field === 'tags' ? current.tags.value.join(', ') : current[field].value;
  const valueOf = (current: ListingAssistantDraft, field: TextField): string => edited[field] ?? draftValueOf(current, field);

  const issueOf = (current: ListingAssistantDraft, field: TextField): FitIssue | null => {
    const value = valueOf(current, field);
    // いまの欄の値の検証 (空・長すぎ・タグの数と長さ) を先に見る。直した値の誤りは、案との比べより優先する。
    const issue = field === 'tags' ? tagsIssue(value) : lineIssue(value, FIELD_MAX[field]);
    if (issue) return issue;
    // 検証を通った値を使う形にして案と比べる。違えば欄で直した文なので使える。
    const usable = usableOf(field, value);
    const draftValue = draftValueOf(current, field);
    if (usable !== null && comparableOf(field, usable) !== comparableOf(field, usableOf(field, draftValue) ?? draftValue)) return null;
    // 案のままの欄 (直して元に戻した欄も) は server の判定 (保存と同じ sanitizeLine・parseHostedTags) に従う。
    if (current[field].fits) return null;
    return field === 'tags' ? { kind: 'tagsClipped' } : { kind: 'clipped', max: FIELD_MAX[field] };
  };

  const issueText = (issue: FitIssue, copyOnly: boolean): string => {
    switch (issue.kind) {
      case 'empty':
        return t('empty');
      case 'tooLong':
        return t(copyOnly ? 'tooLongCopy' : 'tooLong', { max: issue.max, count: issue.count });
      case 'tags':
        return t('tagsInvalid', { max: MAX_HOSTED_TAGS, len: MAX_HOSTED_TAG_LEN });
      case 'clipped':
        return t(copyOnly ? 'clippedCopy' : 'clipped', { max: issue.max });
      case 'tagsClipped':
        return t('tagsClipped', { max: MAX_HOSTED_TAGS, len: MAX_HOSTED_TAG_LEN });
    }
  };

  const apply = (current: ListingAssistantDraft, field: ApplyField) => {
    if (issueOf(current, field)) return;
    // 比べに使ったのと同じ usableOf で入れる値を作る。使えない値 (検証を通らないタグ) なら何もしない (既存の欄を空にしない)。
    const after = usableOf(field, valueOf(current, field));
    if (after === null) return;
    const before = productForm[field];
    // もう入っている値を入れ直すだけなら何もしない (「元に戻す」の前の値を案そのもので上書きしない)。
    if (before === after) return;
    updateProduct(patchOf(field, after));
    setApplied((entries) => ({ ...entries, [field]: { before, after } }));
  };

  const undo = (field: ApplyField) => {
    const entry = applied[field];
    if (!entry) return;
    updateProduct(patchOf(field, entry.before));
    setApplied((entries) => {
      const next = { ...entries };
      delete next[field];
      return next;
    });
  };

  const copy = async (field: 'en' | 'x', value: string) => {
    setCopyFailed(null);
    if (await copyText(value)) setCopied(field);
    else setCopyFailed(field);
  };

  const renderField = (current: ListingAssistantDraft, field: TextField) => {
    const id = `creator-store-listing-assistant-${field}`;
    const value = valueOf(current, field);
    const issue = issueOf(current, field);
    const copyOnly = field === 'en' || field === 'x';
    const onChange = (next: string) => setEdited((entries) => ({ ...entries, [field]: next }));
    const appliedEntry = copyOnly ? undefined : applied[field as ApplyField];
    const showApplied = appliedEntry !== undefined && productForm[field as ApplyField] === appliedEntry.after;
    return (
      <div key={field}>
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">
          {t(FIELD_LABEL_KEYS[field])}
        </label>
        {/* 商品名とタグも 1 行の input にしない (390px で 60 字の案が切れて読めないため)。改行は入れるときに空白へ寄せる。 */}
        <textarea
          id={id}
          rows={FIELD_ROWS[field]}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={issue ? `${id}-issue` : undefined}
          className={inputClass}
        />
        {issue ? (
          <p id={`${id}-issue`} className="mt-1 text-xs leading-relaxed text-amber-800">
            {issueText(issue, copyOnly)}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {copyOnly ? (
            <>
              <button type="button" onClick={() => void copy(field, value)} className={buttonClass}>
                {copied === field ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                {copied === field ? t('copied') : t(field === 'en' ? 'copyEn' : 'copyX')}
              </button>
              {field === 'x' ? (
                issue ? (
                  <button type="button" disabled className={buttonClass}>
                    {t('openX')}
                  </button>
                ) : (
                  <a
                    href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(usableOf('x', value) ?? '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass}
                  >
                    {t('openX')}
                  </a>
                )
              ) : null}
            </>
          ) : (
            <button
              type="button"
              disabled={issue !== null}
              onClick={() => apply(current, field as ApplyField)}
              className={buttonClass}
            >
              {t(APPLY_LABEL_KEYS[field as ApplyField])}
            </button>
          )}
          {showApplied ? (
            <>
              <span role="status" className="text-xs font-medium text-emerald-700">
                {t('applied')}
              </span>
              <button type="button" onClick={() => undo(field as ApplyField)} className={buttonClass}>
                <Undo2 className="h-4 w-4" aria-hidden />
                {t(UNDO_LABEL_KEYS[field as ApplyField])}
              </button>
            </>
          ) : null}
        </div>
        {copyFailed === field ? (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {t('copyFailed')}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
        <p>{t('notice')}</p>
        <p className="mt-1">
          <a
            href={GEMINI_TERMS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2 hover:text-amber-950"
          >
            {t('termsLink')}
          </a>
        </p>
      </div>

      <div>
        <label htmlFor="creator-store-listing-assistant-image" className="block text-sm font-medium text-slate-700">
          {t('imageLabel')}
        </label>
        <input
          id="creator-store-listing-assistant-image"
          type="file"
          accept="image/*"
          onChange={(event) => void onImageChange(event)}
          aria-describedby="creator-store-listing-assistant-image-hint"
          className="mt-1 block w-full min-h-11 text-sm text-slate-700 file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-700"
        />
        <p id="creator-store-listing-assistant-image-hint" className="mt-1 text-xs leading-relaxed text-slate-500">
          {t('imageHint', { max: LISTING_IMAGE_MAX_EDGE })}
        </p>
        {imagePreparing ? (
          <p role="status" className="mt-2 text-xs text-slate-500">
            {t('imagePreparing')}
          </p>
        ) : null}
        {imageError ? (
          <p role="alert" className="mt-2 text-xs text-red-700">
            {t(imageError === 'too_large' ? 'imageTooLarge' : imageError === 'unsupported' ? 'imageUnsupported' : 'imageDecodeFailed')}
          </p>
        ) : null}
        {image ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {/* 送る JPEG そのもの (描き直した後) を見せる。data: は CSP の img-src で許可済み。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:${LISTING_ASSISTANT_IMAGE_MIME_TYPE};base64,${image.data}`}
              alt={t('imagePreviewAlt')}
              className="h-20 w-20 rounded-lg object-cover ring-1 ring-slate-200"
            />
            <div className="text-xs text-slate-600">
              <p>{t('imageSelected', { width: image.width, height: image.height, kb: Math.ceil(image.bytes / 1024) })}</p>
              <button type="button" onClick={removeImage} className={`${buttonClass} mt-1`}>
                {t('imageRemove')}
              </button>
            </div>
          </div>
        ) : null}
        {imageUpload && image && imageFile ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void cover.upload(imageFile)}
                disabled={cover.busy}
                aria-describedby="creator-store-listing-assistant-cover-hint"
                className={buttonClass}
              >
                {t('useAsCover')}
              </button>
              {showCoverApplied ? (
                <>
                  <span role="status" className="text-xs font-medium text-emerald-700">
                    {t('coverApplied')}
                  </span>
                  <button type="button" onClick={undoCover} className={buttonClass}>
                    <Undo2 className="h-4 w-4" aria-hidden />
                    {t('undoCover')}
                  </button>
                </>
              ) : null}
            </div>
            <p id="creator-store-listing-assistant-cover-hint" className="text-xs leading-relaxed text-slate-500">
              {t('useAsCoverHint')}
            </p>
            <ImageUploadStatus busy={cover.busy} error={cover.error} onCancel={cover.cancel} />
          </div>
        ) : null}
      </div>

      <div>
        <label htmlFor="creator-store-listing-assistant-memo" className="block text-sm font-medium text-slate-700">
          {t('memoLabel', { max: LISTING_ASSISTANT_MEMO_MAX })}
        </label>
        <textarea
          id="creator-store-listing-assistant-memo"
          rows={3}
          // 入力の上限は UTF-16 で数えるので、500 code point が必ず入る 2 倍にする (超えた分は下の文で止める)。
          maxLength={LISTING_ASSISTANT_MEMO_MAX * 2}
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          aria-describedby="creator-store-listing-assistant-memo-hint creator-store-listing-assistant-memo-remaining"
          className={inputClass}
        />
        <p id="creator-store-listing-assistant-memo-hint" className="mt-1 text-xs text-slate-500">
          {t('memoHint')}
        </p>
        {memoOver ? (
          <p id="creator-store-listing-assistant-memo-remaining" className="mt-1 text-xs text-red-700">
            {t('memoOver', { max: LISTING_ASSISTANT_MEMO_MAX, count: memoLength })}
          </p>
        ) : (
          <p id="creator-store-listing-assistant-memo-remaining" className="mt-1 text-xs text-slate-500">
            {t('memoRemaining', { count: LISTING_ASSISTANT_MEMO_MAX - memoLength })}
          </p>
        )}
      </div>

      <div className="rounded-lg bg-white p-3 text-xs leading-relaxed text-slate-600 ring-1 ring-slate-200">
        <p className="font-semibold text-slate-700">{t('sendHeading')}</p>
        <p className="mt-1">
          {sentKeys.length > 0
            ? t('sendFields', { fields: sentKeys.map((key) => t(FACT_NAME_KEYS[key])).join(t('listSeparator')) })
            : t('sendNone')}
        </p>
        <p className="mt-1">{t('notSent')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void generate()}
          disabled={pending || !canSend}
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {draft ? t('regenerate') : t('generate')}
        </button>
        {pending ? (
          <p role="status" className="text-sm text-slate-600">
            {t('generating')}
          </p>
        ) : !canSend && !imagePreparing && !memoOver ? (
          <p className="text-xs text-slate-500">{t('needInput')}</p>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p>{errorMessage(t, error)}</p>
          <p className="mt-1 text-xs">{t('errorKeep')}</p>
        </div>
      ) : null}

      {draft ? (
        <section aria-labelledby="creator-store-listing-assistant-result-heading" className="space-y-4 border-t border-slate-200 pt-4">
          <div>
            <h4 id="creator-store-listing-assistant-result-heading" className="text-sm font-semibold text-slate-800">
              {t('resultHeading')}
            </h4>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('resultHint')}</p>
          </div>
          {(['title', 'desc', 'tags', 'en', 'x'] as const).map((field) => renderField(draft, field))}
          {draft.checks.value.length > 0 ? (
            <section
              aria-labelledby="creator-store-listing-assistant-checks-heading"
              className="rounded-lg border border-slate-200 bg-white p-3"
            >
              <h5 id="creator-store-listing-assistant-checks-heading" className="text-sm font-semibold text-slate-800">
                {t('checksHeading')}
              </h5>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('checksHint')}</p>
              {draft.checks.fits ? null : (
                <p className="mt-1 text-xs leading-relaxed text-amber-800">
                  {t('checksClipped', { max: LISTING_ASSISTANT_CHECKS_MAX, len: LISTING_ASSISTANT_CHECK_MAX })}
                </p>
              )}
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                {draft.checks.value.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
