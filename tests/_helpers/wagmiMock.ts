import { vi } from 'vitest';

// vitest の mockReturnValue は完全な戻り値型を要求するが、wagmi の hook
// (useAccount / useConnect / useReadContract 等) は深いオブジェクト型を返
// すため、テストで必要なフィールドだけ与えると型エラーになる。`as never`
// で逃げる代わりに、深い Partial を許す型で受け取って 1 箇所でキャストする。
type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export function mockHook<F extends (...args: never[]) => unknown>(
  fn: F,
  value: DeepPartial<ReturnType<F>>,
): void {
  vi.mocked(fn).mockReturnValue(value as ReturnType<F>);
}
