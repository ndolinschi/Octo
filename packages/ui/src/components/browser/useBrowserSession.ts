import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  formatDesignNotes,
  normalizeBrowserUrl,
  type CssEdit,
  type DesignNote,
  type MarkupStroke,
  type PickedElement,
  type Rect,
} from "../../lib/browser/designNotes";
import { extractLocalUrls } from "../../lib/commands/urls";
import { errorMessage } from "../../lib/format";
import { runningRuns } from "../../lib/projectRuns";
import { useApp } from "../../state/app";
import { setBrowserTabPins, updateBrowserTabState, useBrowserTabState } from "../../state/browserTabs";
import { stageDesignNotes } from "../../state/designNotes";
import { useProject } from "../../state/project";
import { useRunsSelector } from "../../state/projectRuns";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { DesignTool } from "./DesignHintBar";
import { boundsOfStrokes } from "./MarkupCanvas";
import type { NoteDraft } from "./NoteCard";
import { useInspectorBridge, type InspectorEvent, type InspectorPin } from "./useInspectorBridge";

let noteSeq = 0;
const nextNoteId = () => `dn_${Date.now().toString(36)}_${(noteSeq += 1)}`;

const EMPTY_FRAME = { src: null, srcdoc: null, nonce: "", proxyOrigin: null, error: null } as const;

/**
 * Behaviour hook for `BrowserTab`: manages loopback proxy or demo `srcdoc` loading, Design Mode state,
 * `useInspectorBridge` events, live CSS/text revert, staging to Chat, and batch sending.
 */
