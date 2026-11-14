import { useEffect, useRef } from "react";
import { useLatest } from "./hooks";

/**
 * Phone layout (direction 7): sheets, panels and the navigation are history entries, so the system Back (Android's button, the
 * iOS edge swipe, the browser's Back) closes them in order. Each open layer pushes one entry with the same URL and a token in
 * `history.state`; Back pops it and the layer closes; closing a layer from the UI goes back over its entry.
 *
 * - A navigation while layers are open (a session picked in the navigation) leaves their entries behind: they are "stale".
 *   Back onto a stale entry skips it (one more step back), so one press of Back always does one visible thing. Forward onto a
 *   stale entry would also skip back (rare on phones; noted in the spec's "As built").
 * - History moves are asynchronous: a layer opened while a close is still travelling is pushed once that move arrives.
 */
export type HistoryEnv = {
  push(token: string): void;
  go(delta: number): void;
  /** The token of the current entry, or null. */
  token(): string | null;
};

type Layer = { token: string; onPop(): void; pushed: boolean; dead: boolean };

export type LayerStack = {
  open(onPop: () => void): string;
  /**
   * Closes the layer from the UI. The top layer goes back over its entry (and over the entries of closed layers right under
   * it); a layer with an open one above it (a sheet that opened a panel as it closed) only dies: its entry is skipped later.
   */
  close(token: string): void;
  /** The current entry changed (popstate). */
  sync(): void;
  depth(): number;
};

export function createLayerStack(env: HistoryEnv): LayerStack {
  const stack: Layer[] = [];
  let travelling = 0;
  let n = 0;
  const flush = () => {
    for (const l of stack) {
      if (l.pushed || l.dead) continue;
      l.pushed = true;
      env.push(l.token);
    }
  };
  return {
    open(onPop) {
      n += 1;
      const layer: Layer = { token: `L${Date.now().toString(36)}-${n}`, onPop, pushed: false, dead: false };
      stack.push(layer);
      if (travelling === 0) flush();
      return layer.token;
    },
    close(token) {
      let at = stack.findIndex((l) => l.token === token && !l.dead);
      if (at < 0) return;
      const layer = stack[at];
      if (!layer) return;
      if (stack.slice(at + 1).some((l) => !l.dead)) {
        layer.dead = true;
        return;
      }
      while (at > 0 && stack[at - 1]?.dead) at -= 1;
      const pushed = stack.splice(at).filter((l) => l.pushed).length;
      if (pushed === 0) return;
      travelling += 1;
      env.go(-pushed);
    },
    sync() {
      if (travelling > 0) {
        travelling -= 1;
        if (travelling === 0) flush();
        return;
      }
      const t = env.token();
      const at = t === null ? -1 : stack.findIndex((l) => l.token === t);
      const stale = t !== null && (at < 0 || stack[at]?.dead === true);
      const gone = stack.splice(stale && at >= 0 ? at : at + 1).filter((l) => l.pushed && !l.dead);
      for (const l of gone.reverse()) l.onPop();
      // An entry of a layer that no longer exists: one more step back (see above).
      if (stale) env.go(-1);
    },
    depth: () => stack.filter((l) => !l.dead).length,
  };
}

const KEY = "octoLayer";

let shared: LayerStack | null = null;

function layers(): LayerStack {
  if (shared) return shared;
  const stack = createLayerStack({
    push: (token) => {
      const s: unknown = window.history.state;
      window.history.pushState(typeof s === "object" && s !== null ? { ...s, [KEY]: token } : { [KEY]: token }, "");
    },
    go: (delta) => window.history.go(delta),
    token: () => {
      const s: unknown = window.history.state;
      const v: unknown = typeof s === "object" && s !== null ? Reflect.get(s, KEY) : null;
      return typeof v === "string" ? v : null;
    },
  });
  window.addEventListener("popstate", () => stack.sync());
  shared = stack;
  return stack;
}

/**
 * While `open`, this layer has a history entry; Back calls `onClose`. Closing it otherwise (`open` turns false) goes back over
 * its entry. A StrictMode re-run of the effect keeps the same entry (the release waits a tick).
 */
export function useHistoryLayer(open: boolean, onClose: () => void): void {
  const close = useLatest(onClose);
  const held = useRef<{ token: string; release: number | null } | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = held.current;
    if (h && h.release !== null) {
      window.clearTimeout(h.release);
      h.release = null;
    } else if (!h) {
      const token = layers().open(() => {
        held.current = null;
        close.current();
      });
      held.current = { token, release: null };
    }
    return () => {
      const cur = held.current;
      if (!cur) return;
      cur.release = window.setTimeout(() => {
        if (held.current !== cur) return;
        held.current = null;
        layers().close(cur.token);
      }, 0);
    };
  }, [open, close]);
}

/** A layer opened outside a component's lifetime (the phone header's panels); see `LayerStack.open`. */
export function openLayer(onPop: () => void): string {
  return layers().open(onPop);
}

export function closeLayer(token: string): void {
  layers().close(token);
}
