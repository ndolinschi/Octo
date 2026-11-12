import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { useHistoryAvailability } from "../../lib/history";
import { controlsPadding, useChrome } from "../../state/chrome";
import { useShell } from "../../state/shell";
import { IconButton } from "../primitives/Button";

/** The row's side padding when the host reserves nothing (the panels' 8px inset). */
const SIDE_PAD = 8;

/**
 * The title bar is the header (decision 54): one 40px row across the window. Left to right: the window controls' inset
 * (`chrome.insetStart`, the macOS traffic lights), the sidebar toggle (same place open or closed), back and forward, then
 * the open project's name and state (the project fills `start`), and at the far end its model chip, budget and actions
 * (`end`; see `TitleBarProject`). Empty areas carry `data-drag-region`, which the host maps to window dragging (this
 * package imports no platform API); controls are not drag regions. `data-title-bar` marks the row for tests and styles.
 *
 * `title`: a page that is not a project (Settings) names itself here.
 *
 * `alignStart`: the inline sidebar is open, so the first cluster is as wide as the sidebar and the project's name
 * starts where the content panel does.
 */
export function TitleBar(props: { alignStart: boolean; startRef(el: HTMLElement | null): void; endRef(el: HTMLElement | null): void; title?: string }) {
  const { sidebarOpen, toggleSidebar } = useShell();
  const { insetStart, insetEnd, controlsCenterY } = useChrome();
  const pad = controlsPadding(controlsCenterY);
  const history = useHistoryAvailability();
  const padStart = Math.max(SIDE_PAD, insetStart);
  return (
    <header
      data-title-bar
      data-drag-region
      aria-label="Window"
      className="@container/title relative z-10 flex h-bar shrink-0 items-center gap-2 bg-window text-sm text-fg"
      style={{ paddingInlineStart: padStart, paddingInlineEnd: Math.max(SIDE_PAD, insetEnd), paddingTop: pad.top, paddingBottom: pad.bottom }}
    >
      <div
        data-drag-region
        className="flex shrink-0 items-center gap-1"
        style={props.alignStart ? { minWidth: `calc(var(--spacing-sidebar) + var(--spacing-gutter) - ${padStart}px)` } : undefined}
      >
        {/* Settings replaces the sidebar with its own navigation: the toggle would act on a sidebar nobody sees. Hidden, not removed, so Back keeps its place. */}
        <IconButton
          icon={PanelLeft}
          label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-expanded={sidebarOpen}
          onClick={toggleSidebar}
          {...(props.title !== undefined ? { className: "invisible", tabIndex: -1 } : {})}
        />
        <IconButton icon={ArrowLeft} label="Back" onClick={() => window.history.back()} disabled={!history.back} />
        <IconButton icon={ArrowRight} label="Forward" onClick={() => window.history.forward()} disabled={!history.forward} />
      </div>
      <div ref={props.startRef} data-drag-region className="flex h-full min-w-0 flex-1 items-center gap-2">
        {props.title && <span className="min-w-0 truncate font-medium">{props.title}</span>}
      </div>
      <div ref={props.endRef} className="flex shrink-0 items-center gap-3" />
    </header>
  );
}
