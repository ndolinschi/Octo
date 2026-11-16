import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ComponentInfo, CssEdit, MarkupStroke, PickedElement, Rect } from "../../lib/browser/designNotes";
import { useLatest } from "../../lib/hooks";

export type InspectorPin = {
  id: string;
  number: number;
  selector?: string | undefined;
  pageRect?: Rect | undefined;
};

export type InspectorEvent =
  | { type: "ready" | "nav"; url: string; title: string; width: number; height: number }
  | { type: "pick"; element: PickedElement; shiftKey: boolean; altKey: boolean; clientRect: Rect }
  | { type: "pinClick"; noteId: string; clientRect: Rect }
  | { type: "textEditStart"; selector: string }
  | { type: "textEditSaved"; element: PickedElement; before: string; after: string; stageToChat: boolean; clientRect: Rect }
  | { type: "textEditCancelled" }
  | { type: "shortcut"; key: "toggleDesign" | "escape" | "undo" };

const CHANNEL_OUT = "octo-browser";
const CHANNEL_IN = "octo-browser-host";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRect(v: unknown): Rect | null {
  if (!isRecord(v)) return null;
  const { x, y, width, height } = v;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return null;
  return { x, y, width, height };
}

function parseComponent(v: unknown): ComponentInfo | undefined {
  if (!isRecord(v) || typeof v.name !== "string" || !v.name) return undefined;
  const stack = Array.isArray(v.stack) ? v.stack.filter((s): s is string => typeof s === "string") : [v.name];
  return {
    name: v.name,
    stack,
    ...(typeof v.file === "string" && v.file ? { file: v.file } : {}),
    ...(typeof v.line === "number" ? { line: v.line } : {}),
  };
}

function parseElement(v: unknown): PickedElement | null {
  if (!isRecord(v) || typeof v.selector !== "string" || typeof v.tag !== "string") return null;
  const rect = parseRect(v.rect) ?? { x: 0, y: 0, width: 0, height: 0 };
  const pageRect = parseRect(v.pageRect) ?? undefined;
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const attributes: Record<string, string> = {};
  if (isRecord(v.attributes)) {
    for (const [k, val] of Object.entries(v.attributes)) {
      if (typeof val === "string") attributes[k] = val;
    }
  }
  const editableStyles: Record<string, string> = {};
  if (isRecord(v.editableStyles)) {
    for (const [k, val] of Object.entries(v.editableStyles)) {
      if (typeof val === "string") editableStyles[k] = val;
    }
  }
  const stylesRec = isRecord(v.styles) ? v.styles : {};
  const classes = Array.isArray(v.classes) ? v.classes.filter((c): c is string => typeof c === "string") : [];
  const component = parseComponent(v.component);
  return {
    selector: v.selector,
    tag: v.tag,
    id: str(v.id),
    classes,
    attributes,
    text: str(v.text),
    rect,
    ...(pageRect ? { pageRect } : {}),
    styles: {
      color: str(stylesRec.color),
      backgroundColor: str(stylesRec.backgroundColor),
      fontSize: str(stylesRec.fontSize),
      fontFamily: str(stylesRec.fontFamily),
      display: str(stylesRec.display),
      position: str(stylesRec.position),
    },
    editableStyles,
    ...(component ? { component } : {}),
  };
}

let cropSeq = 0;

/**
 * Typed `postMessage` bridge between `BrowserTab` and the injected `inspector.js` inside the iframe.
 */
