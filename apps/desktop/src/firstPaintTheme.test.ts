import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
// A file, not an inline script: the Content-Security-Policy (tauri.conf.json, script-src 'self') blocks inline scripts.
const script = readFileSync(new URL("../public/theme.js", import.meta.url), "utf8");

/** Runs index.html's first-paint script against a fake page; returns the data-theme it leaves and a way to flip the system theme. */
function run(opts: { stored?: string | null; light: boolean; storageThrows?: boolean }) {
  const attrs: Record<string, string> = {};
  const listeners: (() => void)[] = [];
  const mq = {
    matches: opts.light,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  const window = {
    matchMedia: () => mq,
    localStorage: {
      getItem: (k: string) => {
        if (opts.storageThrows) throw new Error("blocked");
        return k === "octo.theme" ? (opts.stored ?? null) : null;
      },
    },
  };
  const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
  runInNewContext(script, { window, document });
  return {
    theme: () => attrs["data-theme"],
    setSystemLight(v: boolean) {
      mq.matches = v;
      listeners.forEach((fn) => fn());
    },
  };
}

test("first paint: index.html loads the script from a file, no inline script, no hard-coded dark theme, a colour-scheme meta", () => {
  assert.equal(script.length > 0, true);
  assert.equal(html.includes(`<script src="/theme.js"></script>`), true);
  assert.equal(html.includes("<script>"), false);
  assert.equal(/<html[^>]*data-theme/.test(html), false);
  assert.equal(html.includes(`<meta name="color-scheme" content="light dark"`), true);
});

test("first paint: follows the system theme when nothing is stored", () => {
  assert.equal(run({ light: true }).theme(), "light");
  assert.equal(run({ light: false }).theme(), "dark");
  assert.equal(run({ light: true, stored: "system" }).theme(), "light");
  assert.equal(run({ light: true, stored: "garbage" }).theme(), "light");
});

test("first paint: a stored light or dark choice wins over the system", () => {
  assert.equal(run({ light: true, stored: "dark" }).theme(), "dark");
  assert.equal(run({ light: true, stored: "cursor" }).theme(), "cursor");
  assert.equal(run({ light: true, stored: "claude" }).theme(), "claude");
  assert.equal(run({ light: true, stored: "codex" }).theme(), "codex");
  assert.equal(run({ light: true, stored: "opencode" }).theme(), "opencode");
  assert.equal(run({ light: false, stored: "light" }).theme(), "light");
});

test("first paint: blocked storage falls back to the system theme", () => {
  assert.equal(run({ light: true, storageThrows: true }).theme(), "light");
});

test("first paint: follows later system changes unless a choice is stored", () => {
  const free = run({ light: false });
  free.setSystemLight(true);
  assert.equal(free.theme(), "light");
  const pinned = run({ light: false, stored: "dark" });
  pinned.setSystemLight(true);
  assert.equal(pinned.theme(), "dark");
});
