import type { WindowChrome } from "@octo/ui";
import { useEffect, useState } from "react";
import { isTauri } from "./bridgeChoice";
import { chromeFor, describeChrome, isDragTarget, macPreview, PREVIEW_MAC_UA, type ChromeDebug } from "./windowChrome";

/**
 * The window frame for `OctoApp`'s `chrome` prop. In a browser it is the default (nothing loaded). In the macOS app it also
 * maps the UI's `data-drag-region` areas to window dragging (press and drag; double-click zooms) and drops the traffic-light
 * inset in full screen. The Tauri window API is imported on demand.
 */
export function useWindowChrome(): WindowChrome {
  const tauri = isTauri(window);
  const [fullscreen, setFullscreen] = useState(false);
  const preview = import.meta.env.DEV ? macPreview(window.location.search) : null;
  const chrome = preview ? chromeFor(true, PREVIEW_MAC_UA, preview === "mac-fullscreen") : chromeFor(tauri, navigator.userAgent, fullscreen);
  const overlay = chrome.overlay;

  useEffect(() => {
    if (!overlay || !tauri) return;
    let live = true;
    let stop: (() => void) | null = null;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const onDown = (e: MouseEvent) => {
        if (e.button !== 0 || !(e.target instanceof Element) || !isDragTarget(e.target)) return;
        if (e.detail === 2) void win.toggleMaximize();
        else if (e.detail === 1) void win.startDragging();
      };
      document.addEventListener("mousedown", onDown);
      const sync = () => void win.isFullscreen().then((f) => live && setFullscreen(f));
      const unlisten = await win.onResized(sync);
      sync();
      stop = () => {
        document.removeEventListener("mousedown", onDown);
        unlisten();
      };
      if (!live) stop();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [overlay, tauri]);

  return chrome;
}

/**
 * `OCTO_DEBUG_CHROME=1` (read by the shell's `chrome_debug` command): logs the configured and effective chrome values to the
 * console and returns the y of the guide line to draw (the row's control centre), else null.
 */
export function useChromeDebug(chrome: WindowChrome): number | null {
  const tauri = isTauri(window);
  const [debug, setDebug] = useState<ChromeDebug | null>(null);
  useEffect(() => {
    if (!tauri) return;
    let live = true;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<ChromeDebug>("chrome_debug"))
      .then((d) => live && d.enabled && setDebug(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tauri]);
  useEffect(() => {
    if (debug) console.info(describeChrome(debug, chrome));
  }, [debug, chrome]);
  return debug ? (chrome.controlsCenterY ?? 20) : null;
}
