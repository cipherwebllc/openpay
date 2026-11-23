// 決済完了の声「オープンペイ」の読み込みと再生 (lib/successChime.ts から、支払いボタンと完了のときにだけ動的 import する)。
// 支払いの 4 ページ (/pay・/checkout・/[handle]・/tip) の First Load JS に入れないため、別の chunk に分けた
// (2026-11-24・bundle の予算がちょうど上限になったので user 裁定「先に声の読み込みを分けて軽くする」)。
//
// 完了音の声 (2026-11-23 user 裁定「声だけで短く・合成音ぽく」の s4):
// - public/sounds/openpay-complete-v1.mp3 (約 0.5 秒・mono・48 kHz・64 kbps・4,460 byte)。作り方:
//   1. Gemini API の音声生成 `gemini-api tts "オープンペイ" --language ja-JP --voice Kore --style "一息で速く短く、平板で
//      機械的な読み上げの声。抑揚は少なめ、語尾をきっぱり"` (gemini-3.8-flash-tts・24 kHz mono WAV)
//   2. 前後の無音を削る `ffmpeg -i in.wav -af "silenceremove=start_periods=1:start_threshold=-45dB,areverse,
//      silenceremove=start_periods=1:start_threshold=-45dB,areverse" -ar 24000 -ac 1 trimmed.wav`
//   3. 少し高く・ロボット声に・直流と低音を除き・音量を揃え・頭と終わりを短くフェード (終わりの「プツ」を防ぐ)
//      `ffmpeg -i trimmed.wav -af "asetrate=24000*1.15,aresample=24000,afftfilt=real='hypot(re,im)':imag='0':win_size=256:
//      overlap=0.75,highpass=f=60,loudnorm=I=-16:TP=-1.5,aresample=48000,afade=t=in:d=0.005,areverse,afade=t=in:d=0.02,
//      areverse" -ac 1 -ar 48000 -b:a 64k openpay-complete-v1.mp3`
//   TTS は同じ指定でも毎回少し違う声になるので、元の WAV は運営者の手元 (plans/sound-source/・gitignore) に残してある。
//   中身を変えるときはファイル名の版 (-v1) を上げる (古い版をキャッシュした端末と混ざらない・tests/lib/successChime.test.ts
//   が sha256 で中身を固定している)。
// - Gemini API の規約 (aistudio.google.com/docs/terms・2026-03-23 版) は「Google won't claim ownership over that content」。
//   アプリは実行時に Gemini を呼ばず、このファイルを配るだけ。他社の決済音の節や声には寄せていない (名前を読むだけ)。
// - 支払いボタンを押したとき (primeChimeAudio) に読み込んでおき、完了画面で鳴らす。読み込みが済んでいなければ最大
//   VOICE_WAIT_MS だけ待ち、それでも読めない・壊れているときは従来の合成チャイム (ポロン♪) を鳴らす。

const VOICE_URL = '/sounds/openpay-complete-v1.mp3';
/** 声の音量 (耳で合わせた値・ファイルは -16 LUFS)。計算では合成チャイムより平均で 5〜6 dB 大きい。実機の聞こえ方で直す。 */
const VOICE_GAIN = 0.5;
/** 読み込み自体の打ち切り。固まった fetch / decode を待ち続けず、次の支払いで読み直せるようにする。 */
export const VOICE_LOAD_TIMEOUT_MS = 10_000;

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
 * 声を読み込んで AudioBuffer にする。読めなかった・VOICE_LOAD_TIMEOUT_MS を過ぎたら null (失敗は覚えず、次の支払いで
 * また読む)。throw しない・reject しない。同じ読み込みの最中に呼ばれたら、その読み込みを返す (fetch は 1 本)。
 */
export function loadVoice(c: AudioContext): Promise<AudioBuffer | null> {
  if (voiceBuffer) return Promise.resolve(voiceBuffer);
  if (voiceLoading) return voiceLoading;
  const controller = new AbortController();
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const attempt: Promise<AudioBuffer | null> = fetch(VOICE_URL, { signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`voice ${response.status}`);
      return response.arrayBuffer();
    })
    .then((data) => decodeVoice(c, data))
    .then((buffer) => {
      // 打ち切り (VOICE_LOAD_TIMEOUT_MS) の後に遅れて読み終わった声も使う。正しく読めた声なので、次の支払いで
      // 読み直すより早く鳴らせる (打ち切りは「固まったまま待ち続けない」ためで、声を捨てるためではない)。
      voiceBuffer = buffer;
      return buffer;
    })
    // 声が読めなくても完了の合図は合成チャイムで出す (決済の画面に波及させない)。
    .catch(() => null);
  const timedOut = new Promise<null>((resolve) => {
    giveUp = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, VOICE_LOAD_TIMEOUT_MS);
  });
  const loading: Promise<AudioBuffer | null> = Promise.race([attempt, timedOut]).then((buffer) => {
    clearTimeout(giveUp);
    // 読めなかったら次の機会に読み直す (この読み込みがまだ最新のときだけ外す)。
    if (!buffer && voiceLoading === loading) voiceLoading = null;
    return buffer;
  });
  voiceLoading = loading;
  return loading;
}

/** 声を 1 回鳴らす。鳴らせなかったら false (呼び出し側が合成チャイムに切り替える)。 */
export function playVoice(c: AudioContext, buffer: AudioBuffer): boolean {
  try {
    const source = c.createBufferSource();
    const gain = c.createGain();
    source.buffer = buffer;
    gain.gain.value = VOICE_GAIN;
    // connect は 1 段ずつ呼ぶ (古い WebKit の connect は接続先を返さないので、つなげて書くと 2 段目で投げる)。
    source.connect(gain);
    gain.connect(c.destination);
    source.start();
    return true;
  } catch {
    return false;
  }
}
