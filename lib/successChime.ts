// 決済完了の音 (声「オープンペイ」・読めないときは Web Audio 合成のチャイム) と、新着注文のチャイム。
//
// 完了音の声 (2026-11-23 user 裁定「声だけで短く・合成音ぽく」の s4):
// - public/sounds/openpay-complete-v1.mp3 (約 0.5 秒・mono・約 4.4 KB)。Gemini API の音声生成
//   (gemini-3.8-flash-tts・voice Kore・language ja-JP・style「一息で速く短く、平板で機械的な読み上げの声。抑揚は少なめ、
//   語尾をきっぱり」・本文「オープンペイ」) の出力の前後の無音を削り、ffmpeg で
//   `asetrate=24000*1.15,aresample=24000,afftfilt=real='hypot(re,im)':imag='0':win_size=256:overlap=0.75,loudnorm=I=-16:TP=-1.5`
//   をかけて 64 kbps の mp3 にした。中身を変えるときはファイル名の版 (-v1) を上げる (古い版をキャッシュした端末と混ざらない)。
// - Gemini API の規約 (aistudio.google.com/docs/terms・2026-03-23 版) は「Google won't claim ownership over that content」。
//   アプリは実行時に Gemini を呼ばず、このファイルを配るだけ。他社の決済音の節や声には寄せていない (名前を読むだけ)。
// - 支払いボタンを押したとき (primeChimeAudio) に読み込んでおき、完了画面で鳴らす。読み込みが済んでいなければ最大
//   VOICE_WAIT_MS だけ待ち、それでも読めない・壊れているときは従来の合成チャイム (ポロン♪) を鳴らす。
//
// 設計:
// - SuccessOverlay (決済完了画面) のマウント時に playSuccessChime() を鳴らす。
// - iOS Safari は「ユーザー操作の有効窓」が切れた後の play() を自動再生ポリシーで
//   ブロックする。決済成功は送信ボタン押下から数秒後の非同期確定後なので、
//   そのままだと iOS で鳴らない。対策として支払いボタン押下 (= user gesture) の
//   瞬間に primeChimeAudio() で AudioContext を生成/解錠 (resume) しておき、
//   成功時に playSuccessChime() を鳴らす (POS/決済系 Web アプリの定番パターン)。
// - チャイムは決済 UI の本筋ではないので、何があっても throw しない (全 try/catch)。
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
 * 支払いボタン押下 (user gesture) 時に呼ぶ。iOS の自動再生ロックを解錠するため、
 * AudioContext を生成し suspended なら resume する。鳴らしはしない。冪等。
 */
export function primeChimeAudio(): void {
  try {
    const c = getCtx();
    if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
    // 完了音の声を先に読んでおく (決済の確定まで数秒あるので、完了画面の時点ではたいてい読み終わっている)。
    if (c) void loadVoice(c);
  } catch {
    /* noop: 解錠失敗は無視 (最悪その回は鳴らないだけ) */
  }
}

// ── 完了音の声 ──────────────────────────────────────────────────────────────
const VOICE_URL = '/sounds/openpay-complete-v1.mp3';
/** 声の音量。合成チャイム (peak 0.18 の sine 3 音) と同じくらいに聞こえる大きさ (ファイルは -16 LUFS に揃えてある)。 */
const VOICE_GAIN = 0.5;
/** 完了画面の時点で声を読み終えていないとき、待つ上限。過ぎたら合成チャイムを鳴らす (完了の合図を遅らせすぎない)。 */
export const VOICE_WAIT_MS = 400;

let voiceBuffer: AudioBuffer | null = null;
let voiceLoading: Promise<AudioBuffer | null> | null = null;

// 古い Safari の decodeAudioData は Promise を返さず callback だけなので、両方の形を 1 つの Promise にまとめる
// (二重に resolve しても最初の値だけが使われる)。
function decodeVoice(c: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    try {
      const result = c.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (result && typeof result.then === 'function') result.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 声を読み込んで AudioBuffer にする。読めなかったら null (失敗は覚えず、次の支払いでまた読む)。throw しない。
 * 同じ読み込みの最中に呼ばれたら、その読み込みを返す。
 */
function loadVoice(c: AudioContext): Promise<AudioBuffer | null> {
  if (voiceBuffer) return Promise.resolve(voiceBuffer);
  if (voiceLoading) return voiceLoading;
  if (typeof fetch !== 'function') return Promise.resolve(null);
  voiceLoading = fetch(VOICE_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`voice ${response.status}`);
      return response.arrayBuffer();
    })
    .then((data) => decodeVoice(c, data))
    .then((buffer) => {
      voiceBuffer = buffer;
      return buffer;
    })
    .catch(() => {
      // 声が読めなくても完了の合図は合成チャイムで出す (決済の画面に波及させない)。次の機会に読み直す。
      voiceLoading = null;
      return null;
    });
  return voiceLoading;
}

/** 声を 1 回鳴らす。鳴らせなかったら false (呼び出し側が合成チャイムに切り替える)。 */
function playVoice(c: AudioContext, buffer: AudioBuffer): boolean {
  try {
    const source = c.createBufferSource();
    const gain = c.createGain();
    source.buffer = buffer;
    gain.gain.value = VOICE_GAIN;
    source.connect(gain).connect(c.destination);
    source.start();
    return true;
  } catch {
    return false;
  }
}

type Tone = { freq: number; at: number };

/**
 * notes を sine + 短い envelope で順に鳴らす共通レンダラ。AudioContext 非対応/失敗時は
 * 静かに no-op (UI を壊さない)。各 note は `at` 秒だけ遅らせて重ねる。
 */
function playTones(notes: ReadonlyArray<Tone>, peak: number, dur: number): void {
  try {
    const c = getCtx();
    if (!c) return;
    // gesture 外で suspended のままなら resume を試みる (鳴らない環境では no-op)。
    if (c.state === 'suspended') void c.resume().catch(() => undefined);

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
      osc.connect(gain).connect(c.destination);
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
    // トグルで ON にしたとき (user gesture の中) にも解錠しておく。
    if (c.state === 'suspended') void c.resume().catch(() => undefined);
    if (voiceBuffer) {
      if (!playVoice(c, voiceBuffer)) playFallbackChime();
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      playFallbackChime();
    }, VOICE_WAIT_MS);
    void loadVoice(c).then((buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!buffer || !playVoice(c, buffer)) playFallbackChime();
    });
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
