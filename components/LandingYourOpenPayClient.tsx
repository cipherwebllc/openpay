'use client';

// トップの「あなたの OpenPay」帯の client 部分 (plans/lp-polish-2026-09.md P4a)。
//   - YourOpenPayFrame: 帯を出すかの切り替えだけ (中身は server が描く)。
//   - YourOpenPayToday: 今日の売上 (TodayCard と同じ端末内の集計・ネットワークなし)。
//   - YourOpenPayPage: サインイン済みなら自分の @handle をそのテーマと色で (P4b・GET /api/handle)。URL のコピーと編集のボタンつき。
// 未接続の訪問者には帯を描かず (display:none)、リクエストも増やさない。

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { useMutationState, useQuery } from '@tanstack/react-query';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { ExternalImage } from '@/components/ExternalImage';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useOrigin } from '@/hooks/useOrigin';
import { useSiweSession } from '@/hooks/useSiweSession';
import { fetchMyHandles, myHandlesQueryKey, type OwnedHandle } from '@/lib/handleMine';
import { handlePageTheme, handleViewTheme, resolveHandleTheme } from '@/lib/handleTheme';
import { HISTORY_ASSET_DECIMALS, localDateKey, readTodaySummary, todayAtomicToNumber, type TodayMerchantSummary } from '@/lib/history';
import { RETURNING_WALLET_PREPAINT, useReturningWallet } from '@/hooks/useReturningWallet';

export function YourOpenPayFrame({ children }: { children: ReactNode }) {
  const { status } = useAccount();
  const { hydrating, returning } = useReturningWallet(status === 'connected');
  const connectedHere = useConnectedOnThisPage(status === 'connected');
  // 枠を出すのは、開いたときに決まった分 (再訪の目印・client の遷移で来たときの接続) と、このページで user がつないだときだけ。
  // 自動の再接続では後から出さない (ヒーローより前に差し込むと、操作なしで下の節を押し下げる)。
  // 開いたときに出した枠は、再接続の失敗・切断でも消さない (同じく押し上げない)。
  const visible = returning === null ? null : returning || connectedHere;
  return (
    // null は server と hydration のときだけ。属性を描かず、script が付けた値を hydration で消さない。
    // 判定後は yes / no を明示して上書きする (script の値が残らないように)。
    // data-returning-open は開いたときの判定 (returning) だけで決める (このページでつないだ分 = connectedHere は含めない)。
    // ヒーローはこちらを見て小さくなる (components/LandingHero.tsx)。script が付けた値と同じ値を React でも付けるのは、
    // script が走らない描画 (別のページから client の遷移で来た・hydration の失敗で帯を作り直した) でも付けるため。
    // 印刷では出さない: data 属性の block は print:hidden より詳細度が高いので ! で上書きする。
    <div
      data-returning={yesNo(visible)}
      data-returning-open={yesNo(returning)}
      suppressHydrationWarning
      className="hidden data-[returning=yes]:block print:!hidden"
    >
      {/* script は server の HTML と hydration のときだけ描く (client だけの描画では React が script を実行しない)。 */}
      {hydrating ? <script dangerouslySetInnerHTML={{ __html: RETURNING_WALLET_PREPAINT }} /> : null}
      {children}
    </div>
  );
}

function yesNo(value: boolean | null): 'yes' | 'no' | undefined {
  return value === null ? undefined : value ? 'yes' : 'no';
}

// このページで user がつないだか = ヘッダの接続 (wagmi の connect 操作・mutationKey ['connect']) が、この帯を出したあとに成功した。
// 自動の再接続は connect 操作を通らないので数えない。status や useAccountEffect の isReconnected では見分けられない
// (wagmi は起動時に保存の current を null へ書き戻すので、再接続も 'connecting' から始まり isReconnected=false になる・2026-09-28 確認)。
function useConnectedOnThisPage(connectedNow: boolean): boolean {
  const [mountedAt] = useState(() => Date.now());
  const submittedAt = useMutationState({
    filters: { mutationKey: ['connect'], status: 'success' },
    select: (mutation) => mutation.state.submittedAt,
  });
  return connectedNow && submittedAt.some((at) => at >= mountedAt);
}

