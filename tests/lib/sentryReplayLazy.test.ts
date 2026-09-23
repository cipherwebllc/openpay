import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, Event, Transport } from '@sentry/core';
import { scrubReplayRecordingEvent } from '@/lib/sentryReplay';
import { installSentryReplay } from '@/lib/sentryReplayLazy';

const sdk = vi.hoisted(() => ({
  getClient: vi.fn(),
  addIntegration: vi.fn(),
  addEventProcessor: vi.fn(),
  replayIntegration: vi.fn((_options: Record<string, unknown>) => ({ name: 'Replay' })),
}));
vi.mock('@sentry/nextjs', () => sdk);

const send = vi.fn(async (_envelope: Envelope) => ({ statusCode: 200 }));
const flush = vi.fn(async () => true);
const listeners: Array<(envelope: Envelope) => void> = [];
const transport = { send, flush };
const client = {
  getOptions: vi.fn(() => ({ enabled: true })),
  getIntegrationByName: vi.fn(),
  getTransport: vi.fn((): Transport | undefined => transport),
  on: vi.fn((_hook: string, callback: (envelope: Envelope) => void) => { listeners.push(callback); }),
  emit: vi.fn((_hook: string, envelope: Envelope) => { listeners.forEach((callback) => callback(envelope)); }),
};

function recordingEnvelope(recording: string): Envelope {
  return [{ event_id: 'replay-id', sent_at: '' }, [
    [{ type: 'replay_event' }, {
      type: 'replay_event', replay_id: 'replay-id', segment_id: 0, replay_type: 'session',
      urls: [], error_ids: [], trace_ids: [], segment_names: [],
    }],
    [{ type: 'replay_recording', length: recording.length }, recording],
  ]];
}

