export default class UnhandledErrorsReporter {
  onFinished(files: unknown, errors?: unknown[]): void;
}

export declare function evaluateUnhandled(text: string | null): {
  ok: boolean;
  readable: boolean;
  count: number;
  messages: string[];
};