export function YourOpenPayToday({ label }: { label: string }) {
  const t = useTranslations('Today');
  const locale = useLocale();
  const { address, status } = useAccount();
  const [today, setToday] = useState<TodayMerchantSummary | null>(null);

  useEffect(() => {
    // 個人の中身は今つながっているときだけ (再訪の目印だけでは出さない)。切断・アドレス変更で消す。
    if (status !== 'connected' || !address) {
      setToday(null);
      return;
    }
    const summary = readTodaySummary();
    const mine = summary && summary.date === localDateKey(Date.now()) ? summary.byMerchant[address.toLowerCase()] ?? null : null;
    setToday(mine && mine.count > 0 ? mine : null);
  }, [status, address]);

  if (!today) return null;
  const yen = Math.round(todayAtomicToNumber(today.jpycAtomic, HISTORY_ASSET_DECIMALS.jpyc));
  const usdc = todayAtomicToNumber(today.usdcAtomic, HISTORY_ASSET_DECIMALS.usdc);

  // 見出しの行 (高さ固定) の右に 1 行で収める。出ても消えても、行の高さと下の段は動かない。
  return (
    <Link
      href={`/${locale}/history`}
      prefetch={false}
      className="inline-flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-brand/5 pl-3 pr-1.5 text-slate-900 ring-1 ring-brand/15 transition hover:ring-brand/40"
    >
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      <span className="text-sm font-bold tabular-nums">¥{yen.toLocaleString('en-US')}</span>
      {usdc > 0 ? <span className="hidden text-xs font-semibold text-slate-600 sm:inline">{t('usdc', { amount: usdc.toFixed(2) })}</span> : null}
      <span className="text-xs text-slate-600">{t('count', { count: today.count })}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-brand" aria-hidden />
    </Link>
  );
}

const DEFAULT_ACCENT = '#2563eb';

// 複数持っていれば最後に更新した 1 つ (いま手を入れているページ)。
function latestHandle(handles: readonly OwnedHandle[] | undefined): OwnedHandle | null {
  if (!handles?.length) return null;
  return handles.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a));
}

function initialOf(name: string | undefined, handle: string): string {
  const n = (name ?? '').trim() || handle;
  // コードポイント単位で先頭 1 文字 (絵文字・補助漢字を割らない・components/HandleProfile.tsx と同じ)。
  return ([...n][0] ?? '@').toUpperCase();
}

/**
 * 帯の「自分のページ」の行。サインイン済み (接続中のアドレス = セッション) で @handle を持っていれば、公開ページと
 * 同じテーマと色の小さなカードに差し替える。それ以外 (未サインイン・読み込み中・handle なし・失敗) は server が描いた
 * 既定の行 (作る・編集する) のまま。どちらも同じ高さなので、差し替えても下の段は動かない。
 * 取得は GET /api/handle を他の画面と同じ cache で、ページの読み込みごとに 1 回 (KV 2〜5 コマンド・サインイン済みの持ち主だけ)。
 * 再読み込みを越えて控える (sessionStorage) ことはしない: 編集画面で保存した直後に開き直すと古いテーマが出るため
 * (plans/lp-polish-2026-09.md §2.4.2)。
 */
