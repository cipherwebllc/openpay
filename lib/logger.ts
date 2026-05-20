// 構造化 JSON ログを console に書き出すロガー。
//
// Sentry 連携: error / warn は Sentry.captureMessage で独立 event として送信。
// Sentry の default integration は console を breadcrumb 化するのみで独立
// event にはならないため、明示的に capture する必要がある。DSN 未設定時は
// @sentry/nextjs の Sentry.* が安全な no-op になる (init を呼んでいないため)。

import * as Sentry from '@sentry/nextjs';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function readLevel(): Level {
  const v = (process.env.NEXT_PUBLIC_LOG_LEVEL ?? '').toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return 'warn';
}

const minLevel = readLevel();

// JSON.stringify は Error のプロパティが non-enumerable で {} を吐き、
// bigint で throw する。replacer で両方を扱う (再帰的に nested 構造へ適用)。
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// Sentry へ "fingerprint" 用のグルーピングキーとして msg を渡す。
// fields の中に Error が含まれていれば captureException で stack を保持。
function reportToSentry(level: 'warn' | 'error', msg: string, fields?: Fields): void {
  const errorField = fields
    ? Object.values(fields).find((v) => v instanceof Error)
    : undefined;
  // Sentry の SeverityLevel は 'warning' だが logger 側は 'warn' を使うため変換
  const sentryLevel: Sentry.SeverityLevel = level === 'warn' ? 'warning' : 'error';
  if (errorField instanceof Error) {
    Sentry.captureException(errorField, {
      level: sentryLevel,
      tags: { event: msg },
      extra: fields,
    });
    return;
  }
  // event tag を captureMessage にも付ける: Sentry の Alert Rule で
  // event:"scan.decode_error" のような filter を効かせるために必須
  // (DEPLOY_CHECKLIST §3.2 の alert rule 仕様が依存する)。
  Sentry.captureMessage(msg, {
    level: sentryLevel,
    tags: { event: msg },
    extra: fields,
  });
}

function emit(level: Level, msg: string, fields?: Fields): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  // fields の spread を authoritative key (ts / level / msg) より「前」に置く —
  // fields に偶発的に msg / level / ts が混入しても上書きされないようにする
  // (logger.warn('scan.decode_error', { msg: errText }) でイベント名が消えていた
  // 本物バグの再発防止、tests/lib/logger.test.ts で regression fence)。
  const entry = { ...fields, ts: new Date().toISOString(), level, msg };
  const sink =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;
  sink(JSON.stringify(entry, replacer));
  if (level === 'error' || level === 'warn') {
    reportToSentry(level, msg, fields);
  }
}

export const logger = {
  debug: (msg: string, fields?: Fields) => emit('debug', msg, fields),
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};
