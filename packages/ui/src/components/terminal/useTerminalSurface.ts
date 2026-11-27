import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type RefObject, useEffect, useRef } from "react";
import type { Bridge } from "@octo/agent-client";
import { monoFont } from "../../lib/monoFont";
import { estimateGrid, measureCell, XTERM_SCROLLBAR } from "../../lib/terminal/grid";
import type { ManagedTerminal } from "./sessionStore";
import { readXtermTheme } from "../../lib/terminal/xtermTheme";

const FONT_SIZE = 13;
const LINE_HEIGHT = 1.35;

/**
 * The xterm surface of a terminal tab, built once per mount. The tab's frame and bar paint first: opening the tab is a
 * click, and React runs the effects of a click's render before the browser paints, so building xterm here (its `open`
 * measures the font and lays out the page, ~30 ms at 1x and ~115 ms at 4x CPU) held the whole tab back. The shell is asked
 * for at once, sized from the box, and xterm is built in the task after the first paint; the screen's box is laid out by
 * the tab, so the surface appears in place.
 */
export function useTerminalSurface(opts: {
  hostRef: RefObject<HTMLDivElement | null>;
  entry: ManagedTerminal;
  bridge: Bridge;
  enabled: boolean;
  defaultFolder: string;
}): RefObject<Terminal | null> {
  const { hostRef, entry, bridge, enabled, defaultFolder } = opts;
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const container = hostRef.current;
    if (!container) return;
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
    entry.start(bridge, estimate?.cols ?? 80, estimate?.rows ?? 24);

    let dispose: (() => void) | null = null;
    const build = () => {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: font,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        scrollback: 5000,
        convertEol: false,
        theme: readXtermTheme(),
        ...(estimate ?? {}),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      termRef.current = term;

      try {
        fit.fit();
        const started = estimate ?? { cols: 80, rows: 24 };
        if (term.cols !== started.cols || term.rows !== started.rows) entry.resize(term.cols, term.rows);
      } catch {
        // Container may have 0x0 size before layout settles; ResizeObserver will fit next frame.
      }

      for (const chunk of entry.history()) {
        term.write(chunk);
      }
      const unsubOutput = entry.onOutput((chunk) => {
        term.write(chunk);
      });

      const dataSub = term.onData((data) => {
        const cur = entry.snapshot();
        if (cur.status === "exited" && (data === "\r" || data === "\n")) {
          term.reset();
          entry.clearHistory();
          entry.start(bridge, term.cols || 80, term.rows || 24, cur.folder || defaultFolder);
          return;
        }
        entry.write(data);
      });

      let raf = 0;
      const syncSize = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (!container.isConnected || container.clientWidth < 24 || container.clientHeight < 24) return;
          try {
            fit.fit();
            entry.resize(term.cols, term.rows);
          } catch {
            // Ignore transient fit errors while hidden.
          }
        });
      };
      const ro = new ResizeObserver(syncSize);
      ro.observe(container);

      const mo = new MutationObserver(() => {
        term.options.theme = readXtermTheme();
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });

      if (container.offsetParent !== null) term.focus();

      dispose = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        mo.disconnect();
        dataSub.dispose();
        unsubOutput();
        termRef.current = null;
        term.dispose();
      };
    };

    // After the frame that shows the tab: a timeout queued from that frame's animation callback runs once it has painted.
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(build, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      dispose?.();
    };
  }, [bridge, defaultFolder, enabled, entry, hostRef]);

  return termRef;
}
