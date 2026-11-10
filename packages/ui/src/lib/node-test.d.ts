/** Minimal types for the node:test runner used by this package's `*.test.ts` (no @types/node dependency). */
declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
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
    rejects(promise: Promise<unknown>, check?: ErrorCheck): Promise<void>;
  };
  export default assert;
}
