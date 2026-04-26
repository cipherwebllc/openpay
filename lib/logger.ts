// 構造化 JSON ログを stdout/console に書き出す最小ロガー。
// 本番では @sentry/nextjs 等を導入し、その SDK が console.error / window.onerror を
// インターセプトする想定 (DSN は NEXT_PUBLIC_SENTRY_DSN で外部化)。
// ロガー自体は外部 SDK に依存せず、SDK 未導入でも動作する。

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly Level[];
function isLevel(v: string): v is Level {
  return (LEVELS as readonly string[]).includes(v);
}

function readLevel(): Level {
  const v = (process.env.NEXT_PUBLIC_LOG_LEVEL ?? '').toLowerCase();
  return isLevel(v) ? v : 'warn';
}

const minLevel = readLevel();

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  // JSON.stringify は bigint で throw するため文字列化
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// JSON.stringify replacer: ネスト内の bigint も safe にする
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function emit(level: Level, msg: string, fields?: Fields): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (fields) {
    for (const k of Object.keys(fields)) entry[k] = serialize(fields[k]);
  }
  const sink =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;
  sink(JSON.stringify(entry, replacer));
}

export const logger = {
  debug: (msg: string, fields?: Fields) => emit('debug', msg, fields),
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};
