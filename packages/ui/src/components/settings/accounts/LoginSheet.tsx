import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AgentLoginSession, AgentLoginState, Provider } from "@octo/agent-client";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { findUrls } from "../../../lib/findUrls";
import { cn } from "../../../lib/cn";
import { CONTROL } from "../../../lib/controls";
import { errorMessage, structuredError } from "../../../lib/format";
import { useCopy } from "../../../lib/hooksMore";
import { monoFont } from "../../../lib/monoFont";
import { refreshProviders } from "../../../lib/providers";
import { estimateGrid, measureCell, XTERM_SCROLLBAR } from "../../../lib/terminal/grid";
import { readXtermTheme } from "../../../lib/terminal/xtermTheme";
import { useApp } from "../../../state/app";
import { Button } from "../../primitives/Button";
import { CommandLine } from "../../primitives/CommandLine";
import { Dialog } from "../../primitives/Dialog";
import { Glyph } from "../../primitives/Glyph";
import { Notice } from "../../primitives/Notice";
import { ErrorNotice } from "../../shared/ErrorNotice";

const FONT_SIZE = 13;
const LINE_HEIGHT = 1.35;
/** How much of the output is kept to look for a link (a login prints a few lines). */
const KEEP_CHARS = 20_000;

type Phase = { kind: "starting" } | { kind: "running" } | { kind: "exited" } | { kind: "failed"; error: unknown };

/**
 * The login sheet (design 2026-11-26 section 6): the agent's own login command runs in a terminal of this sheet
 * (`startAgentLogin`), so a link, a one-time code or a "paste the code here" prompt needs no parsing per agent. The newest
 * link in the output gets "Open in browser" and "Copy link"; the login state the harness reads when the command ends shows
 * under the terminal; on `ok` a success line stays with a Done button (the sheet never closes by itself). The fallback command is always shown beneath,
 * and is the whole answer when the terminal cannot be opened (an older harness, a CLI that is not installed).
 */
