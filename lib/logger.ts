// 構造化 JSON ログを stdout/console に書き出す最小ロガー。
// 本番では @sentry/nextjs が console.error / window.onerror をインター
// セプトする想定 (DSN は NEXT_PUBLIC_SENTRY_DSN で外部化)。

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

function emit(level: Level, msg: string, fields?: Fields): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...fields };
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
