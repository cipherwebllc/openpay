export default class UnhandledErrorsReporter {
  /** vitest 4 以降の実行の終わり */
  onTestRunEnd(testModules: unknown, unhandledErrors?: readonly unknown[], reason?: string): void;
}

export declare function evaluateUnhandled(text: string | null): {
  ok: boolean;
  readable: boolean;
  count: number;
  messages: string[];
};