export function YourOpenPayPage({
  fallback,
  pageLabel,
  editLabel,
  copyLabel,
  copiedLabel,
}: {
  fallback: ReactNode;
  pageLabel: string;
  editLabel: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const locale = useLocale();
  const { status } = useAccount();
  const { isSignedIn, sessionAddress } = useSiweSession();
  // 読めなかった画像の URL (URL が変われば、新しい画像をもう一度試す・components/HandleProfile.tsx と同じ)。
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const enabled = isSignedIn && status === 'connected';
  const mine = useQuery({
    queryKey: myHandlesQueryKey(sessionAddress),
    enabled,
    queryFn: fetchMyHandles,
    // アプリ内の移動で戻ってきたときは取り直さない (編集画面の保存は ['handle-mine'] を invalidate するので古いままにならない)。
    staleTime: 5 * 60_000,
    // 飾りのカードなので、失敗は既定の行に戻すだけで取り直さない (401・502 のたびに KV を叩き直さない)。
    retry: false,
  });
  // 無効な query も、前にサインインした wallet の cache を返す。別の wallet でつないでいる間 (isSignedIn = false) に
  // その人のページを出さないよう、今の条件を満たすときだけ使う。
  const own = enabled ? latestHandle(mine.data?.handles) : null;
  if (!own) return <>{fallback}</>;

  // 色とテーマは公開ページ (app/[locale]/[handle]/page.tsx) と同じ検証: #rrggbb 以外は既定の青・未知のテーマは clean。
  const accent = own.config.color && /^#[0-9a-fA-F]{6}$/.test(own.config.color) ? own.config.color : DEFAULT_ACCENT;
  const theme = resolveHandleTheme(own.profile?.theme);
  const view = handleViewTheme(accent, theme);
  const page = handlePageTheme(accent, theme);
  const avatar = own.profile?.avatar && own.profile.avatar !== failedAvatar ? own.profile.avatar : null;
  const name = own.config.name?.trim();

  return (
    <div
      className="relative flex h-14 items-center gap-3 overflow-hidden rounded-2xl pl-3.5 pr-2 ring-1 ring-slate-200/70 lg:h-auto"
      style={{ background: page.full ? page.background : '#ffffff' }}
    >
      {page.full ? null : <div aria-hidden className="absolute inset-0" style={{ background: page.background }} />}
      {/* リンク名 = 見えている名前と @handle (掟 8)。 */}
      <Link href={`/${locale}/@${own.handle}`} prefetch={false} className="relative flex min-w-0 flex-1 items-center gap-3">
        {/* PC は行の高さが 40px (道具のボタンと同じ)。アバターの外側の輪 (最大 6px) ごと収まるよう 28px にする。 */}
        <span
          className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full text-base font-bold text-white lg:h-7 lg:w-7 lg:text-xs"
          style={{ backgroundColor: accent, boxShadow: view.avatarRing }}
        >
          {avatar ? (
            // 本人が設定した第三者 https 画像。名前は隣に文字で出ているので alt は空 (二重に読ませない)。
            <ExternalImage
              src={avatar}
              alt=""
              referrerPolicy="no-referrer"
              loading={undefined}
              decoding="async"
              className="h-full w-full object-cover"
              onError={() => setFailedAvatar(avatar)}
            />
          ) : (
            <span aria-hidden>{initialOf(name, own.handle)}</span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold" style={{ color: view.inkColor ?? '#0f172a' }}>
            {name || pageLabel}
          </span>
          <span className="block truncate text-xs font-semibold" style={{ color: view.handleColor }}>
            @{own.handle}
          </span>
        </span>
      </Link>
      <CopyPageUrl handle={own.handle} dark={page.dark} label={copyLabel} copiedLabel={copiedLabel} />
      <Link href={`/${locale}/create?tab=profile`} prefetch={false} className={`${OWN_PAGE_CHIP} ${page.dark ? OWN_PAGE_CHIP_TONE.dark : OWN_PAGE_CHIP_TONE.light}`}>
        {editLabel}
      </Link>
    </div>
  );
}

// 自分のページのカードの右の小さい丸いボタン (コピー・編集) の型。地のテーマが暗いときは白の半透明。
const OWN_PAGE_CHIP = 'relative shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition';
const OWN_PAGE_CHIP_TONE = {
  light: 'bg-white/90 text-slate-700 ring-1 ring-slate-200 hover:ring-brand/40',
  dark: 'bg-white/15 text-white hover:bg-white/25',
} as const;
// キーボードの focus の輪 (トップの節のボタンと同じ 2px・外側 2px)。暗い地の上は白。
const OWN_PAGE_FOCUS = {
  light: 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
  dark: 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
} as const;

/**
 * 自分の公開ページの URL (今の origin + /@handle・locale なし = components/HandleShareButton.tsx と同じ) をコピーする。
 * 公開ページへのリンクの外の独立したボタンで、名前は見えている「コピー」(掟 8)。押した後も見える文字は変えず、印だけを
 * 変える (幅が変わらない)。「コピーしました」は見えない role="status" で読ませ、1.5 秒で消す (useCopyToClipboard)。
 * コピーに失敗したときは印も通知も出さない (偽の成功を作らない・失敗は hook の中で止まり、帯へ波及しない)。
 * clipboard の無い環境 (http の非 localhost など) では押しても何も起きないので、ボタンを出さない。
 */
function CopyPageUrl({ handle, dark, label, copiedLabel }: { handle: string; dark: boolean; label: string; copiedLabel: string }) {
  const origin = useOrigin();
  const { copied, available, copy } = useCopyToClipboard();
  if (!available) return null;
  const Icon = copied ? Check : Copy;
  return (
    <>
      <button
        type="button"
        onClick={() => void copy(origin ? `${origin}/@${handle}` : '')}
        className={`${OWN_PAGE_CHIP} inline-flex items-center gap-1 ${dark ? `${OWN_PAGE_CHIP_TONE.dark} ${OWN_PAGE_FOCUS.dark}` : `${OWN_PAGE_CHIP_TONE.light} ${OWN_PAGE_FOCUS.light}`}`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label}
      </button>
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ''}
      </span>
    </>
  );
}
