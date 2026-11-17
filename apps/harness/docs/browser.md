# Browser tab and Design Mode (`browserproxy`)

Code: `internal/browserproxy` (ephemeral loopback proxy manager, reverse proxy handler, HTML/CSS/header rewriter, embedded `inspector.js`), `internal/bridge/browser.go` (HTTP routes), `internal/remoteaccess/rules.go` (remote block). Client types and methods: `@octo/agent-client` (`BrowserProxySession`, `openBrowserProxy`, `closeBrowserProxy`). UI: `packages/ui/src/components/browser/`, `packages/ui/src/lib/browser/`, `packages/ui/src/state/{browserTabs,designNotes}.ts`.

## Overview

The Browser tab renders a project's local web preview (`localhost` / `127.0.0.1`) or an external `http(s)` page inside an `<iframe>` and provides an interactive **Design Mode** overlay (element picking, React/Vue/Svelte component attribution, inline text editing, live CSS property inspection, freehand/shape/arrow markup, numbered batch pins, cropped PNG screenshots, and staging into the session composer).

To inspect cross-origin pages without colliding with the harness's own origin or upstream frame restrictions, `internal/browserproxy` opens an ephemeral `127.0.0.1:0` listener per `(project_id, upstream_origin)` pair, authorizes iframe subresources via a per-session HttpOnly cookie or post-bootstrap same-proxy iframe requests (`pendingNavs` 15s TTL for cross-site top-level loads while rejecting foreign `Origin` or unsolicited `Sec-Fetch-Site: cross-site`), strips frame/isolation blockers (`X-Frame-Options`, `Content-Security-Policy-Report-Only`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy`), rewrites `Content-Security-Policy` (`frame-ancestors`, `upgrade-insecure-requests`, `block-all-mixed-content`, and `'strict-dynamic'` stripped; `script-src`, `style-src`, and `img-src` widened when `default-src` or those directives are present so `inspector.js` Shadow DOM, live inline styles, and `2×` SVG `data:` crops work cleanly), rewrites upstream origin URLs (and `ws://`/`wss://` URLs) to the proxy origin, and injects `inspector.js` before `</head>` (or `</body>`) stamped with a random per-session `nonce`. The dial-time guard tries all resolved safe IPs sequentially so dual-stack `localhost` (`::1` and `127.0.0.1`) connects reliably even when an upstream dev server listens on only IPv4 or IPv6.

No autonomous browser-driving tool (headless navigation, form clicking, or cookie reading) is exposed to the orchestrator, sub-agents, or the MCP server. Agents only receive structured `octo-design` notes and cropped PNG attachments when the person explicitly sends or stages them.

## Security and isolation rules (tested)

1. **Loopback-only listener.** Every proxy instance binds `127.0.0.1:0` (never `0.0.0.0`).
2. **Forbidden schemes and ports.** Only `http:` and `https:` URLs are accepted (`400 invalid_url` otherwise). Targets pointing to the harness bridge port, any active browser-proxy listener port, or link-local metadata endpoints (`169.254.0.0/16`, `fe80::/10`) are rejected (`403 forbidden_target`) both at `Open` validation time and inside the dial-time `net.Dialer` guard (preventing DNS-rebinding or HTTP redirect escapes to blocked ports).
3. **Origin isolation.** The proxy runs on its own ephemeral loopback port rather than under the harness bridge origin, so scripts inside the previewed page cannot read the UI's `localStorage` or reach the bridge without CORS.
4. **Per-session `postMessage` nonce.** Every `Open` generates a 16-byte hex `nonce` embedded in `<script id="__octo_inspector__" data-octo-nonce="…">`. Both `inspector.js` and the UI's `useInspectorBridge` drop any `postMessage` frame whose `nonce` does not match.
5. **Blocked over Remote Access.** `internal/remoteaccess/rules.go` blocks `/v1/projects/{pid}/browser` and `/v1/projects/{pid}/browser/*` on the remote listener (`403 remote_forbidden`) so a paired remote device cannot open arbitrary loopback proxies on the host machine.
6. **Idle reaping and shutdown.** Unused proxy listeners close after 30 minutes of inactivity (`IdleTimeout`), when `DELETE /v1/projects/{pid}/browser/proxy` is called, or when `harness serve` shuts down.

## API

All routes hang under `/v1/projects/{pid}` on the local bridge listener. Errors follow `{ "error": { "code", "message" } }`.

| Method | Path | Body → response |
| --- | --- | --- |
| `POST` | `/v1/projects/{pid}/browser/proxy` | `{ "url": "http://localhost:5173/" }` → `200` `BrowserProxySession` (`{ frame_url, proxy_origin, target_url, nonce }`); `400 invalid_url`; `403 forbidden_target`; `404 not_found` |
| `DELETE` | `/v1/projects/{pid}/browser/proxy` | `204 No Content` (closes all proxy listeners owned by `{pid}`) |

Re-opening the same `(project_id, origin)` reuses the running listener and refreshes its idle timer while returning the requested path/query in `frame_url`.

## Rewriting and WebSocket pass-through

- **HTML (`text/html`)**: strips `Accept-Encoding` on outbound requests so `http.Transport` transparently negotiates and gunzips `gzip` (skipping rewrites if any non-plain `Content-Encoding` remains), restores oversized (`> 8 MiB`) HTML streams cleanly via `io.MultiReader`, rewrites upstream origin and `ws://`/`wss://` references to the proxy origin, and injects `<script id="__octo_inspector__" data-octo-nonce="…">…</script>` once per document.
- **CSS / JS / JSON (`text/css`, `application/javascript`, `text/javascript`, `application/x-javascript`, `application/json`)**: rewrites literal upstream origin URLs (including `ws://`/`wss://` host references) so Vite/Next/Webpack client bundles talk to the proxy origin.
- **Redirects (`Location`) and cookies (`Set-Cookie`)**: rewrites `Location` headers on the upstream origin back to the proxy origin, strips `Domain=` and `Secure` attributes on `Set-Cookie`, and normalises `SameSite=None` to `Lax` over plain `http://127.0.0.1`.
- **WebSockets (`Upgrade: websocket`)**: reverse-proxied directly by `httputil.ReverseProxy` so HMR (Vite, Next.js, Webpack) stays live inside the Browser tab.

## `octo-design` wire block

When the person sends design notes from `NoteCard`, `Send (N)` (batch pins), or the Chat composer's `N design notes` pill, `@octo/ui` uploads each note's cropped PNG (with drawn markup composited on top) via `POST /v1/projects/{pid}/attachments` and appends a fenced `octo-design` JSONL block to the user message:

````text
Please tighten the hero button padding.

```octo-design
{"v":1,"url":"http://localhost:5173/","viewport":{"w":1280,"h":800},"elements":[{"selector":"#primary-cta","tag":"button","text":"Start free trial","component":{"name":"HeroBanner","file":"src/components/HeroBanner.tsx"},"styles":{"padding":"10px 18px","border-radius":"10px"}}],"css":[{"selector":"#primary-cta","prop":"border-radius","from":"10px","to":"999px"}],"note":"Make the primary CTA pill-shaped"}
```
````

In the transcript (`Transcript.tsx`), `splitDesignNotes` strips the `octo-design` fence from the displayed prose and renders `SentDesignNotes` cards alongside the attached cropped screenshots (`PromptImages`), mirroring how `octo-comments` renders inline code review comments.
