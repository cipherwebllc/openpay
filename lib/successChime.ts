// 決済完了チャイム (Web Audio 合成・音源ファイル不要)。
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
  } catch {
    /* noop: 解錠失敗は無視 (最悪その回は鳴らないだけ) */
  }
}

/**
 * 短い上昇チャイム (ポロン♪)。C6→E6→G6 を少しずつ重ねた明るい完了音 (約0.5秒)。
 * sine + 短い envelope でクリック/歪みを避ける。失敗しても決済 UI を壊さない。
 */
export function playSuccessChime(): void {
  try {
    const c = getCtx();
    if (!c) return;
    // gesture 外で suspended のままなら resume を試みる (鳴らない環境では no-op)。
    if (c.state === 'suspended') void c.resume().catch(() => undefined);

    const now = c.currentTime;
    const notes: ReadonlyArray<{ freq: number; at: number }> = [
      { freq: 1046.5, at: 0 }, // C6
      { freq: 1318.5, at: 0.09 }, // E6
      { freq: 1568.0, at: 0.18 }, // G6
    ];
    const peak = 0.18; // 控えめな音量 (うるさくしない)
    const dur = 0.3;

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
    /* noop: チャイム失敗で決済完了 UI を壊さない */
  }
}

/**
 * 新着注文アラート (ピンポン♪)。受注フルフィルメント (厨房/ホール) のボードに新しい
 * 注文が届いたときに鳴らす。完了チャイムより**注意喚起寄り**(2 音ペアを2回=ドアベル風・
 * やや大きめ)。完了チャイムと同じ AudioContext を共有 (primeChimeAudio で解錠)。
 * 何があっても throw しない (ボード UI を壊さない)。
 */
export function playNewOrderChime(): void {
  try {
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') void c.resume().catch(() => undefined);

    const now = c.currentTime;
    // 「ピン・ポン」を 2 回。G5→C6 の下降ペア (呼び鈴に近い)。
    const notes: ReadonlyArray<{ freq: number; at: number }> = [
      { freq: 1046.5, at: 0 }, // C6 (ピン)
      { freq: 784.0, at: 0.16 }, // G5 (ポン)
      { freq: 1046.5, at: 0.42 }, // C6 (ピン)
      { freq: 784.0, at: 0.58 }, // G5 (ポン)
    ];
    const peak = 0.24; // 完了音 (0.18) より少し大きめ = 厨房で気付きやすく
    const dur = 0.22;

    for (const n of notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      const start = now + n.at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    }
  } catch {
    /* noop: アラート失敗でボード UI を壊さない */
  }
}
