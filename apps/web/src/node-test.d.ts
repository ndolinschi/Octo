/** Minimal types for the node:test runner used by `*.test.ts` here (no @types/node dependency; same approach as packages/ui). */
declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
  export default assert;
}