describe('installSentryReplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.length = 0;
    transport.send = send;
    client.getOptions.mockReturnValue({ enabled: true });
    client.getIntegrationByName.mockReturnValue(undefined);
    client.getTransport.mockReturnValue(transport);
    sdk.getClient.mockReturnValue(client);
    sdk.addIntegration.mockImplementation(() => {
      client.getIntegrationByName.mockReturnValue({ name: 'Replay' });
    });
  });

  it('録画開始前に hooks を登録し、既存の privacy options を維持する', () => {
    sdk.addIntegration.mockImplementationOnce(() => {
      expect(sdk.addEventProcessor).toHaveBeenCalledOnce();
      expect(client.on).toHaveBeenCalledWith('beforeEnvelope', expect.any(Function));
    });
    installSentryReplay();
    expect(sdk.replayIntegration).toHaveBeenCalledWith({
      maskAllText: true, maskAllInputs: true, blockAllMedia: true,
      networkDetailAllowUrls: [], networkCaptureBodies: false,
      beforeAddRecordingEvent: scrubReplayRecordingEvent, useCompression: false,
    });
  });

  it('global processor が Replay metadata の urls と request.url を scrub する', () => {
    installSentryReplay();
    const processor = sdk.addEventProcessor.mock.calls[0][0] as (event: Event) => Event;
    expect(processor({
      type: 'replay_event', urls: ['https://open-pay.jp/agent#proof=secret-proof'],
      request: { url: 'https://open-pay.jp/api/order/status?t=secret-status' },
    } as Event)).toMatchObject({
      urls: ['https://open-pay.jp'], request: { url: 'https://open-pay.jp' },
    });
  });

  it('beforeEnvelope が元の envelope を in place で scrub する', () => {
    installSentryReplay();
    const envelope = recordingEnvelope('{"segment_id":0}\n' + JSON.stringify([
      { type: 2, data: { node: { attributes: { href: '/order/status?t=secret-status' } } } },
    ]));
    client.emit('beforeEnvelope', envelope);
    expect(JSON.stringify(envelope)).not.toContain('secret-status');
    expect(envelope[1][1][1]).toContain('/order/status?t=[Filtered]');
  });

  it('SDK の直接送信にも hook を補い、flush と通常 telemetry の送信を保つ', async () => {
    installSentryReplay();
    const replay = recordingEnvelope('{"segment_id":0}\n' + JSON.stringify([
      { type: 4, data: { href: 'https://open-pay.jp/agent#proof=secret-proof' } },
      { type: 3, data: { attributes: [{ attributes: { href: '/order/status?t=secret-status' } }] } },
    ]));
    await transport.send(replay);
    expect(client.emit).toHaveBeenCalledOnce();
    expect(client.emit).toHaveBeenCalledWith('beforeEnvelope', replay);
    expect(JSON.stringify(send.mock.calls)).not.toContain('secret-');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(replay);
    const error: Envelope = [{ event_id: 'error-id', sent_at: '' }, [[{ type: 'event' }, { message: 'payment failed' }]]];
    // 通常イベントは client.sendEnvelope 自身が hook を呼ぶため、bridge では二重に呼ばない。
    await transport.send(error);
    expect(client.emit).toHaveBeenCalledOnce();
    expect(send.mock.calls[1][0]).toBe(error);
    expect(transport.flush).toBe(flush);
  });

  it('不正な Replay だけを捨て、同じ envelope の決済エラーは送信する', async () => {
    installSentryReplay();
    await transport.send(recordingEnvelope('invalid recording'));
    expect(send).not.toHaveBeenCalled();
    const mixed = recordingEnvelope('invalid recording');
    const error: Envelope[1][number] = [{ type: 'event' }, { message: 'payment failed' }];
    (mixed[1] as Array<Envelope[1][number]>).push(error);
    await transport.send(mixed);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith([mixed[0], [error]]);
  });

  it('通常 envelope は hook でも変更せず、送信結果をそのまま返す', async () => {
    installSentryReplay();
    const error: Envelope = [{ event_id: 'error-id', sent_at: '' }, [[{ type: 'event' }, {
      message: 'payment failed', request: { url: 'https://open-pay.jp/path?token=unchanged' },
    }]]];
    const original = structuredClone(error);
    // 同値の再代入も検出し、通常 telemetry の envelope が一切書き換わらないことを確認する。
    Object.freeze(error);
    client.emit('beforeEnvelope', error);
    const result = Promise.resolve({ statusCode: 202 });
    send.mockReturnValueOnce(result);
    expect(transport.send(error)).toBe(result);
    expect(error).toEqual(original);
    expect(send.mock.calls[0][0]).toBe(error);
    expect(client.emit).toHaveBeenCalledOnce();
    await result;
  });

  it('transport がなければ bridge を省略して Replay を開始しない', () => {
    client.getTransport.mockReturnValue(undefined);
    installSentryReplay();
    expect(sdk.replayIntegration).not.toHaveBeenCalled();
    expect(sdk.addIntegration).not.toHaveBeenCalled();
    expect(sdk.addEventProcessor).not.toHaveBeenCalled();
    expect(client.on).not.toHaveBeenCalled();
  });

  it('bridge の設置に失敗した場合も Replay を開始しない', () => {
    client.getTransport.mockReturnValue(Object.freeze({ send, flush }));
    // この例外は instrumentation-client の遅延 import catch が UI から隔離する。
    expect(() => installSentryReplay()).toThrow(TypeError);
    expect(sdk.replayIntegration).not.toHaveBeenCalled();
    expect(sdk.addIntegration).not.toHaveBeenCalled();
  });

  it('同じ client への再登録で hooks / Replay を重複させない', () => {
    installSentryReplay();
    installSentryReplay();
    expect(sdk.addIntegration).toHaveBeenCalledOnce();
    expect(sdk.addEventProcessor).toHaveBeenCalledOnce();
    expect(client.on).toHaveBeenCalledOnce();
  });

  it('読込中に終了した client では録画を再開しない', () => {
    client.getOptions.mockReturnValue({ enabled: false });
    installSentryReplay();
    sdk.getClient.mockReturnValue(undefined);
    installSentryReplay();
    expect(sdk.addIntegration).not.toHaveBeenCalled();
    expect(sdk.replayIntegration).not.toHaveBeenCalled();
    expect(sdk.addEventProcessor).not.toHaveBeenCalled();
    expect(client.getTransport).not.toHaveBeenCalled();
    expect(client.on).not.toHaveBeenCalled();
  });
});
