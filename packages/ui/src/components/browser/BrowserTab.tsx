import { useRef } from "react";
import { cn } from "../../lib/cn";
import { updateBrowserTabState, type BrowserViewport } from "../../state/browserTabs";
import type { TabId } from "../../state/workspace/layout";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Notice } from "../primitives/Notice";
import { BrowserToolbar } from "./BrowserToolbar";
import { DesignHintBar } from "./DesignHintBar";
import { boundsOfStrokes, MarkupCanvas } from "./MarkupCanvas";
import { NoteCard } from "./NoteCard";
import { useBrowserSession } from "./useBrowserSession";

const VIEWPORT_WIDTH: Record<BrowserViewport, number | null> = {
  full: null,
  desktop: 1280,
  tablet: 768,
  mobile: 390,
};

export default function BrowserTab(props: { tab: TabId; browserId: string }) {
  const stageRef = useRef<HTMLElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const s = useBrowserSession(props.browserId, stageRef, iframeRef);
  const vpWidth = VIEWPORT_WIDTH[s.tabState.viewport];

  return (
    <section ref={stageRef} aria-label="Browser" data-browser-tab className="flex min-h-0 flex-1 flex-col bg-panel">
      <BrowserToolbar
        url={s.tabState.url}
        viewport={s.tabState.viewport}
        designMode={s.designMode}
        sending={s.sending}
        pendingNotes={s.pendingNotes}
        canOpenNewTab={s.ws !== null}
        onNavigate={s.navigate}
        onReload={s.reload}
        onSubmitUrl={s.goUrl}
        onViewportChange={(viewport) => updateBrowserTabState(s.projectId, props.browserId, { viewport })}
        onOpenNewTab={() => s.ws?.openBrowser({ newTab: true })}
        onToggleDesign={() => {
          s.setDesignMode((v) => !v);
          s.setDraft(null);
        }}
        onSelectPin={(note) =>
          s.setDraft({
            id: note.id,
            anchor: note.area ?? note.elements[0]?.rect ?? { x: 24, y: 24, width: 120, height: 40 },
            elements: note.elements,
            area: note.area,
            cssEdits: note.cssEdits ? [...note.cssEdits] : [],
            textEdit: note.textEdit,
            text: note.text,
            existingPin: note.pinNumber,
          })
        }
        onRemovePin={(id) => {
          const hit = s.pendingNotes.find((n) => n.id === id);
          if (hit?.cssEdits?.length) s.revertCss(hit.cssEdits);
          if (hit?.textEdit) s.revertText(hit.textEdit.selector, hit.textEdit.before);
          s.setPendingNotes((prev) => prev.filter((n) => n.id !== id).map((n, i) => ({ ...n, pinNumber: i + 1 })));
        }}
        onClearPins={() => {
          for (const n of s.pendingNotes) {
            if (n.cssEdits?.length) s.revertCss(n.cssEdits);
            if (n.textEdit) s.revertText(n.textEdit.selector, n.textEdit.before);
          }
          s.setPendingNotes([]);
        }}
        onSendBatch={() => {
          void s.sendNotesNow(s.pendingNotes).then(
            () => s.setPendingNotes([]),
            () => undefined,
          );
        }}
      />

      {s.designMode && s.tabState.url && (
        <DesignHintBar
          tool={s.tool}
          onToolChange={(next) => {
            s.setTool(next);
            if (next !== "select") s.setDraft(null);
          }}
          canUndo={s.strokes.length > 0}
          onUndo={() => s.setStrokes((cur) => cur.slice(0, -1))}
          batchEdits={s.tabState.batchEdits}
          onBatchEditsChange={(batchEdits) => updateBrowserTabState(s.projectId, props.browserId, { batchEdits })}
          onDone={() => {
            s.setDesignMode(false);
            s.setDraft(null);
            s.setStrokes([]);
          }}
        />
      )}

      {(s.frame.error || s.sendError) && (
        <div className="shrink-0 border-b border-line px-3 py-1.5">
          <Notice tone={s.sendError ? "error" : "warn"}>
            {s.sendError ?? `Preview proxy unavailable (${s.frame.error}). Loaded the page directly; cross-origin inspection may be limited.`}
          </Notice>
        </div>
      )}

      {!s.tabState.url ? (
        <EmptyState
          title="Open a local preview or web page"
          actions={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {s.detectedUrls.map((u) => (
                <Button key={u} variant="primary" size="sm" onClick={() => void s.goUrl(u)}>
                  {`Open ${u}`}
                </Button>
              ))}
              {!s.detectedUrls.includes("http://localhost:5173/") && (
                <Button variant={s.detectedUrls.length === 0 ? "primary" : "secondary"} size="sm" onClick={() => void s.goUrl("http://localhost:5173/")}>
                  Open localhost:5173
                </Button>
              )}
            </div>
          }
        >
          Enter a localhost port or URL above, then switch on Design to pick elements, edit copy, tweak CSS, or sketch markup for your session.
        </EmptyState>
      ) : (
        <div className={cn("relative flex min-h-0 flex-1 justify-center overflow-auto", vpWidth !== null && "bg-surface p-3")}>
          <div
            data-browser-stage
            style={vpWidth !== null ? { width: vpWidth, maxWidth: "100%" } : undefined}
            className={cn(
              "relative flex min-h-0 flex-1 flex-col bg-panel",
              vpWidth !== null && "flex-initial overflow-hidden rounded-lg border border-line shadow-float",
            )}
          >
            {(s.frame.src !== null || s.frame.srcdoc !== null) && (
              <iframe
                key={`${props.browserId}:${s.reloadTick}:${s.frame.src ?? "srcdoc"}`}
                ref={iframeRef}
                title={s.tabState.title || "Browser preview"}
                {...(s.frame.src !== null ? { src: s.frame.src } : {})}
                {...(s.frame.srcdoc !== null ? { srcDoc: s.frame.srcdoc } : {})}
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
                className="h-full w-full flex-1 border-0 bg-white"
              />
            )}

            {s.designMode && (
              <MarkupCanvas
                tool={s.tool}
                strokes={s.strokes}
                area={s.draft?.area ?? null}
                onAreaSelected={s.openAreaDraft}
                onAddStroke={(stroke) => {
                  const next = [...s.strokes, stroke];
                  s.setStrokes(next);
                  const bounds = boundsOfStrokes(next);
                  if (bounds && !s.draft) s.openAreaDraft(bounds);
                }}
              />
            )}

            {s.designMode && s.draft && (
              <NoteCard
                draft={s.draft}
                batchEdits={s.tabState.batchEdits}
                busy={s.sending || s.committing}
                containerRef={stageRef}
                onTextChange={(text) => s.setDraft((prev) => (prev ? { ...prev, text } : null))}
                onCssChange={(selector, property, before, after) => {
                  s.applyCss(selector, property, after);
                  s.setDraft((prev) => {
                    if (!prev) return null;
                    const others = prev.cssEdits.filter((c) => !(c.selector === selector && c.property === property));
                    if (after === null || after === before) return { ...prev, cssEdits: others };
                    return { ...prev, cssEdits: [...others, { selector, property, before, after }] };
                  });
                }}
                onStageToChat={() => void s.commitDraft("stage")}
                onSubmit={() => void s.commitDraft("submit")}
                onCancel={() => {
                  if (s.draft && !s.draft.existingPin) {
                    if (s.draft.cssEdits.length) s.revertCss(s.draft.cssEdits);
                    if (s.draft.textEdit) s.revertText(s.draft.textEdit.selector, s.draft.textEdit.before);
                  }
                  s.setDraft(null);
                }}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
