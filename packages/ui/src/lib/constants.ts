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

/**
 * Width floors of a dock group (decision 67). The conversation is never narrower than `CHAT_MIN_WIDTH`, lists (Agents,
 * Changes, Details, Review...) than `MIN_GROUP`, editors (a file) than `EDITOR_MIN_GROUP`. `state/workspace/floors.ts` picks
 * the floor of a group from its tabs; below the sum of the floors the dock shows one strip.
 */
export const MIN_GROUP = 280;
export const EDITOR_MIN_GROUP = 360;
export const CHAT_MIN_WIDTH = 420;
/** Gap between groups = the window gutter (also the divider's hit area). */
export const GROUP_GAP = 8;
/** Width a newly opened side group takes for a tool (Agents, Notes, Details). */
export const TOOL_WIDTH = 360;
/** The conversation's width when the first side group opens, until the user drags the divider (decision 60; owner: "chat too narrow"). */
export const CHAT_SPLIT_DEFAULT = 520;
/** A group holding a file or the Files tool is widened to at least this fraction of the row. */
export const FILE_GROUP_MIN_FRACTION = 0.45;
/** Largest fraction of the row a new tool group takes, and the fraction used before the row has been measured. */
export const TOOL_GROUP_MAX_FRACTION = 0.5;
export const TOOL_GROUP_UNMEASURED_FRACTION = 0.3;
/** Below this conversation width the composer's context bar folds folders and routing into a `…` menu (decision 30). */
export const CONTEXT_BAR_FOLD_BELOW = 420;

/* ---------- timings (ms) ---------- */

/** The live clock ticks this often while something runs, and once a minute otherwise. */
export const NOW_ACTIVE_MS = 1000;
export const CLOCK_IDLE_MS = 60_000;
/** Relative times in the sidebar, Home and Details refresh at these rates. */
export const CLOCK_SIDEBAR_MS = 30_000;
export const CLOCK_MINUTE_MS = 60_000;

/** Health check cadence while online (offline: the load retry's backoff, 1–30 s, `retryDelay`). */
export const HEALTH_POLL_ONLINE_MS = 15_000;
/**
 * A16: how long the polled project list may disagree with the event stream about a running turn before the stream is
 * reopened and the project re-read. Longer than a poll round trip after `turn.finished`, so an ordinary turn never trips it.
 */
export const SUMMARY_DISAGREE_MS = 4_000;
/** A9: a send still unanswered after this shows "Sending…" (a normal one answers in milliseconds and never shows it). */
export const SENDING_NOTICE_MS = 1_000;
/** Project list refresh: while any project runs, and otherwise. */
export const PROJECTS_POLL_BUSY_MS = 3_000;
export const PROJECTS_POLL_IDLE_MS = 12_000;

/** Debounce before a layout / tree-column preference is written. */
export const PERSIST_LAYOUT_MS = 250;
export const PERSIST_TREE_MS = 150;

/** Decision 98: a switch to a project not read yet keeps the previous screen this long before its loading state shows. */
export const SWITCH_HOLD_MS = 150;
/** "Copied" feedback stays this long. */
export const COPY_FEEDBACK_MS = 1400;
/** A loading indicator waits this long before showing, then stays at least `LOADING_MIN_SHOWN_MS`. */
export const LOADING_SHOW_AFTER_MS = 200;
/** The motion tokens of styles.css (`--motion-fast` / `--motion-base`) for the Web Animations API and exit timers. */
export const MOTION_FAST_MS = 100;
export const MOTION_BASE_MS = 150;
/** `--ease-out-quint`: every enter. */
export const EASE_OUT_QUINT = "cubic-bezier(0.2, 0, 0, 1)";
export const LOADING_MIN_SHOWN_MS = 300;
/** A request to focus the tree column is honoured by a column that mounts within this time. */
export const FOCUS_REQUEST_TTL_MS = 1000;
/** How long a jumped-to prompt keeps its flash outline. */
export const PROMPT_FLASH_MS = 1600;
