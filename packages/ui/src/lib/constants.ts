/**
 * Named breakpoints, timings and layout sizes that more than one place reads, or that would otherwise be a bare number
 * in a component. A value used by exactly one module and explained there may stay local.
 */

/* ---------- breakpoints (px of the window) ---------- */

/** From this width up the dock may show several groups side by side; below it, one strip. */
export const DOCK_MIN_WIDTH = 1100;
/** Below this width the sidebar is a drawer. `styles.css` mirrors it as `--breakpoint-drawer` (`max-drawer:` variant); a test keeps the two equal. */
export const DRAWER_BELOW = 1000;
export const DOCKED_QUERY = `(min-width: ${DOCK_MIN_WIDTH}px)`;
export const DRAWER_QUERY = `(max-width: ${DRAWER_BELOW - 1}px)`;

/* ---------- layout sizes (px unless noted) ---------- */

/** Narrowest a dock group may get; below the sum of these the dock shows one strip. */
export const MIN_GROUP = 280;
/** Gap between groups = the window gutter (also the divider's hit area). */
export const GROUP_GAP = 8;
/** Width a newly opened side group takes for a tool (Agents, Notes, Details). */
export const TOOL_WIDTH = 360;
/** The conversation's width when the first side group opens, until the user drags the divider (decision 60). */
export const CHAT_SPLIT_DEFAULT = 420;
/** A group holding a file or the Files tool is widened to at least this fraction of the row. */
export const FILE_GROUP_MIN_FRACTION = 0.45;
/** Largest fraction of the row a new tool group takes, and the fraction used before the row has been measured. */
export const TOOL_GROUP_MAX_FRACTION = 0.5;
export const TOOL_GROUP_UNMEASURED_FRACTION = 0.3;
/** A file view narrower than this floats its tree over the editor instead of giving it a column. */
export const FILE_VIEW_OVERLAY_BELOW = 560;
/** A tree column that would leave the editor narrower than this floats over it instead (closed by default). */
export const EDITOR_MIN_WIDTH = 480;
/** Below this conversation width the composer's context bar folds folders and routing into a `…` menu (decision 30). */
export const CONTEXT_BAR_FOLD_BELOW = 420;

/* ---------- timings (ms) ---------- */

/** The live clock ticks this often while something runs, and once a minute otherwise. */
export const NOW_ACTIVE_MS = 1000;
export const CLOCK_IDLE_MS = 60_000;
/** Relative times in the sidebar, Home and Details refresh at these rates. */
export const CLOCK_SIDEBAR_MS = 30_000;
export const CLOCK_MINUTE_MS = 60_000;

/** Health check cadence: while online, and while offline or checking. */
export const HEALTH_POLL_ONLINE_MS = 15_000;
export const HEALTH_POLL_OFFLINE_MS = 5_000;
/** Project list refresh: while any project runs, and otherwise. */
export const PROJECTS_POLL_BUSY_MS = 3_000;
export const PROJECTS_POLL_IDLE_MS = 12_000;

/** Debounce before a layout / tree-column preference is written. */
export const PERSIST_LAYOUT_MS = 250;
export const PERSIST_TREE_MS = 150;

/** "Copied" feedback stays this long. */
export const COPY_FEEDBACK_MS = 1400;
/** A loading indicator waits this long before showing, then stays at least `LOADING_MIN_SHOWN_MS`. */
export const LOADING_SHOW_AFTER_MS = 200;
export const LOADING_MIN_SHOWN_MS = 300;
/** A request to focus the tree column is honoured by a column that mounts within this time. */
export const FOCUS_REQUEST_TTL_MS = 1000;
/** How long a jumped-to prompt keeps its flash outline. */
export const PROMPT_FLASH_MS = 1600;
