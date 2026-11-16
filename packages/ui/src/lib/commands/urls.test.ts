import assert from "node:assert/strict";
import test from "node:test";
import { extractLocalUrls } from "./urls";

test("extractLocalUrls finds unique local dev URLs, strips ANSI, and rewrites 0.0.0.0", () => {
  const sample = [
    "\x1b[32m  VITE v6.0.0\x1b[0m  ready in 312 ms",
    "  ➜  Local:   \x1b[36mhttp://localhost:5173/\x1b[0m",
    "  ➜  API:     http://0.0.0.0:8787/api.",
    "  ➜  Repeat:  http://localhost:5173/",
    "  ➜  IPv4:    http://127.0.0.1:4000/dashboard",
  ].join("\n");

  assert.deepEqual(extractLocalUrls(sample), ["http://localhost:5173/", "http://localhost:8787/api", "http://127.0.0.1:4000/dashboard"]);
});