export function useBrowserSession(browserId: string, stageRef: RefObject<HTMLElement | null>, iframeRef: RefObject<HTMLIFrameElement | null>) {
  const { bridge } = useApp();
  const { projectId, state, parallel, send, sendIn } = useProject();
  const ws = useOptionalWorkspace();
  const focusedSessionId = ws?.focusedSessionId;
  const tabState = useBrowserTabState(projectId, browserId);

  const localUrlsKey = useRunsSelector((s) => {
    const urls = new Set<string>();
    for (const run of runningRuns(s)) {
      const view = s.byId[run.id];
      if (view) for (const u of extractLocalUrls(view.output)) urls.add(u);
    }
    for (const id of s.order) {
      const view = s.byId[id];
      if (view) for (const u of extractLocalUrls(view.output)) urls.add(u);
    }
    return [...urls].slice(0, 4).join("\n");
  });
  const detectedUrls = useMemo(() => (localUrlsKey ? localUrlsKey.split("\n").filter(Boolean) : []), [localUrlsKey]);

  const [loadedFrame, setLoadedFrame] = useState<{
    forUrl: string;
    src: string | null;
    srcdoc: string | null;
    nonce: string;
    proxyOrigin: string | null;
    error: string | null;
  } | null>(null);
  const frame = tabState.url && loadedFrame?.forUrl === tabState.url ? loadedFrame : EMPTY_FRAME;

  const [reloadTick, setReloadTick] = useState(0);
  const [designMode, setDesignMode] = useState(false);
  const [tool, setTool] = useState<DesignTool>("select");
  const [strokes, setStrokes] = useState<MarkupStroke[]>([]);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [pendingNotes, setPendingNotes] = useState<DesignNote[]>([]);
  const [sending, setSending] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const captureCropRef = useRef<((rect: Rect, strokes?: readonly MarkupStroke[]) => Promise<Uint8Array | undefined>) | null>(null);

  useEffect(() => {
    setBrowserTabPins(projectId, browserId, pendingNotes.length);
    return () => setBrowserTabPins(projectId, browserId, 0);
  }, [projectId, browserId, pendingNotes.length]);

  useEffect(() => {
    const target = tabState.url;
    if (!target) return;
    let alive = true;
    if (bridge.openBrowserProxy) {
      bridge
        .openBrowserProxy(projectId, target)
        .then((session) => {
          if (!alive) return;
          setLoadedFrame({
            forUrl: target,
            src: session.frame_url,
            srcdoc: null,
            nonce: session.nonce,
            proxyOrigin: session.proxy_origin,
            error: null,
          });
        })
        .catch((err: unknown) => {
          if (!alive) return;
          // Error surfaces in the Notice banner above the preview frame.
          setLoadedFrame({ forUrl: target, src: target, srcdoc: null, nonce: "", proxyOrigin: null, error: errorMessage(err) });
        });
    } else {
      const localNonce = `demo_${browserId}_${reloadTick}`;
      void import("../../lib/browser/demoPage").then(({ buildDemoBrowserSrcdoc }) => {
        if (!alive) return;
        setLoadedFrame({
          forUrl: target,
          src: null,
          srcdoc: buildDemoBrowserSrcdoc(target, localNonce),
          nonce: localNonce,
          proxyOrigin: null,
          error: null,
        });
      });
    }
    return () => {
      alive = false;
    };
  }, [bridge, projectId, browserId, tabState.url, reloadTick]);

  const buildNote = useCallback(
    async (base: {
      id: string;
      elements: PickedElement[];
      area?: Rect | undefined;
      cssEdits?: CssEdit[] | undefined;
      textEdit?: DesignNote["textEdit"];
      text: string;
      captureRect?: Rect | undefined;
      strokes?: readonly MarkupStroke[] | undefined;
    }): Promise<DesignNote> => {
      const cropTarget = base.captureRect ?? base.area ?? base.elements[0]?.rect;
      const pngBytes = cropTarget && captureCropRef.current ? await captureCropRef.current(cropTarget, base.strokes) : undefined;
      return {
        id: base.id,
        url: tabState.url,
        elements: base.elements,
        ...(base.area ? { area: base.area } : {}),
        ...(base.strokes?.length ? { strokes: [...base.strokes] } : {}),
        ...(base.cssEdits?.length ? { cssEdits: [...base.cssEdits] } : {}),
        ...(base.textEdit ? { textEdit: base.textEdit } : {}),
        text: base.text,
        ...(pngBytes ? { pngBytes } : {}),
        created: Date.now(),
      };
    },
    [tabState.url],
  );

  const sendNotesNow = useCallback(
    async (notes: readonly DesignNote[]) => {
      if (!notes.length) return;
      setSending(true);
      setSendError(null);
      try {
        const attachments: string[] = [];
        if (bridge.uploadAttachment) {
          for (const [idx, n] of notes.entries()) {
            if (!n.pngBytes) continue;
            try {
              const up = await bridge.uploadAttachment(projectId, n.pngBytes, { name: `design-note-${idx + 1}.png` });
              attachments.push(up.id);
            } catch {
              // Structured DOM/CSS note still delivers if screenshot upload is unsupported.
            }
          }
        }
        const block = formatDesignNotes(notes);
        const opts = attachments.length ? { attachments } : undefined;
        const targetSid = focusedSessionId ?? state.sessions.defaultId;
        if (parallel && targetSid) await sendIn(targetSid, block, opts);
        else await send(block, opts);
      } catch (err: unknown) {
        setSendError(errorMessage(err));
        throw err;
      } finally {
        setSending(false);
      }
    },
    [bridge, projectId, focusedSessionId, state.sessions.defaultId, parallel, sendIn, send],
  );

  const onInspectorEvent = useCallback(
    (ev: InspectorEvent) => {
      if (ev.type === "ready" || ev.type === "nav") {
        const patch: { url?: string; title?: string } = {};
        if (ev.url.startsWith("http")) patch.url = ev.url;
        if (ev.title) patch.title = ev.title;
        if (patch.url || patch.title) updateBrowserTabState(projectId, browserId, patch);
        return;
      }
      if (ev.type === "shortcut") {
        if (ev.key === "toggleDesign") setDesignMode((v) => !v);
        else if (ev.key === "undo") setStrokes((s) => s.slice(0, -1));
        else {
          setDraft((curDraft) => {
            if (curDraft) return null;
            setStrokes((curStrokes) => {
              if (curStrokes.length > 0) return [];
              setDesignMode(false);
              return curStrokes;
            });
            return null;
          });
        }
        return;
      }
      if (ev.type === "pick") {
        if (ev.altKey) {
          void buildNote({ id: nextNoteId(), elements: [ev.element], text: "", captureRect: ev.clientRect }).then((n) => stageDesignNotes(projectId, [n]));
          return;
        }
        setDraft((prev) => {
          if (ev.shiftKey && prev) {
            const exists = prev.elements.some((x) => x.selector === ev.element.selector);
            const nextEls = exists ? prev.elements.filter((x) => x.selector !== ev.element.selector) : [...prev.elements, ev.element];
            return nextEls.length ? { ...prev, elements: nextEls, anchor: ev.clientRect } : null;
          }
          return { id: nextNoteId(), anchor: ev.clientRect, elements: [ev.element], cssEdits: [], text: "" };
        });
        return;
      }
      if (ev.type === "textEditSaved") {
        const textEdit = { selector: ev.element.selector, before: ev.before, after: ev.after };
        if (ev.stageToChat) {
          void buildNote({
            id: nextNoteId(),
            elements: [ev.element],
            textEdit,
            text: `Change text from "${ev.before}" to "${ev.after}"`,
            captureRect: ev.clientRect,
          }).then((n) => stageDesignNotes(projectId, [n]));
          return;
        }
        setDraft({ id: nextNoteId(), anchor: ev.clientRect, elements: [ev.element], cssEdits: [], textEdit, text: "" });
        return;
      }
      if (ev.type === "pinClick") {
        setPendingNotes((cur) => {
          const hit = cur.find((n) => n.id === ev.noteId);
          if (hit) {
            setDraft({
              id: hit.id,
              anchor: ev.clientRect,
              elements: hit.elements,
              area: hit.area,
              cssEdits: hit.cssEdits ? [...hit.cssEdits] : [],
              textEdit: hit.textEdit,
              text: hit.text,
              existingPin: hit.pinNumber,
            });
          }
          return cur;
        });
      }
    },
    [projectId, browserId, buildNote],
  );

  const pins = useMemo<InspectorPin[]>(
    () => pendingNotes.map((n, idx) => ({ id: n.id, number: idx + 1, selector: n.elements[0]?.selector, pageRect: n.elements[0]?.pageRect ?? n.area })),
    [pendingNotes],
  );
  const selectedSelectors = useMemo(() => (draft ? draft.elements.map((e) => e.selector) : []), [draft]);

  const inspector = useInspectorBridge({
    iframeRef,
    nonce: frame.nonce,
    designMode,
    interactivePick: designMode && tool === "select",
    selectedSelectors,
    pins,
    onEvent: onInspectorEvent,
  });

  useEffect(() => {
    captureCropRef.current = inspector.captureCrop;
  }, [inspector.captureCrop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const stage = stageRef.current;
      if (!stage || stage.offsetParent === null) return;
      const active = document.activeElement;
      const inGroup = active === null || active === document.body || Boolean(stage.closest("[data-dock-group]")?.contains(active));
      if (!inGroup) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDesignMode((v) => !v);
      } else if (
        designMode &&
        mod &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z" &&
        (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) || active.value === "")
      ) {
        e.preventDefault();
        setStrokes((s) => s.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [designMode, stageRef]);

  const goUrl = useCallback(
    (raw: string): boolean => {
      const normalized = normalizeBrowserUrl(raw);
      if (!normalized) return false;
      setDraft(null);
      setStrokes([]);
      updateBrowserTabState(projectId, browserId, { url: normalized, title: "" });
      return true;
    },
    [projectId, browserId],
  );

  const commitDraft = async (mode: "submit" | "stage") => {
    if (!draft || committing) return;
    setCommitting(true);
    try {
      const strokeBounds = boundsOfStrokes(strokes);
      const note = await buildNote({
        id: draft.id,
        elements: draft.elements,
        area: draft.area ?? strokeBounds,
        cssEdits: draft.cssEdits,
        textEdit: draft.textEdit,
        text: draft.text,
        captureRect: draft.area ?? strokeBounds ?? draft.elements[0]?.rect ?? draft.anchor,
        strokes,
      });
      if (mode === "stage") {
        stageDesignNotes(projectId, [note]);
        setDraft(null);
        setStrokes([]);
        return;
      }
      if (tabState.batchEdits) {
        setPendingNotes((prev) => {
          const idx = prev.findIndex((p) => p.id === note.id);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = { ...note, pinNumber: idx + 1 };
            return copy;
          }
          return [...prev, { ...note, pinNumber: prev.length + 1 }];
        });
        setDraft(null);
        setStrokes([]);
        return;
      }
      await sendNotesNow([note]);
      setDraft(null);
      setStrokes([]);
    } finally {
      setCommitting(false);
    }
  };

  return {
    projectId,
    ws,
    tabState,
    detectedUrls,
    frame,
    reloadTick,
    reload: () => {
      inspector.navigate("reload");
      setReloadTick((n) => n + 1);
    },
    navigate: inspector.navigate,
    applyCss: inspector.applyCss,
    revertCss: inspector.revertCss,
    revertText: inspector.revertText,
    designMode,
    setDesignMode,
    tool,
    setTool,
    strokes,
    setStrokes,
    draft,
    setDraft,
    pendingNotes,
    setPendingNotes,
    sending,
    committing,
    sendError,
    goUrl,
    commitDraft,
    sendNotesNow,
    openAreaDraft: (rect: Rect) => setDraft({ id: nextNoteId(), anchor: rect, elements: [], area: rect, cssEdits: [], text: "" }),
  };
}
