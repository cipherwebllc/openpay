'use client';

// 対面決済 (即売会・コミケ・小規模店舗) で店主が顧客のスマホ画面を 1 秒で
// 視認できるよう、決済成功時に画面全体を緑色で塗りつぶす full-screen overlay。
// PayPay の「ペイペイ！」緑画面相当。

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Volume2, VolumeX } from 'lucide-react';
import { pad } from '@/lib/pad';
import { isSuccessSoundEnabled } from '@/lib/soundPref';
import { playSuccessChime } from '@/lib/successChime';
// この画面は next/dynamic で読む (components/PaymentSuccessOverlay.tsx) ので、声の module を静的に読んでも支払いの 4 ページの
// First Load JS は増えない。触れたときに同期で鳴らすため、動的 import では読まない (await を挟むと iPhone が操作と数えない)。
import { playVoiceElement, type VoicePlayback } from '@/lib/successVoice';
import { useModalFocus } from '@/hooks/useModalFocus';
import { useSuccessSoundPref } from '@/hooks/useSuccessSoundPref';
import { CopyableField } from './CopyableField';
import { NonCustodialNotice } from './NonCustodialNotice';
import { NotifyShopButton, type NotifyShopData } from './NotifyShopButton';

/**
 * 完了画面が裏で出たとき、表に戻ってから音を鳴らす上限 (ミリ秒)。これより遅く戻ったら鳴らさない。鳴らせなかった完了音を
 * 最初に触れたときに鳴らし直すのも、鳴らそうとしてからこの時間まで。
 */
export const CHIME_ON_RETURN_MAX_MS = 60_000;
/** 完了音を鳴らしてから、鳴らせたか (Web Audio の時計が進んだか) を確かめるまでの時間 (ミリ秒)。 */
export const CHIME_SILENCE_CHECK_MS = 1_000;
/** 確かめるまでに時計がこれ (秒) より進んでいなければ、鳴らせなかったとみなす。 */
const CHIME_MIN_ADVANCE_S = 0.25;

/** 鳴らそうとした完了音。ctxTime はそのときの時計 (秒)、startedAt はそのときの時刻 (Date.now)。 */
type ChimeAttempt = { ctx: AudioContext; ctxTime: number; startedAt: number };
/** 鳴らし直しを外す。stopVoice なら、鳴らし始めを待っている声も止める (音のボタンで消したとき)。 */
type Disarm = (stopVoice?: boolean) => void;

// 時計が進んだら鳴った (その後に割り込みで suspended になっていても、鳴った分は鳴った)。
function chimeClockAdvanced(attempt: ChimeAttempt): boolean {
  return attempt.ctx.currentTime - attempt.ctxTime >= CHIME_MIN_ADVANCE_S;
}

/**
 * まだ鳴っていない完了音の予約を、context ごと閉じて取り消す。閉じた context は lib/successChime.ts が次に鳴らすときに
 * 作り直す。
 */
function cancelChimeAttempt(attempt: ChimeAttempt): void {
  try {
    void attempt.ctx.close().catch(() => undefined);
  } catch {
    /* noop: 閉じられない古いブラウザでも、触れたときの声は鳴らす */
  }
}

/**
 * 鳴らした完了音が本当に鳴ったかを CHIME_SILENCE_CHECK_MS の後に確かめ、鳴っていなければ、最初に触れたときに audio 要素で
 * 鳴らし直す。外す関数を返す。onDone は、もう鳴らし直さないと決まったとき (鳴った・鳴らし直した・時間切れ・OFF) に呼ぶ。
 *
 * iPhone は、ほかのアプリ (HashPort 等) から戻った後、Web Audio を「running」と言いながら時計を止めて無音にする。作り直した
 * AudioContext も同じで、触らずに鳴らす audio 要素も無音か断られる。鳴ったのは、画面に触れたときの audio 要素だけだった
 * (2026-11-24 iOS 27.2 のホーム画面のアプリで実測・Safari でも鳴らなかった)。時計が進んだ端末 (Android・ふだんの iPhone) では
 * 何もしないので、2 回は鳴らない。確かめるまでの 1 秒に触れても数えない (鳴ったかがまだ分からない・戻って 1 秒以内に
 * 閉じたら鳴らないまま)。
 */
