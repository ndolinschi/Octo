import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { useHistoryAvailability } from "../../lib/history";
import { controlsPadding, controlsWidth, SIDE_PAD, useChrome } from "../../state/chrome";
import { useShell } from "../../state/shell";
import { IconButton } from "../primitives/Button";
import { cn } from "../../lib/cn";
import { DRAWER_QUERY } from "../../lib/constants";
import { useMediaQuery } from "../../lib/hooks";

/** The sidebar's glyph column: its rows' leading glyph starts 24px from the window's edge. */
const GLYPH_COLUMN = 24;

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
  // Polish step 2 (F3): with no system controls at the corner the sidebar toggle's icon sits on the sidebar's glyph column
  // (gutter 8 + pane 8 + row inset 8 = 24; the 28px button's 16px icon is 6px in), and the three buttons touch, so the cluster
  // still ends inside `controlsWidth` (18 + 3 × 28 = 102 ≤ 108). Beside the macOS traffic lights nothing moves.
  // In drawer mode there is no sidebar column to align with (the drawer opens over the first strip): nothing moves there.
  const drawer = useMediaQuery(DRAWER_QUERY);
  const aligned = insetStart <= SIDE_PAD && !drawer;
  // 16 + the cluster's 2px margin (both on the spacing scale) = 18: the toggle's 16px icon starts at 24.
  const padStart = aligned ? GLYPH_COLUMN - 8 : Math.max(SIDE_PAD, insetStart);
  return (
    <>
      <div data-title-bar data-drag-region aria-hidden className="absolute inset-x-0 top-0 z-0 h-bar" />
      <header
        aria-label="Window"
        data-drag-region
        className="pointer-events-none absolute top-0 left-0 z-20 flex h-bar items-center gap-2 text-sm text-fg"
        style={{ paddingInlineStart: padStart, paddingTop: pad.top, paddingBottom: pad.bottom }}
      >
        <div className={cn("pointer-events-auto flex shrink-0 items-center", aligned ? "ml-0.5" : "gap-1")}>
          {/* Settings replaces the sidebar with its own navigation: the toggle would act on a sidebar nobody sees. Hidden, not removed, so Back keeps its place. */}
          <IconButton
            icon={PanelLeft}
            label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
            {...(props.title !== undefined ? { className: "invisible", tabIndex: -1 } : {})}
          />
          <IconButton icon={ArrowLeft} label="Previous page" onClick={() => window.history.back()} disabled={!history.back} />
          <IconButton icon={ArrowRight} label="Next page" onClick={() => window.history.forward()} disabled={!history.forward} />
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
