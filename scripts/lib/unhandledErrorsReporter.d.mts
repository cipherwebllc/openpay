export default class UnhandledErrorsReporter {
  /** vitest 2.x の実行の終わり */
  onFinished(files: unknown, errors?: readonly unknown[]): void;
  /** vitest 4 以降の実行の終わり (onFinished は呼ばれない) */
  onTestRunEnd(testModules: unknown, unhandledErrors?: readonly unknown[], reason?: string): void;
}

export declare function evaluateUnhandled(text: string | null): {
  ok: boolean;
  readable: boolean;
  count: number;
  messages: string[];
};