function watchChimeSilence(attempt: ChimeAttempt, onDone: () => void): Disarm {
  let disarmTap: Disarm | null = null;
  const timer = setTimeout(
    () => {
      if (chimeClockAdvanced(attempt)) {
        onDone();
        return;
      }
      // 鳴らなかった完了音の予約を取り消す (後で context が動き出しても、触れたときの声と 2 回にならない・スリープで
      // 確かめるのが 60 秒を過ぎても、後から急に鳴らない)。
      cancelChimeAttempt(attempt);
      if (Date.now() - attempt.startedAt > CHIME_ON_RETURN_MAX_MS) {
        onDone();
        return;
      }
      disarmTap = listenFirstTap(attempt, onDone);
    },
    Math.max(0, attempt.startedAt + CHIME_SILENCE_CHECK_MS - Date.now()),
  );
  return (stopVoice) => {
    clearTimeout(timer);
    disarmTap?.(stopVoice);
  };
}

/** 画面のどこかに触れたら (音のボタンを除く)、声を 1 回鳴らす。CHIME_ON_RETURN_MAX_MS を過ぎたら聞き手を外す。 */
function listenFirstTap(attempt: ChimeAttempt, onDone: () => void): Disarm {
  let pending: VoicePlayback | null = null;
  // 触れずに時間がたったら、聞き手を外す (document に残さない)。スリープで timer が遅れた分は、触れたときの時刻で見る。
  const expiry = setTimeout(finish, Math.max(0, attempt.startedAt + CHIME_ON_RETURN_MAX_MS - Date.now()));
  function remove() {
    clearTimeout(expiry);
    document.removeEventListener('touchend', onTap, true);
    document.removeEventListener('click', onTap, true);
  }
  function finish() {
    remove();
    onDone();
  }
  function onTap(event: Event) {
    // 音のボタンは自分で鳴らすか消す (消すために押したときに声が鳴らないよう、ここでは数えない)。
    if (event.target instanceof Element && event.target.closest('[data-chime-toggle]')) return;
    // 時間がたちすぎた・音を消したなら、鳴らさずに外す。
    if (Date.now() - attempt.startedAt > CHIME_ON_RETURN_MAX_MS || !isSuccessSoundEnabled()) {
      finish();
      return;
    }
    // 鳴らし始めるのを待っている間 (声の読み込み中) は、次を鳴らさない (2 回にならない)。1 回のタップの touchend と
    // click もこれで 1 回になる (鳴り始めたら聞き手を外す・断られた後の click は試し直すだけ)。
    if (pending) return;
    const playback = playVoiceElement();
    pending = playback;
    // 断られた (scroll の後に指を離したときは、iPhone が操作と数えない) ら、次に触れたときにまた試す。
    void playback.result.then((ok) => {
      pending = null;
      if (ok) finish();
    });
  }
  // 画面のどこに触れても受けるよう document で受ける。iPhone は、押せない要素への tap の click を document まで届けない
  // ことがあるので touchend でも受ける。capture にして、中の要素が伝わりを止めても受ける。
  document.addEventListener('touchend', onTap, true);
  document.addEventListener('click', onTap, true);
  // 完了画面を閉じたとき (「閉じる」に触れたときを含む) は、鳴らし始めた声を止めない (触れたときに鳴らすと決めた声)。
  return (stopVoice) => {
    remove();
    if (stopVoice) pending?.stop();
  };
}

