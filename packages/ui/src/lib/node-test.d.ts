/** Minimal types for the node:test runner used by this package's `*.test.ts` (no @types/node dependency). */
declare module "node:test" {
  type Options = { todo?: boolean | string; skip?: boolean | string };
  export default function test(name: string, fn: () => void | Promise<void>): void;
  export default function test(name: string, options: Options, fn: () => void | Promise<void>): void;
  export const mock: {
    timers: {
      enable(options: { apis: ("setTimeout" | "setInterval" | "Date")[]; now?: number }): void;
      tick(ms: number): void;
      reset(): void;
    };
  };
}

declare module "node:assert/strict" {
  type ErrorCheck = (err: unknown) => boolean;
  const assert: {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    doesNotMatch(actual: string, expected: RegExp, message?: string): void;
    throws(fn: () => unknown, check?: ErrorCheck | RegExp): void;
    doesNotThrow(fn: () => unknown): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    rejects(promise: Promise<unknown>, check?: ErrorCheck): Promise<void>;
  };
  export default assert;
}

declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
