import * as Sentry from '@sentry/nextjs';
import { scrubReplayEnvelope, scrubReplayEvent, scrubReplayRecordingEvent } from './sentryReplay';

// load + idle 後に録画を開始するため、それ以前の load/hydration エラーには Replay が付かない。
export function installSentryReplay(): void {
  const client = Sentry.getClient();
  // chunk の読込中に client が終了した場合、付帯録画の再開を防ぐ。
  if (!client || client.getOptions().enabled === false || client.getIntegrationByName('Replay')) return;
  const transport = client.getTransport();
  // 送信境界を保護できなければ録画しない。未 scrub の token が Sentry へ漏れる波及を断つ。
  if (!transport) return;

  // Replay は beforeSend を通らない。録画開始前に metadata と envelope の両方を保護する。
  Sentry.addEventProcessor(scrubReplayEvent);
  client.on('beforeEnvelope', (envelope) => {
    const clean = scrubReplayEnvelope(envelope);
    if (clean !== envelope) envelope[1] = clean[1];
  });
  // SDK 10.67 の Replay は client.sendEnvelope を飛ばして transport.send を直接呼ぶ。
  // この経路だけ公開 hook を補完する。scrub 自体は上の beforeEnvelope に集約し、
  // bridge も遅延 chunk に閉じる。Sentry 更新時は tests/lib/sentryReplay.test.ts の
  // 実 recorder の送信テストを必ず再実行し、SDK の経路変更による漏えいがないか確認する。
  const send = transport.send.bind(transport);
  transport.send = (envelope) => {
    if (envelope[1].some(([header]) => header.type === 'replay_recording')) {
      client.emit('beforeEnvelope', envelope);
      // 不正な録画を捨てた空 envelope を送信せず、付帯録画の失敗を通常 telemetry へ波及させない。
      if (envelope[1].length === 0) return Promise.resolve({});
    }
    return send(envelope);
  };
  // addIntegration の afterAllSetup が init 済み client から session/error sampling rate を読む。
  Sentry.addIntegration(Sentry.replayIntegration({
    maskAllText: true,
    maskAllInputs: true,
    blockAllMedia: true,
    // body/header の allowlist は URL を隠さない。hook で navigation/network、
    // envelope で Meta/DOM を含む全 frame の token URL を scrub する。
    // SDK 10.67 は maskAttributeFn 非公開で、maskAttributes も href/src には効かない。
    networkDetailAllowUrls: [],
    networkCaptureBodies: false,
    beforeAddRecordingEvent: scrubReplayRecordingEvent,
    // 非圧縮 JSON を送信境界で処理するため無効化。録画の送信量と main-thread の
    // parse/stringify 負荷が増えるが、DOM 属性の token 漏えい防止を優先する。
    useCompression: false,
  }));
}
