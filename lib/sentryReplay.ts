import type { Envelope, Event, ReplayEvent } from '@sentry/core';
import type { ReplayFrameEvent } from '@sentry/nextjs';
import { scrubSentryServerEvent, urlOriginForTelemetry } from './telemetryRedaction';

// Replay は beforeSend を通らない。metadata の URL は error telemetry と同じく
// origin のみにする (webhook の認証情報は path/userinfo にも入り得る)。
export function scrubReplayEvent<T extends Event>(event: T): T {
  if (event.type !== 'replay_event') return event;
  const replay = event as T & Partial<ReplayEvent> & { initialUrl?: string };
  const clean = { ...replay };
  if (replay.urls) clean.urls = replay.urls.map(urlOriginForTelemetry);
  if (typeof replay.initialUrl === 'string') {
    clean.initialUrl = urlOriginForTelemetry(replay.initialUrl);
  }
  if (replay.request) {
    clean.request = scrubSentryServerEvent({
      request: { ...replay.request, headers: { ...replay.request.headers } },
    }).request;
  }
  return clean;
}

const RECORDING_URL_KEYS = ['url', 'href', 'from', 'to', 'previous', 'location', 'Location'];
const TOKEN_PARAM_NAMES = new Set(['t', 's', 'proof', 'token']);

// DOM の href/src だけでなく、mutation・CSS・plugin 等に入った URL からも token を除去する。
// frame の型や属性名に依存しないことで、別表現の URL が録画経由で漏れる波及を断つ。
// 非機密の path/query と CSS の引用符/括弧は残し、録画の見た目を保つ。
function scrubTokenValues(raw: string): string {
  return raw.replace(
    /([?&#])([^=&#?\s"'<>]+)=([^&#\s"'<>)]*)/g,
    (_match: string, separator: string, rawKey: string, value: string) => {
      // URLSearchParams で percent encoded なキーも比較する (%74oken 等)。
      const [key] = new URLSearchParams(`${rawKey}=`).keys();
      // next=https://.../?token=... のような入れ子 URL も値の部分を調べる。
      let cleanValue = '[Filtered]';
      if (!TOKEN_PARAM_NAMES.has(key.toLowerCase())) {
        if (/%(?:3f|23|26)/i.test(value)) {
          // encoded な ?/#/& も調べる。非機密値の encoding は変更しない。
          // 不正な encoding は下の envelope catch で Replay ごと捨て、token 漏えいを防ぐ。
          const decoded = decodeURIComponent(value);
          const clean = scrubTokenValues(decoded);
          cleanValue = clean === decoded ? value : encodeURIComponent(clean);
        } else {
          cleanValue = scrubTokenValues(value);
        }
      }
      return `${separator}${rawKey}=${cleanValue}`;
    },
  );
}

function scrubRecordingData(data: object | undefined) {
  if (!data) return data;
  const clean: Record<string, unknown> = { ...data };
  for (const key of RECORDING_URL_KEYS) {
    if (typeof clean[key] === 'string') clean[key] = urlOriginForTelemetry(clean[key]);
  }
  delete clean['http.query'];
  delete clean['http.fragment'];
  return clean;
}

// SDK 10.67 がこの hook を呼ぶのは Custom (type 5) のみ。beforeBreadcrumb と別経路の
// network span もここで scrub する。Meta/DOM を含む全 frame は下の送信境界でも処理する。
export function scrubReplayRecordingEvent(event: ReplayFrameEvent): ReplayFrameEvent {
  const { tag, payload } = event.data;
  if (tag === 'performanceSpan') {
    const isUrl = payload.op.startsWith('navigation.') || payload.op.startsWith('resource.');
    return {
      ...event,
      data: {
        ...event.data,
        tag,
        payload: {
          ...payload,
          description: isUrl ? urlOriginForTelemetry(payload.description) : payload.description,
          data: scrubRecordingData(payload.data),
        },
      },
    };
  }
  if (tag === 'breadcrumb') {
    // Replay 固有の UI category にも URL が入るため、URL 形の message は category に
    // 関係なく scrub する。相対パスの診断情報より、token の telemetry への波及防止を優先。
    const message = payload.message;
    return {
      ...event,
      data: {
        ...event.data,
        tag,
        payload: {
          ...payload,
          data: scrubRecordingData(payload.data),
          ...(typeof message === 'string' && (/^https?:\/\//i.test(message) || message.startsWith('/'))
            ? { message: urlOriginForTelemetry(message) } : {}),
        },
      },
    };
  }
  return event;
}

/**
 * SDK 10.67 の rrweb Meta/DOM frame は beforeAddRecordingEvent を通らない。
 * useCompression:false で header + 改行 + JSON を保持し、公開 transport 境界で
 * 全 frame の token 値を除去する。SDK の private API や圧縮用依存には触れない。
 */
export function scrubReplayEnvelope(envelope: Envelope): Envelope {
  if (!envelope[1].some(([header]) =>
    header.type === 'replay_recording' || header.type === 'replay_event',
  )) return envelope;
  try {
    const items = envelope[1].map((item): Envelope[1][number] => {
      const [header, payload] = item;
      // scope の分岐等で processor を通さなくても、metadata の token を送信先へ漏らさない。
      if (header.type === 'replay_event') return [header, scrubReplayEvent(payload as ReplayEvent)];
      if (header.type !== 'replay_recording') return item;
      if (typeof payload !== 'string') throw new Error('unexpected_compressed_replay');
      const newline = payload.indexOf('\n');
      if (newline < 0) throw new Error('invalid_replay_recording');
      const frames: Array<{ type: number; data: Record<string, unknown> }> = JSON.parse(
        payload.slice(newline + 1),
        (_key: string, value: unknown) => typeof value === 'string' ? scrubTokenValues(value) : value,
      );
      const cleanFrames = frames.map((frame) => {
        if (frame.type === 4) return { ...frame, data: scrubRecordingData(frame.data) };
        return frame;
      });
      const recording = payload.slice(0, newline + 1) + JSON.stringify(cleanFrames);
      return [{ ...header, length: new TextEncoder().encode(recording).length }, recording];
    });
    return [envelope[0], items] as Envelope;
  } catch {
    // 解釈できない録画を未 scrub のまま送る漏えいと、scrub の障害がアプリや決済エラーの
    // telemetry へ波及するのを断つ。Replay の pair だけを捨て、通常のエラーは保持する。
    return [envelope[0], envelope[1].filter(([header]) =>
      header.type !== 'replay_event' && header.type !== 'replay_recording',
    )] as Envelope;
  }
}