function formatTimeHMS(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function SuccessOverlay({
  amountDisplay,
  txHash,
  userOpHash,
  blockNumber,
  explorerBase,
  merchantAddress,
  orderNo,
  notify,
  onDismiss,
}: {
  amountDisplay: string;
  txHash: string;
  userOpHash?: string;
  // EIP-3009 relay (Gelato) は receipt の blockNumber を取らないため任意。未指定なら行を省く。
  blockNumber?: bigint;
  explorerBase?: string;
  /**
   * 店舗ウォレットアドレス。指定時は Explorer の /address/ ページへの link を
   * 追加で描画し「他に何件着金しているか」を顧客 / 店主が即座に検証できるようにする。
   */
  merchantAddress?: string;
  /** 受付番号 (受け渡し照合用)。checkout で order_id があるときのみ・無ければ表示しない。 */
  orderNo?: string;
  /** 遠隔の注文 (注文リンクなど) で、お客様が自分の LINE やメールで注文やお支払いをお店に送るボタンを出す。 */
  notify?: NotifyShopData;
  onDismiss: () => void;
}) {
  const t = useTranslations('SuccessOverlay');
  const titleId = useId();
  const [now, setNow] = useState(() => new Date());
  const dialogRef = useRef<HTMLDivElement>(null);
  const [soundOn, setSoundOn] = useSuccessSoundPref();

  // 決済完了の音 (声「オープンペイ」・読めないときは合成チャイム・lib/successChime.ts)。overlay マウント時に 1 回だけ
  // 鳴らす。有効判定は永続値を直接読む (toggle state の hydration を待たない)。
  // 各 form の onSubmit で primeChimeAudio() 済なので iOS でも鳴る。
  // ページが裏にあるとき (ウォレットのアプリで承認している間に決済が確定した等) は iPhone が音を出さないので、表に戻った
  // ときに 1 回だけ鳴らす (2026-11-24 user「HashPort で承認して戻るのが遅く、完了画面が出ていて鳴らなかった」)。戻るまでが
  // CHIME_ON_RETURN_MAX_MS を超えたら鳴らさない (時間がたってから急に鳴って驚かせない)。StrictMode の mount → unmount →
  // mount でも聞き手を付け直せるよう、chimedRef は鳴らしたとき (または鳴らさないと決めたとき) にだけ立てる。
  // 鳴らしたのに鳴らなかった (iPhone がほかのアプリから戻った後の Web Audio を無音にする) ときは、最初に触れたときに鳴らし
  // 直す (2026-11-24 user 裁定「最初に触れたとき」・watchChimeSilence)。attemptRef は鳴らし直す候補で、もう鳴らし直さないと
  // 決まったら null。StrictMode の付け直しでは、確かめと聞き手だけを付け直す。
  const chimedRef = useRef(false);
  const attemptRef = useRef<ChimeAttempt | null>(null);
  const disarmRef = useRef<Disarm | null>(null);
  // 音のボタンで出したときの確認の音 (鳴らし始めるまで)。消した・押し直した・閉じたら null (後から合成チャイムを鳴らさない)。
  const previewRef = useRef<VoicePlayback | null>(null);
  useEffect(
    () => () => {
      previewRef.current = null;
    },
    [],
  );
  useEffect(() => {
    const watch = () => {
      const attempt = attemptRef.current;
      if (!attempt) return;
      disarmRef.current = watchChimeSilence(attempt, () => {
        attemptRef.current = null;
      });
    };
    const disarm = () => {
      disarmRef.current?.();
      disarmRef.current = null;
    };
    if (chimedRef.current) {
      watch();
      return disarm;
    }
    if (!isSuccessSoundEnabled()) return;
    const play = () => {
      if (chimedRef.current) return;
      chimedRef.current = true;
      const ctx = playSuccessChime();
      if (ctx) attemptRef.current = { ctx, ctxTime: ctx.currentTime, startedAt: Date.now() };
      watch();
    };
    if (document.visibilityState !== 'hidden') {
      play();
      return disarm;
    }
    // 戻るまでの時間はふだんの時刻 (Date.now) で測る。WebKit の performance.now は端末のスリープ中に進まないので、
    // スリープを挟むと 60 秒を過ぎても「60 秒以内」に見えてしまう。
    const shownAt = Date.now();
    const onVisible = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', onVisible);
      // 待っている間に (別のタブの完了画面などで) 完了音を OFF にしていたら鳴らさない。
      if (Date.now() - shownAt <= CHIME_ON_RETURN_MAX_MS && isSuccessSoundEnabled()) play();
      else chimedRef.current = true;
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      disarm();
    };
  }, []);

  // 1 秒ごとに現在時刻を更新 (店主が「今支払った」と判断する時計)
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // 完了音 ON/OFF トグル。ON に切り替えた瞬間は user gesture 内なので、確認用に
  // 1 回プレビュー再生する (「鳴る音」を体験させる)。
  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    // 押したら (消す・出すのどちらでも)、鳴らせなかった完了音を後で鳴らし直すのはやめ、鳴らし始めを待っている声も止める
    // (消したのに後から鳴らさない・出すときは、ここで鳴らす)。
    disarmRef.current?.(true);
    disarmRef.current = null;
    // 消すときは、まだ鳴っていない (時計が止まった) 完了音の予約も取り消す (後で context が動き出しても鳴らさない)。
    const attempt = attemptRef.current;
    if (!next && attempt && !chimeClockAdvanced(attempt)) cancelChimeAttempt(attempt);
    attemptRef.current = null;
    previewRef.current?.stop();
    previewRef.current = null;
    // 確認の音は、押した操作の中で audio 要素で鳴らす (iPhone がほかのアプリから戻った後も鳴る・watchChimeSilence)。
    // audio 要素で鳴らせなかったときは、Web Audio で鳴らす。
    if (next) {
      const preview = playVoiceElement();
      previewRef.current = preview;
      void preview.result.then((ok) => {
        if (previewRef.current !== preview) return;
        previewRef.current = null;
        if (!ok) playSuccessChime();
      });
    }
  }

  // mount が open に相当する。開いたら dialog へ focus・Tab は中だけ・Escape で閉じる・閉じたら元の要素へ戻す。
  useModalFocus(dialogRef, { open: true, onEscape: onDismiss });

  const explorerTxUrl =
    explorerBase && txHash ? `${explorerBase}/tx/${txHash}` : undefined;
  const explorerAddressUrl =
    explorerBase && merchantAddress
      ? `${explorerBase}/address/${merchantAddress}`
      : undefined;

  // 地は emerald-700 で、白の文字は 5.48:1 (WCAG 2.2 AA の 4.5:1 に届く)。emerald-500 の地では白が 2.54:1 で届かなかった。
  // 文字は opacity や text-white/90 で薄くしない (emerald-700 の上で白の 80% は 4.11:1)。bg-white/10 の欄の上の白は
  // 4.53:1 で余裕が小さいので、欄をこれより明るくしない (tests/components/SuccessOverlay.test.tsx が計算して確かめる)。
  // 縦の中央寄せは justify-center ではなく、最初の要素の mt-auto と最後の要素の mb-auto で行う。justify-center だと、
  // 中身が画面より高いときに上にもはみ出し、scroll で「✓ 決済完了」へ戻れなかった (375×667 の注文で 107px)。auto の
  // 余白は余った高さだけを分けるので、高いときは 0 になり、中身は上の端から始まる。
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col items-center gap-6 overflow-y-auto bg-emerald-700 px-4 py-8 text-white"
    >
      {/* 完了音 ON/OFF トグル (右上)。完了音のミュート切替・localStorage 永続。
          名前は固定 (「完了音」) し、状態は aria-pressed とアイコンだけで伝える。名前まで「オフにする / オンにする」と
          切り替えると「完了音をオフにする・押されている」= 消音中と読まれ、実際と逆に聞こえる (D5)。 */}
      <button
        type="button"
        onClick={toggleSound}
        data-chime-toggle
        aria-pressed={soundOn}
        aria-label={t('soundToggle')}
        title={t('soundToggle')}
        className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
      >
        {soundOn ? (
          <Volume2 className="h-5 w-5" aria-hidden />
        ) : (
          <VolumeX className="h-5 w-5" aria-hidden />
        )}
      </button>

      {/* 大きい ✓ + タイトル (mt-auto で中央に寄せる・上の root のコメント) */}
      <div className="mt-auto flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-3xl font-black text-emerald-600 sm:h-16 sm:w-16 sm:text-4xl"
        >
          ✓
        </span>
        <h2 id={titleId} aria-live="assertive" className="text-3xl font-bold sm:text-4xl">{t('title')}</h2>
      </div>

      {/* 巨大金額 (店主が遠くから視認できるサイズ) */}
      <div className="text-center">
        <p className="text-xs uppercase tracking-wider">
          {t('amountLabel')}
        </p>
        <p className="mt-1 break-all text-5xl font-black sm:text-6xl">
          {amountDisplay}
        </p>
      </div>

      {/* 受付番号 (受け渡し照合用)。店主が遠くから読める大きさ・受け渡し時に「この番号の方」で照合。
          checkout で order_id があるときのみ (QR/チップ等の単発決済では出ない)。 */}
      {orderNo && (
        <div className="text-center">
          <p className="text-xs uppercase tracking-wider">
            {t('orderNoLabel')}
          </p>
          <p className="mt-1 font-mono text-4xl font-black tracking-widest sm:text-5xl">
            {orderNo}
          </p>
        </div>
      )}

      {/* 遠隔の注文: 注文やお支払いをお客様自身の LINE やメールでお店に送る (文はこのブラウザの中で作る)。 */}
      {notify && <NotifyShopButton {...notify} tone="overlay" />}

      {/* 完了時刻 (HH:MM:SS、毎秒更新) */}
      <div className="text-center">
        <p className="text-xs uppercase tracking-wider">
          {t('timeLabel')}
        </p>
        <p className="mt-1 font-mono text-2xl tabular-nums sm:text-3xl">
          {formatTimeHMS(now)}
        </p>
      </div>

      {/* tx 詳細 (コピー可能) */}
      <dl className="w-full max-w-md space-y-1 rounded-lg bg-white/10 px-4 py-3 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="shrink-0">{t('txHashLabel')}</dt>
          <dd className="min-w-0 flex-1 text-right">
            <CopyableField
              value={txHash}
              label={t('txHashLabel')}
              displayValue={`${txHash.slice(0, 10)}…${txHash.slice(-6)}`}
              className="text-white"
              tone="overlay"
            />
          </dd>
        </div>
        {userOpHash && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="shrink-0">{t('userOpHashLabel')}</dt>
            <dd className="min-w-0 flex-1 text-right">
              <CopyableField
                value={userOpHash}
                label={t('userOpHashLabel')}
                displayValue={`${userOpHash.slice(0, 10)}…${userOpHash.slice(-6)}`}
                className="text-white"
                tone="overlay"
              />
            </dd>
          </div>
        )}
        {blockNumber !== undefined && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="shrink-0">{t('blockLabel')}</dt>
            <dd className="font-mono">{blockNumber.toString()}</dd>
          </div>
        )}
      </dl>

      {/* hover は線を太くして示す (薄くすると emerald-700 の上で 4.5:1 を割る)。 */}
      <div className="flex flex-col items-center gap-1 text-sm">
        {explorerTxUrl && (
          <a
            href={explorerTxUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4 hover:decoration-2"
          >
            {t('explorerLink')}
          </a>
        )}
        {explorerAddressUrl && (
          <a
            href={explorerAddressUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4 hover:decoration-2"
          >
            {t('merchantAddressExplorerLink')}
          </a>
        )}
        <Link
          href="/history"
          prefetch={false}
          className="underline underline-offset-4 hover:decoration-2"
        >
          {t('viewLocalHistoryLink')}
        </Link>
        {/* 顧客向け: /scan に保存された電子レシート (支払い控え) を見る導線。 */}
        <Link
          href="/scan"
          prefetch={false}
          className="underline underline-offset-4 hover:decoration-2"
        >
          {t('viewReceiptsLink')}
        </Link>
      </div>

      {/* ノンカストディ宣言: 店主に「DB は持っていない、Explorer が source of truth」を毎回伝える */}
      <NonCustodialNotice
        variant="short"
        className="w-full max-w-md text-white"
      />

      {/* 明示的 dismiss (店主の視認後、客が押す・mb-auto で中央に寄せる) */}
      <div className="mb-auto flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-full bg-white px-8 py-3 text-base font-bold text-emerald-700 shadow-lg hover:bg-emerald-50"
        >
          {t('dismiss')}
        </button>
        <p className="text-[10px]">{t(notify ? (notify.askShipping ? 'sendOrderDismissHelp' : 'notifyShopDismissHelp') : 'dismissHelp')}</p>
      </div>
    </div>
  );
}