export function useInspectorBridge(opts: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  nonce: string;
  designMode: boolean;
  interactivePick: boolean;
  selectedSelectors: readonly string[];
  pins: readonly InspectorPin[];
  onEvent(ev: InspectorEvent): void;
}) {
  const { iframeRef, nonce, designMode, interactivePick, selectedSelectors, pins } = opts;
  const onEventRef = useLatest(opts.onEvent);
  const pendingCrops = useRef(new Map<string, (bytes: Uint8Array | undefined) => void>());

  const post = useCallback(
    (payload: Record<string, unknown>) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.postMessage({ channel: CHANNEL_IN, nonce, ...payload }, "*");
      } catch {
        // Cross-origin frame without proxy: postMessage ignored cleanly.
      }
    },
    [iframeRef, nonce],
  );

  const syncState = useCallback(() => {
    post({ type: "setDesignMode", active: designMode, interactivePick });
    post({ type: "setSelected", selectors: [...selectedSelectors] });
    post({ type: "setPins", pins: [...pins] });
  }, [post, designMode, interactivePick, selectedSelectors, pins]);

  useEffect(() => {
    syncState();
  }, [syncState]);

  useEffect(() => {
    const pendingMap = pendingCrops.current;
    const onMessage = (e: MessageEvent<unknown>) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data;
      if (!isRecord(d) || d.channel !== CHANNEL_OUT) return;
      if (nonce && d.nonce !== nonce) return;

      switch (d.type) {
        case "cropResult": {
          if (typeof d.requestId !== "string") return;
          const resolve = pendingMap.get(d.requestId);
          if (resolve) {
            pendingMap.delete(d.requestId);
            resolve(d.pngBytes instanceof ArrayBuffer ? new Uint8Array(d.pngBytes) : undefined);
          }
          return;
        }
        case "ready":
        case "nav": {
          if (d.type === "ready") syncState();
          onEventRef.current({
            type: d.type,
            url: typeof d.url === "string" ? d.url : "",
            title: typeof d.title === "string" ? d.title : "",
            width: typeof d.width === "number" ? d.width : 0,
            height: typeof d.height === "number" ? d.height : 0,
          });
          return;
        }
        case "pick": {
          const element = parseElement(d.element);
          const clientRect = parseRect(d.clientRect);
          if (element && clientRect) {
            onEventRef.current({
              type: "pick",
              element,
              shiftKey: d.shiftKey === true,
              altKey: d.altKey === true,
              clientRect,
            });
          }
          return;
        }
        case "pinClick": {
          const clientRect = parseRect(d.clientRect);
          if (typeof d.noteId === "string" && clientRect) {
            onEventRef.current({ type: "pinClick", noteId: d.noteId, clientRect });
          }
          return;
        }
        case "textEditStart": {
          if (typeof d.selector === "string") onEventRef.current({ type: "textEditStart", selector: d.selector });
          return;
        }
        case "textEditSaved": {
          const element = parseElement(d.element);
          const clientRect = parseRect(d.clientRect);
          if (element && clientRect && typeof d.before === "string" && typeof d.after === "string") {
            onEventRef.current({
              type: "textEditSaved",
              element,
              before: d.before,
              after: d.after,
              stageToChat: d.stageToChat === true,
              clientRect,
            });
          }
          return;
        }
        case "textEditCancelled": {
          onEventRef.current({ type: "textEditCancelled" });
          return;
        }
        case "shortcut": {
          if (d.key === "toggleDesign" || d.key === "escape" || d.key === "undo") {
            onEventRef.current({ type: "shortcut", key: d.key });
          }
          return;
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const resolve of pendingMap.values()) resolve(undefined);
      pendingMap.clear();
    };
  }, [iframeRef, nonce, syncState, onEventRef]);

  const navigate = useCallback((action: "back" | "forward" | "reload") => post({ type: "nav", action }), [post]);
  const applyCss = useCallback((selector: string, property: string, value: string | null) => post({ type: "applyCss", selector, property, value }), [post]);
  const revertCss = useCallback((edits: readonly CssEdit[]) => post({ type: "revertCss", edits }), [post]);
  const revertText = useCallback((selector: string, originalText: string) => post({ type: "revertText", selector, originalText }), [post]);

  const captureCrop = useCallback(
    (rect: Rect, strokes?: readonly MarkupStroke[]): Promise<Uint8Array | undefined> => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return Promise.resolve(undefined);
      const requestId = `crop_${(cropSeq += 1)}`;
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          pendingCrops.current.delete(requestId);
          resolve(undefined);
        }, 1200);
        pendingCrops.current.set(requestId, (bytes) => {
          window.clearTimeout(timer);
          resolve(bytes);
        });
        post({ type: "captureCrop", requestId, rect, strokes: strokes ?? [] });
      });
    },
    [iframeRef, post],
  );

  return { navigate, applyCss, revertCss, revertText, captureCrop };
}
