import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { useHistoryAvailability } from "../../lib/history";
import { controlsPadding, controlsWidth, SIDE_PAD, useChrome } from "../../state/chrome";
import { useShell } from "../../state/shell";
import { IconButton } from "../primitives/Button";

/**
 * The window's top row (decisions 54 and 67), 40px across the window. The tab strips of the open project's groups ARE this row
 * (`dock/TabStrip`); this component is what is always there: the window controls' inset (`chrome.insetStart`, the macOS traffic
 * lights), the sidebar toggle (same place open or closed), back and forward, floating over the window's top-left corner, and a
 * drag strip behind everything for the screens that have no tab strip (Home, Settings). `title`: a page that is not a project
 * (Settings) names itself right after the controls. Empty areas carry `data-drag-region`, which the host maps to window dragging
 * (this package imports no platform API); controls are not drag regions.
 */
export function TitleBar(props: { title?: string }) {
  const { sidebarOpen, toggleSidebar } = useShell();
  const { insetStart, controlsCenterY } = useChrome();
  const pad = controlsPadding(controlsCenterY);
  const history = useHistoryAvailability();
  const padStart = Math.max(SIDE_PAD, insetStart);
  return (
    <>
      <div data-title-bar data-drag-region aria-hidden className="absolute inset-x-0 top-0 z-0 h-bar" />
      <header
        aria-label="Window"
        data-drag-region
        className="pointer-events-none absolute top-0 left-0 z-20 flex h-bar items-center gap-2 text-sm text-fg"
        style={{ paddingInlineStart: padStart, paddingTop: pad.top, paddingBottom: pad.bottom }}
      >
        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
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
        {props.title && (
          <span className="pointer-events-none ml-2 truncate font-medium" style={{ maxWidth: `calc(100vw - ${controlsWidth(insetStart)}px)` }}>
            {props.title}
          </span>
        )}
      </header>
    </>
  );
}