export function LoginSheet(props: { provider: Provider; method?: string | undefined; onClose(): void }) {
  const { provider, method, onClose } = props;
  const { bridge } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  // What the started session runs (it knows the chosen method); until then, and when it cannot start, the agent's own command.
  const [sessionCommand, setSessionCommand] = useState<string | null>(null);
  const command = sessionCommand ?? provider.login_command ?? "";
  const [link, setLink] = useState<string | null>(null);
  const [state, setState] = useState<AgentLoginState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, copy] = useCopy();
  // The last login state Settings was refreshed for: a check that says something new refreshes it (a slow login's
  // early "not_logged_in" must not stop the later "ok" from refreshing).
  const refreshedFor = useRef<AgentLoginState | null>(null);

  const refreshFor = useCallback(
    (next: AgentLoginState) => {
      if (refreshedFor.current === next) return;
      refreshedFor.current = next;
      void refreshProviders(bridge).catch(() => undefined);
    },
    [bridge],
  );

  useEffect(() => {
    const container = host.current;
    const start = bridge.startAgentLogin;
    if (!start || !container) return;
    refreshedFor.current = null;
    setSessionCommand(null);
    let alive = true;
    let session: AgentLoginSession | null = null;
    let term: Terminal | null = null;
    const cleanups: (() => void)[] = [];

    const font = monoFont();
    const cell = measureCell(font, FONT_SIZE, LINE_HEIGHT);
    const estimate = cell
      ? estimateGrid({
          width: container.clientWidth,
          height: container.clientHeight,
          cellWidth: cell.width,
          cellHeight: cell.height,
          scrollbar: XTERM_SCROLLBAR,
        })
      : null;
    const cols = estimate?.cols ?? 80;
    const rows = estimate?.rows ?? 16;

    const build = (s: AgentLoginSession) => {
      const t = new Terminal({
        cursorBlink: true,
        fontFamily: font,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        scrollback: 2000,
        theme: readXtermTheme(),
        cols,
        rows,
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(container);
      term = t;
      try {
        fit.fit();
        if (t.cols !== cols || t.rows !== rows) void s.resize(t.cols, t.rows).catch(() => undefined);
      } catch {
        // The box has no size yet; the observer fits it on the next frame.
      }
      const decoder = new TextDecoder();
      let text = "";
      cleanups.push(
        s.onOutput((chunk) => {
          t.write(chunk);
          text = (text + decoder.decode(chunk, { stream: true })).slice(-KEEP_CHARS);
          const urls = findUrls(text);
          const newest = urls[urls.length - 1] ?? null;
          setLink((prev) => (prev === newest ? prev : newest));
        }),
      );
      const typed = t.onData((data) => void s.write(data).catch(() => undefined));
      cleanups.push(() => typed.dispose());
      let raf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (!container.isConnected || container.clientWidth < 24 || container.clientHeight < 24) return;
          try {
            fit.fit();
            void s.resize(t.cols, t.rows).catch(() => undefined);
          } catch {
            // A transient fit error while hidden.
          }
        });
      });
      ro.observe(container);
      cleanups.push(() => {
        cancelAnimationFrame(raf);
        ro.disconnect();
      });
      t.focus();
    };

    void start(provider.id, { ...(method ? { method } : {}), cols, rows }).then(
      (s) => {
        if (!alive) {
          void s.close().catch(() => undefined);
          return;
        }
        session = s;
        if (s.command) setSessionCommand(s.command);
        setPhase({ kind: "running" });
        build(s);
        cleanups.push(s.onExit(() => setPhase((p) => (p.kind === "running" ? { kind: "exited" } : p))));
        cleanups.push(
          s.onLogin((next) => {
            setState(next);
            refreshFor(next);
          }),
        );
      },
      (error: unknown) => {
        if (alive) setPhase({ kind: "failed", error });
      },
    );

    return () => {
      alive = false;
      for (const c of cleanups) c();
      term?.dispose();
      void session?.close().catch(() => undefined);
    };
  }, [bridge, provider.id, method, attempt, refreshFor]);

  const again = () => {
    setPhase({ kind: "starting" });
    setState(null);
    setLink(null);
    setAttempt((n) => n + 1);
  };
  // No login method on the bridge (an older harness, a host that cannot open one): the same notice as a failed start.
  const unavailable = !bridge.startAgentLogin;
  const failed = phase.kind === "failed" ? phase.error : undefined;
  const fields = failed !== undefined && failed !== null ? structuredError(failed) : null;
  const cannot = unavailable || phase.kind === "failed";
  const name = provider.label;

  return (
    <Dialog
      title={`Log in to ${name}`}
      {...(cannot ? {} : { description: "Follow the steps below. Open the link in your browser, then paste any code the agent asks for into the terminal." })}
      width="lg"
      onClose={onClose}
      footer={
        <>
          {phase.kind !== "starting" && state !== "ok" && bridge.startAgentLogin && (
            <Button variant="quiet" onClick={again}>
              {cannot ? "Try again" : "Start again"}
            </Button>
          )}
          <Button variant={state === "ok" ? "primary" : "secondary"} onClick={onClose}>
            {state === "ok" ? "Done" : "Close"}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {cannot && (
          <ErrorNotice
            fields={
              fields ?? {
                message: failed
                  ? `Octo could not open the login for ${name}: ${errorMessage(failed)}`
                  : `This version of Octo's local service cannot open a login for ${name}.`,
                hint: "Run the command below in a terminal, then check again.",
              }
            }
            data="login-failed"
          />
        )}
        <div className={cn("octo-code-surface min-w-0 overflow-hidden rounded-md", cannot && "hidden")}>
          <div ref={host} data-audit-ignore data-login-terminal className="h-64 w-full p-2" />
        </div>
        {link && !cannot && state !== "ok" && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(
                "touch-hit inline-flex press items-center gap-1.5 rounded-sm border border-line-strong px-3 text-sm text-fg hover:bg-hover",
                CONTROL.sm.h,
              )}
            >
              <Glyph icon={ExternalLink} size={14} />
              Open in browser
            </a>
            <Button variant="quiet" size="sm" icon={copied ? Check : Copy} onClick={() => copy(link)}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            <span className="min-w-0 flex-1 truncate text-xs text-fg-3" title={link}>
              {link}
            </span>
          </div>
        )}
        {state === "ok" && <Notice tone="success">Logged in to {name}.</Notice>}
        {state === "not_logged_in" && phase.kind === "exited" && (
          <Notice tone="warn">Octo still sees {name} as logged out. Finish the steps in the terminal, or start again.</Notice>
        )}
        {state === "unchecked" && (
          <Notice tone="info">Octo cannot check this login. If you finished the steps, close this and send a request to try it.</Notice>
        )}
        {phase.kind === "exited" && state === null && <Notice tone="info">The login command ended. Octo is checking the result…</Notice>}
        {command && (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs text-fg-3">Or run this in a terminal yourself, then press Check again:</p>
            <CommandLine command={command} label="login command" />
          </div>
        )}
      </div>
    </Dialog>
  );
}
