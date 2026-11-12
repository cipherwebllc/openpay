// 構造化 JSON ログを console に書き出すロガー。
//
// Sentry 連携: error / warn は Sentry.captureMessage で独立 event として送信。
// Sentry の default integration は console を breadcrumb 化するのみで独立
// event にはならないため、明示的に capture する必要がある。DSN 未設定時は
// @sentry/nextjs の Sentry.* が安全な no-op になる (init を呼んでいないため)。

import * as Sentry from '@sentry/nextjs';
import { redactLogText } from './telemetryRedaction';

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
  // 署名済みの UserOperation と key つきの URL (viem の error の文) を log に出さない。上の Error の
  // message・stack も、返した object の欄としてここを通る。
  if (typeof value === 'string') return redactLogText(value);
  return value;
}

// captureException に渡す Error。伏せる所が無ければ元の Error をそのまま返す (Sentry の grouping は今までと同じ)。
// あれば name・stack の frame・cause の並びを保った写しを返す (元の Error は書き換えない)。Sentry の browser の
// stack parser は、stack の先頭に入った message の `URL: <url>` の行を frame として読むので、その frame の filename
// だけが key つきの URL から origin に変わる (key を含んだままでは同じ group にできない)。
// cause をたどるのは 5 段まで (Sentry の LinkedErrors が読む段数と同じ)。
function redactError(error: Error, depth = 0): Error {
  const message = redactLogText(error.message);
  const stack = error.stack && redactLogText(error.stack);
  const cause =
    depth < 5 && error.cause instanceof Error ? redactError(error.cause, depth + 1) : undefined;
  if (message === error.message && stack === error.stack && (!cause || cause === error.cause)) {
    return error;
  }
  const copy = new Error(message, { cause });
  copy.name = error.name;
  copy.stack = stack;
  return copy;
}

// Sentry へ "fingerprint" 用のグルーピングキーとして msg を渡す。
// fields の中に Error が含まれていれば captureException で stack を保持。
function reportToSentry(level: 'warn' | 'error', msg: string, fields?: Fields): void {
  const errorField = fields
    ? Object.values(fields).find((v) => v instanceof Error)
    : undefined;
  // Sentry の SeverityLevel は 'warning' だが logger 側は 'warn' を使うため変換
  const sentryLevel: Sentry.SeverityLevel = level === 'warn' ? 'warning' : 'error';
  // extra は fields を深く伏せた写し (console と同じ replacer を通した JSON の形・元の fields は書き換えない)。
  const extra: Fields | undefined = fields && JSON.parse(JSON.stringify(fields, replacer));
  if (errorField instanceof Error) {
    Sentry.captureException(redactError(errorField), {
      level: sentryLevel,
      tags: { event: msg },
      extra,
    });
    return;
  }
  // event tag を captureMessage にも付ける: Sentry の Alert Rule で
  // event:"scan.decode_error" のような filter を効かせるために必須
  // (DEPLOY_CHECKLIST §3.2 の alert rule 仕様が依存する)。
  Sentry.captureMessage(msg, {
    level: sentryLevel,
    tags: { event: msg },
    extra,
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
