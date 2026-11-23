// 決済完了の音 (声「オープンペイ」・読めないときは Web Audio 合成のチャイム) と、新着注文のチャイム。
//
// 完了音の声 (2026-11-23 user 裁定「声だけで短く・合成音ぽく」の s4): 読み込みと再生は lib/successVoice.ts (作り方・出どころも
// そちら)。支払いの 4 ページの First Load JS を増やさないよう、支払いボタン (primeChimeAudio) と完了 (playSuccessChime) の
// ときにだけ動的 import する。読み込みが済んでいなければ最大 VOICE_WAIT_MS だけ待ち、それでも読めない・chunk を取れない・
// 壊れているときは従来の合成チャイム (ポロン♪) を鳴らす。
//
// 設計:
// - SuccessOverlay (決済完了画面) のマウント時に playSuccessChime() を鳴らす。
// - iOS Safari は「ユーザー操作の有効窓」が切れた後の play() を自動再生ポリシーで
//   ブロックする。決済成功は送信ボタン押下から数秒後の非同期確定後なので、
//   そのままだと iOS で鳴らない。対策として支払いボタン押下 (= user gesture) の
//   瞬間に primeChimeAudio() で AudioContext を生成/解錠 (resume) しておき、
//   成功時に playSuccessChime() を鳴らす (POS/決済系 Web アプリの定番パターン)。
// - チャイムは決済 UI の本筋ではないので、何があっても throw しない (同期の処理は try/catch・動的 import と読み込みは Promise の .catch で受ける)。
// - AudioContext 非対応 (SSR / jsdom / 旧ブラウザ) では静かに no-op。
// - iOS の物理ミュートスイッチ ON 時はブラウザ仕様で鳴らない (許容)。

type WebkitWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (ctx) return ctx;
    const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * user gesture の中で呼ぶ。iOS の自動再生ロックを解錠するため、AudioContext を生成し suspended なら
 * resume する。鳴らしはしない・声も読まない (厨房や注文状況の画面の新着チャイム用)。冪等。
 */
export function unlockChimeAudio(): AudioContext | null {
  try {
    const c = getCtx();
    if (c && c.state !== 'running') void c.resume().catch(() => undefined);
    return c;
  } catch {
    /* noop: 解錠失敗は無視 (最悪その回は鳴らないだけ) */
    return null;
  }
}

/**
 * 支払いボタン押下 (user gesture) 時に呼ぶ。unlockChimeAudio と同じ解錠に加え、完了音の声を先に読んでおく
 * (決済の確定まで数秒あるので、完了画面の時点ではたいてい読み終わっている)。鳴らしはしない。冪等。
 */
export function primeChimeAudio(): void {
  const c = unlockChimeAudio();
  // chunk を取れない (deploy の直後など) ときは何もしない (支払いのボタンに波及させない・完了のときに読み直すか合成チャイム)。
  if (c) import('@/lib/successVoice').then((voice) => voice.loadVoice(c)).catch(() => undefined);
}

/** 完了画面の時点で声を読み終えていないとき、待つ上限。過ぎたら合成チャイムを鳴らす (完了の合図を遅らせすぎない)。 */
export const VOICE_WAIT_MS = 400;

type Tone = { freq: number; at: number };

/**
 * notes を sine + 短い envelope で順に鳴らす共通レンダラ。AudioContext 非対応/失敗時は
 * 静かに no-op (UI を壊さない)。各 note は `at` 秒だけ遅らせて重ねる。
 */
function playTones(notes: ReadonlyArray<Tone>, peak: number, dur: number): void {
  try {
    const c = getCtx();
    if (!c) return;
    // running でない (gesture 外の suspended・iOS が裏に回したときの interrupted) なら resume を試みる (鳴らない環境では no-op)。
    if (c.state !== 'running') void c.resume().catch(() => undefined);

    const now = c.currentTime;
    for (const n of notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      const start = now + n.at;
      // exponentialRamp は 0 を取れないため微小値から立ち上げ、減衰も微小値まで。
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      // connect は 1 段ずつ (古い WebKit の connect は接続先を返さない)。
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    }
  } catch {
    /* noop: チャイム失敗で UI を壊さない */
  }
}

/**
 * 決済完了の音。声「オープンペイ」を鳴らし、声を読めない・鳴らせないときは合成チャイム (ポロン♪) を鳴らす。
 * どちらか 1 回だけ鳴る。AudioContext 非対応では鳴らない。throw しない。
 */
export function playSuccessChime(): void {
  try {
    const c = getCtx();
    if (!c) return;
    // トグルで ON にしたとき (user gesture の中) にも解錠しておく。iOS が裏に回して interrupted にした context も戻す。
    if (c.state !== 'running') void c.resume().catch(() => undefined);
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      playFallbackChime();
    };
    // 期限は単調な時計で測り、読み終わった側でも判定する (timer の callback は event loop が塞がると遅れて走る)。
    const deadline = performance.now() + VOICE_WAIT_MS;
    const timer = setTimeout(fallback, VOICE_WAIT_MS);
    import('@/lib/successVoice')
      .then((voice) =>
        voice.loadVoice(c).then((buffer) => {
          if (settled) return;
          // 期限を過ぎていたら声は鳴らさない (合成チャイムだけ・どちらか 1 回)。
          if (!buffer || performance.now() > deadline) return fallback();
          settled = true;
          clearTimeout(timer);
          if (!voice.playVoice(c, buffer)) playFallbackChime();
        }),
      )
      // chunk を取れないときも完了の合図は合成チャイムで出す (完了画面に波及させない)。
      .catch(fallback);
  } catch {
    /* noop: 完了音の失敗で UI を壊さない */
  }
}

/** 声を使えないときの完了音 (ポロン♪)。C6→E6→G6 の明るい上昇チャイム (約0.5秒・控えめ音量)。 */
function playFallbackChime(): void {
  playTones(
    [
      { freq: 1046.5, at: 0 }, // C6
      { freq: 1318.5, at: 0.09 }, // E6
      { freq: 1568.0, at: 0.18 }, // G6
    ],
    0.18,
    0.3,
  );
}

/**
 * 新着注文アラート (ピンポン♪×2・ドアベル風)。受注フルフィルメント (厨房/ホール) のボードに
 * 新しい注文が届いたときに鳴らす。完了音より少し大きめ (0.24 vs 0.18) で厨房でも気付きやすい。
 */
export function playNewOrderChime(): void {
  playTones(
    [
      { freq: 1046.5, at: 0 }, // C6 (ピン)
      { freq: 784.0, at: 0.16 }, // G5 (ポン)
      { freq: 1046.5, at: 0.42 }, // C6 (ピン)
      { freq: 784.0, at: 0.58 }, // G5 (ポン)
    ],
    0.24,
    0.22,
  );
}
